/**
 * `GET /api/repo-graph/arch/trust` (Task 6, spec §5). Fixture isolation
 * copied from `tests/daemon/repo-graph.test.ts` (temp home + temp project
 * root, both scrapped in `afterEach`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph";
import { type ArchModelMeta, writeArchModel } from "../../src/explain/arch-cache";
import type { ArchModelDoc } from "../../src/explain/arch-model-schema";
import { resolveRepoGraphLocation } from "../../src/repo-graph/proj-hash";
import { writeFingerprints, writeGraph, writeMeta, writeQueryIndex } from "../../src/repo-graph/store";
import { emptyCounters, emptyFingerprints, emptyQueryIndex, type RepoGraph, type RepoGraphMeta } from "../../src/repo-graph/types";

let cwd: string;
let home: string;

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), "siltpoke-trust-route-"));
  cwd = join(tmp, "proj");
  home = join(tmp, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(join(cwd, ".."), { recursive: true, force: true });
});

function makeApp(): Hono {
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd, home });
  return app;
}

// cli/a.ts imports brain/b.ts (a real import pair, resolved) — util/c.ts is
// wired to nothing by import, so an edge touching it can only be evidenced by
// citation. Three subdirs in degraded mode (no CLAUDE.md): cli, brain, util.
function seedGraph(): RepoGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "file:src/cli/a.ts:", type: "file", name: "a.ts", path: "src/cli/a.ts", lineRange: [1, 5] },
      { id: "file:src/brain/b.ts:", type: "file", name: "b.ts", path: "src/brain/b.ts", lineRange: [1, 5] },
      { id: "file:src/util/c.ts:", type: "file", name: "c.ts", path: "src/util/c.ts", lineRange: [1, 5] },
    ],
    edges: [
      { id: "file:src/cli/a.ts:::imports::../brain/b", source: "file:src/cli/a.ts:", target: "../brain/b", type: "imports", weight: 1 },
    ],
  };
}

async function seed(): Promise<void> {
  const { storage_dir, project_root, proj_hash } = resolveRepoGraphLocation(cwd, { home });
  await writeGraph(storage_dir, seedGraph());
  await writeQueryIndex(storage_dir, emptyQueryIndex());
  await writeFingerprints(storage_dir, emptyFingerprints());
  const meta: RepoGraphMeta = {
    schemaVersion: 1,
    project_root,
    proj_hash,
    last_indexed_ts: "2026-09-20T10:00:00.000Z",
    build_duration_ms: 10,
    counters: emptyCounters(),
  };
  await writeMeta(storage_dir, meta);
}

interface TrustResponse {
  success: boolean;
  error: string | null;
  data?: {
    schema: 1;
    source: string;
    stamp: { mapDate: string; commit: string | null; commitsAhead: number | null; headRelation: string };
    containers: Array<{ id: string; title: string; desc: string; listedFiles: string[] }>;
    edges: Array<{ source: string; target: string; solid: boolean; evidence: { kind: string; reason?: string } }>;
    stampLine: string;
    farBehind: boolean;
  };
}

async function trust(app: Hono, qs: string): Promise<{ status: number; body: TrustResponse; text: string }> {
  const res = await app.fetch(new Request(`http://localhost/api/repo-graph/arch/trust${qs}`));
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as TrustResponse, text };
}

/** Fix round 1, "cheap" ask: no response — for ANY source — ever contains
 * the temp project's absolute root or the temp home/storage dir. */
function expectNoRootLeak(text: string): void {
  expect(text).not.toContain(cwd);
  expect(text).not.toContain(home);
}

describe("GET /api/repo-graph/arch/trust — bad input", () => {
  test("400 on an unknown source", async () => {
    await seed();
    const { status, body } = await trust(makeApp(), "?source=bogus");
    expect(status).toBe(400);
    expect(body).toEqual({ success: false, error: "bad source", data: undefined } as unknown as TrustResponse);
  });
});

describe("GET /api/repo-graph/arch/trust — source=subset", () => {
  test("200, every edge solid, no-git stamp for a non-git temp project", async () => {
    await seed();
    const { status, body, text } = await trust(makeApp(), "?source=subset");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.source).toBe("subset");
    expect(body.data?.stamp.headRelation).toBe("no-git");
    expect(body.data?.edges.length).toBeGreaterThan(0);
    for (const e of body.data?.edges ?? []) expect(e.solid).toBe(true);
    expectNoRootLeak(text);
  });

  test("a reindex that bumps meta.last_indexed_ts without changing graph content updates subset's stamp.mapDate", async () => {
    await seed();
    const app = makeApp();
    const before = await trust(app, "?source=subset");
    expect(before.body.data?.stamp.mapDate).toBe("2026-09-20T10:00:00.000Z");

    const { storage_dir, project_root, proj_hash } = resolveRepoGraphLocation(cwd, { home });
    await writeMeta(storage_dir, {
      schemaVersion: 1,
      project_root,
      proj_hash,
      last_indexed_ts: "2026-09-25T00:00:00.000Z", // content-identical reindex, new timestamp only
      build_duration_ms: 10,
      counters: emptyCounters(),
    });

    const after = await trust(app, "?source=subset");
    expect(after.body.data?.stamp.mapDate).toBe("2026-09-25T00:00:00.000Z");
  });

  test("editing the CLAUDE.md §Architecture overlay changes the subset result on the next request (no reindex needed)", async () => {
    await seed();
    const app = makeApp();
    const before = await trust(app, "?source=subset");
    const cliBefore = before.body.data?.containers.find((c) => c.id === "cli");
    expect(cliBefore?.desc ?? "").not.toContain("OVERLAY-PURPOSE-MARKER");

    writeFileSync(
      join(cwd, "CLAUDE.md"),
      ["# Fixture", "", "## Architecture", "", "**Core**", "- `src/cli/` — OVERLAY-PURPOSE-MARKER", "- `src/brain/` — brain purpose", "- `src/util/` — util purpose", ""].join(
        "\n",
      ),
    );

    const after = await trust(app, "?source=subset");
    const cliAfter = after.body.data?.containers.find((c) => c.id === "cli");
    expect(cliAfter?.desc).toContain("OVERLAY-PURPOSE-MARKER");
  });
});

const EV = [{ file: "docs/NOTES.md", line: 1 }];
function archDoc(): ArchModelDoc {
  return {
    boundary: "demo",
    bands: [{ id: "core", label: { value: "Core", evidence: EV }, order: 0, members: ["cli", "brain", "util"] }],
    nodes: [
      { id: "cli", kind: "cont", title: { value: "CLI", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "cli", members: ["src/cli/a.ts"] },
      { id: "brain", kind: "cont", title: { value: "Brain", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "brain", members: ["src/brain/b.ts"] },
      { id: "util", kind: "cont", title: { value: "Util", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "util", members: ["src/util/c.ts"] },
    ],
    // cli→util has NO import edge in the graph — its only possible evidence
    // is the citation, so this edge exercises the citation re-check path.
    edges: [{ source: "cli", target: "util", verb: { value: "formats", evidence: EV, tier: "cited" } }],
  };
}
function seedModel(metaOverrides: Partial<ArchModelMeta> = {}, doc: ArchModelDoc = archDoc()): void {
  const { storage_dir } = resolveRepoGraphLocation(cwd, { home });
  mkdirSync(storage_dir, { recursive: true });
  const meta: ArchModelMeta = {
    schemaVersion: 1,
    fingerprint: "fp-test",
    graphIndexedTs: "2026-09-20T10:00:00.000Z",
    costUsd: 0,
    groundedPct: 100,
    model: "sonnet",
    generatedTs: "2026-09-21T00:00:00.000Z",
    ...metaOverrides,
  };
  writeArchModel(storage_dir, doc, meta, new Set(["cli", "brain", "util"]));
}
function writeCitedFile(): void {
  mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(join(cwd, "docs/NOTES.md"), "line one\nline two\n");
}

describe("GET /api/repo-graph/arch/trust — source=generated", () => {
  test("404 no_map when no arch cache exists", async () => {
    await seed();
    const { status, body } = await trust(makeApp(), "?source=generated");
    expect(status).toBe(404);
    expect(body.error).toBe("no_map");
  });

  test("200 with a cache; listedFiles is [] by default, non-empty with &appendix=1", async () => {
    await seed();
    seedModel();
    writeCitedFile();
    const app = makeApp();
    const plain = await trust(app, "?source=generated");
    expect(plain.status).toBe(200);
    expect(plain.body.data?.containers[0]?.listedFiles).toEqual([]);
    const appendix = await trust(app, "?source=generated&appendix=1");
    expect(appendix.status).toBe(200);
    expect(appendix.body.data?.containers[0]?.listedFiles.length).toBeGreaterThan(0);
  });

  test("a cited edge whose file exists is solid; deleting the file and re-requesting (no wait) goes dashed citation-stale", async () => {
    await seed();
    seedModel();
    writeCitedFile();
    const app = makeApp();
    const before = await trust(app, "?source=generated");
    const edgeBefore = before.body.data?.edges.find((e) => e.source === "cli" && e.target === "util");
    expect(edgeBefore?.solid).toBe(true);
    expect(edgeBefore?.evidence.kind).toBe("cited");

    unlinkSync(join(cwd, "docs/NOTES.md"));
    const after = await trust(app, "?source=generated");
    const edgeAfter = after.body.data?.edges.find((e) => e.source === "cli" && e.target === "util");
    expect(edgeAfter?.solid).toBe(false);
    expect(edgeAfter?.evidence.kind).toBe("none");
    expect(edgeAfter?.evidence.reason).toBe("citation-stale");
  });

});

describe("GET /api/repo-graph/arch/trust — source=generated (privacy + cache)", () => {
  test("response contains no project_root string (privacy)", async () => {
    await seed();
    seedModel();
    writeCitedFile();
    const { text } = await trust(makeApp(), "?source=generated&appendix=1");
    expectNoRootLeak(text);
  });

  test("a forced regenerate at the SAME fingerprint invalidates the cache (generatedTs + content both move)", async () => {
    await seed();
    seedModel();
    const app = makeApp();
    const first = await trust(app, "?source=generated");
    expect(first.status).toBe(200);
    expect(first.body.data?.stamp.mapDate).toBe("2026-09-21T00:00:00.000Z");
    expect(first.body.data?.containers.find((c) => c.id === "cli")?.title).toBe("CLI");

    // A `POST /arch/generate?force=true` re-run that lands on an UNCHANGED repo
    // writes the SAME `meta.fingerprint` (it's `computeRepoFingerprint(fingerprints)`,
    // same graph) but a new `generatedTs` and (in general) new model content.
    const regeneratedDoc = archDoc();
    regeneratedDoc.nodes = regeneratedDoc.nodes.map((n) => (n.id === "cli" ? { ...n, title: { ...n.title, value: "Renamed CLI" } } : n));
    seedModel({ generatedTs: "2026-09-22T00:00:00.000Z" }, regeneratedDoc);

    const second = await trust(app, "?source=generated");
    expect(second.status).toBe(200);
    expect(second.body.data?.stamp.mapDate).toBe("2026-09-22T00:00:00.000Z");
    expect(second.body.data?.containers.find((c) => c.id === "cli")?.title).toBe("Renamed CLI");
  });
});

function git(dir: string, ...a: string[]): string {
  return execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
}
function initGitProject(): void {
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "t@t");
  git(cwd, "config", "user.name", "t");
  git(cwd, "config", "commit.gpgsign", "false");
  // Give the repo a HEAD unrelated to arch-c4.json, so "never committed"
  // (below) still resolves to a real HEAD (git-repo, not no-git).
  writeFileSync(join(cwd, "README.md"), "seed\n");
  git(cwd, "add", "README.md");
  git(cwd, "commit", "-qm", "seed");
}
const AUTHORED = {
  schemaVersion: 1,
  N: {
    cli: { kind: "cont", title: "CLI", x: 0, y: 0, w: 100, h: 60, drillTo: "cli" },
    brain: { kind: "cont", title: "Brain", x: 0, y: 80, w: 100, h: 60, drillTo: "brain" },
  },
  E: [["cli", "brain", "calls"]],
  BANDS: [{ x: 0, y: 0, w: 200, h: 160, label: "core", color: "#000", lc: "#000", note: "" }],
  BOUNDARY: { x: 0, y: 0, w: 200, h: 160, label: "demo" },
  GROUP_ACCENT: { sky: "#1", terra: "#2", moss: "#3", amber: "#4" },
};
function writeAuthoredFile(): void {
  mkdirSync(join(cwd, ".siltpoke"), { recursive: true });
  writeFileSync(join(cwd, ".siltpoke/arch-c4.json"), JSON.stringify(AUTHORED));
}

describe("GET /api/repo-graph/arch/trust — source=authored", () => {
  test("404 when no .siltpoke/arch-c4.json exists", async () => {
    await seed();
    const { status, body } = await trust(makeApp(), "?source=authored");
    expect(status).toBe(404);
    expect(body.error).toBe("no_map");
  });

  test("committed file: stamp.commit is that commit's SHA, stampLine contains its short form; a later uncommitted edit still reports it", async () => {
    await seed();
    initGitProject();
    writeAuthoredFile();
    git(cwd, "add", "-f", ".siltpoke/arch-c4.json");
    git(cwd, "commit", "-qm", "add arch-c4");
    const commitSha = git(cwd, "rev-parse", "HEAD");

    const app = makeApp();
    const first = await trust(app, "?source=authored");
    expect(first.status).toBe(200);
    expect(first.body.data?.stamp.commit).toBe(commitSha);
    expect(first.body.data?.stampLine).toContain(commitSha.slice(0, 7));
    expectNoRootLeak(first.text);
    expect(first.body.data?.containers.some((c) => c.id === "extra")).toBe(false);

    // Modify the file on disk WITHOUT committing, ADDING a new node — the
    // last commit touching the file hasn't changed, so the stamp must not
    // move, but the LIVE content (an uncommitted edit) must still be seen:
    // the authored file is read fresh on every cache miss, and the mtime-based
    // cache key (fix round 1) must treat this edit as a miss.
    writeFileSync(join(cwd, ".siltpoke/arch-c4.json"), JSON.stringify({ ...AUTHORED, N: { ...AUTHORED.N, extra: AUTHORED.N.cli } }));
    const second = await trust(app, "?source=authored");
    expect(second.status).toBe(200);
    expect(second.body.data?.stamp.commit).toBe(commitSha);
    expect(second.body.data?.containers.some((c) => c.id === "extra")).toBe(true);
  });

});

describe("GET /api/repo-graph/arch/trust — source=authored (uncommitted)", () => {
  test("never-committed file: not-recorded relation, null commit, the authored-specific stampLine wording", async () => {
    await seed();
    initGitProject(); // HEAD exists (README commit) but arch-c4.json is untracked
    writeAuthoredFile();
    const { status, body, text } = await trust(makeApp(), "?source=authored");
    expect(status).toBe(200);
    expect(body.data?.stamp.headRelation).toBe("not-recorded");
    expect(body.data?.stamp.commit).toBeNull();
    expect(body.data?.stampLine).toMatch(/^Map from \d{4}-\d{2}-\d{2} · file not committed — commit it to record its version$/);
    expectNoRootLeak(text);
  });
});

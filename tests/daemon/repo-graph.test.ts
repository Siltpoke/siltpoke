/**
 * Hono daemon repo-graph routes tests (data-contract shapes).
 * All routes are read-only + unauthenticated (P0 fix); Bearer headers ignored.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph";
import {
  writeFingerprints,
  writeGraph,
  writeMeta,
  writeQueryIndex,
} from "../../src/repo-graph/store";
import { resolveRepoGraphLocation } from "../../src/repo-graph/proj-hash";
import { cacheKey, writeExplanation } from "../../src/explain/store";
import { EXPLANATION_SCHEMA_VERSION } from "../../src/explain/types";
import {
  emptyCounters,
  emptyFingerprints,
  emptyGraph,
  emptyQueryIndex,
  type RepoGraph,
  type RepoGraphMeta,
  type QueryIndex,
  type SiltpokeGraphNode,
} from "../../src/repo-graph/types";
import { writeArchModel, type ArchModelMeta } from "../../src/explain/arch-cache";
import type { ArchModelDoc } from "../../src/explain/arch-model-schema";

let cwd: string;
let home: string;

const SECRET = "test-secret";

// Detached: generate/explain return {taskId} 202; the run records AFTER —
// poll the registry (tasks.json) for the terminal state.
function taskStatus(): string | undefined {
  const p = join(home, "tasks.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Array<{ status: string; costUsd: number | null }>)[0]?.status : undefined;
}
function taskRecord(): { status: string; costUsd: number | null } {
  return (JSON.parse(readFileSync(join(home, "tasks.json"), "utf8")) as Array<{ status: string; costUsd: number | null }>)[0]!;
}
async function pollTerminal(timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (taskStatus() === "running" || taskStatus() === undefined) {
    if (Date.now() - start > timeoutMs) throw new Error("pollTerminal timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function archModelCached(): boolean {
  const { storage_dir } = resolveRepoGraphLocation(cwd, { home });
  return existsSync(join(storage_dir, "arch-model.json"));
}

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), "siltpoke-daemon-repograph-"));
  cwd = join(tmp, "proj");
  home = join(tmp, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function seedGraph(
  graph: RepoGraph,
  opts: { queryIndex?: QueryIndex; counters?: Partial<RepoGraphMeta["counters"]["nodes"]> } = {},
): Promise<void> {
  const { storage_dir, project_root, proj_hash } = resolveRepoGraphLocation(cwd, { home });
  await writeGraph(storage_dir, graph);
  await writeQueryIndex(storage_dir, opts.queryIndex ?? emptyQueryIndex());
  await writeFingerprints(storage_dir, emptyFingerprints());
  const counters = emptyCounters();
  if (opts.counters) Object.assign(counters.nodes, opts.counters);
  const meta: RepoGraphMeta = {
    schemaVersion: 1,
    project_root,
    proj_hash,
    last_indexed_ts: "2026-05-28T10:00:00.000Z",
    build_duration_ms: 100,
    counters,
  };
  await writeMeta(storage_dir, meta);
}

interface SeedNode {
  id: string;
  type: SiltpokeGraphNode["type"];
  name: string;
  path: string;
  signature?: string;
  lineRange?: [number, number];
}

function makeGraphWith(entries: SeedNode[], imports: Array<[string, string]> = []): RepoGraph {
  const g = emptyGraph();
  for (const e of entries) {
    g.nodes.push({
      id: e.id,
      type: e.type,
      name: e.name,
      path: e.path,
      lineRange: e.lineRange ?? [1, 10],
      signature: e.signature,
    });
  }
  for (const [src, imp] of imports) {
    g.edges.push({
      id: `file:${src}:::imports::${imp}`,
      source: `file:${src}:`,
      target: imp,
      type: "imports",
      weight: 1,
    });
  }
  return g;
}

function makeApp(): Hono {
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd, home, secret: SECRET });
  return app;
}

describe("GET /api/repo-graph/repos", () => {
  test("200 returns RepoSummary list with state + stats for the cwd repo", async () => {
    await seedGraph(makeGraphWith([{ id: "file:src/x.ts:", type: "file", name: "x.ts", path: "src/x.ts" }]), {
      counters: { file: 1, function: 3 },
    });
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/repos"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { repos: Array<{ id: string; state: string; files: number; symbols: number }> };
    };
    expect(body.data.repos.length).toBeGreaterThanOrEqual(1);
    const me = body.data.repos.find((r) => r.id.match(/^[0-9a-f]{12}$/));
    expect(me?.state).toBe("ready");
    expect(me?.files).toBe(1);
    expect(me?.symbols).toBe(3);
  });
});

describe("GET /api/repo-graph/arch", () => {
  test("200 returns ArchitectureProjection (degraded mode, no CLAUDE.md)", async () => {
    await seedGraph(
      makeGraphWith(
        [
          { id: "file:src/cli/a.ts:", type: "file", name: "a.ts", path: "src/cli/a.ts" },
          { id: "file:src/brain/b.ts:", type: "file", name: "b.ts", path: "src/brain/b.ts" },
        ],
        [["src/cli/a.ts", "../brain/b"]],
      ),
    );
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/arch"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        repo: { files: number };
        groups: Array<{ id: string }>;
        subdirs: Array<{ id: string }>;
        edges: Array<{ source: string; target: string; weight: number }>;
      };
    };
    const subIds = body.data.subdirs.map((s) => s.id).sort();
    expect(subIds).toEqual(["brain", "cli"]);
    expect(body.data.edges).toContainEqual({ source: "cli", target: "brain", weight: 1 });
  });

  test("404 when repo not indexed (unknown ?repo)", async () => {
    await seedGraph(emptyGraph());
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/repo-graph/arch?repo=ffffffffffff"),
    );
    expect(res.status).toBe(404);
  });
});

describe("architecture-view generate", () => {
  function archGraph(): RepoGraph {
    return makeGraphWith(
      [
        { id: "file:src/cli/a.ts:", type: "file", name: "a.ts", path: "src/cli/a.ts" },
        { id: "file:src/brain/b.ts:", type: "file", name: "b.ts", path: "src/brain/b.ts" },
      ],
      [["src/cli/a.ts", "../brain/b"]],
    );
  }
  const EV = [{ file: "src/cli/a.ts", line: 1 }];
  const VALID = {
    boundary: "demo",
    bands: [{ id: "core", label: { value: "Core", evidence: EV }, order: 0, members: ["cli", "brain"] }],
    nodes: [
      { id: "cli", kind: "cont", title: { value: "CLI", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "cli" },
      { id: "brain", kind: "cont", title: { value: "Brain", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "brain" },
    ],
    edges: [{ source: "cli", target: "brain", verb: { value: "uses", evidence: EV } }],
  };
  function appWithBrain(markdown: string): Hono {
    const app = new Hono();
    mountRepoGraphRoutes(app, {
      cwd,
      home,
      secret: SECRET,
      archBrainProvider: async () => ({
        markdown,
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 100, output_tokens: 50, total_cost_usd: 0.4 },
      }),
    });
    return app;
  }

  test("GET /arch/estimate returns a cost estimate (no Brain)", async () => {
    await seedGraph(archGraph());
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/arch/estimate"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { estUsd: number; model: string; mayTruncate: boolean } };
    expect(body.data.estUsd).toBeGreaterThan(0);
    expect(body.data.model).toBe("sonnet");
    // The advisory truncation flag is part of the estimate envelope.
    // This tiny graph fits the budget comfortably → no warning (no false nag).
    expect(body.data.mayTruncate).toBe(false);
  });

  test("POST /arch/generate without secret → 401", async () => {
    await seedGraph(archGraph());
    const app = appWithBrain(JSON.stringify(VALID));
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/arch/generate", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  test("POST /arch/generate with secret → 202 {taskId}; detached run grounds + caches the model + records cost", async () => {
    await seedGraph(archGraph());
    const app = appWithBrain(JSON.stringify(VALID));
    const res = await app.fetch(
      new Request("http://localhost/api/repo-graph/arch/generate", {
        method: "POST",
        headers: { "X-Siltpoke-Secret": SECRET, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { taskId: string; status: string };
    expect(body.taskId).toBeTruthy();
    expect(body.status).toBe("running");
    await pollTerminal();
    // the model is delivered via the result-cache (reconnect reads it), not the response
    expect(taskRecord().status).toBe("done");
    expect(taskRecord().costUsd).toBe(0.4);
    expect(archModelCached()).toBe(true);
  });

  test("POST /arch/generate with a malformed model → 202; detached run records done+cost but caches NO model", async () => {
    await seedGraph(archGraph());
    const app = appWithBrain("not json at all");
    const res = await app.fetch(
      new Request("http://localhost/api/repo-graph/arch/generate", {
        method: "POST",
        headers: { "X-Siltpoke-Secret": SECRET, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(202);
    await pollTerminal();
    // lifecycle done (Brain ran + billed) but the rejected output was NOT cached
    expect(taskRecord().status).toBe("done");
    expect(taskRecord().costUsd).toBe(0.4); // billed-but-rejected still records (log anything that costs money)
    expect(archModelCached()).toBe(false);
  });

  // ── grounding counts — GET /arch/model route ──────────────────
  const ARCH_EV = [{ file: "src/cli/a.ts", line: 1 }];
  const ARCH_DOC: ArchModelDoc = {
    boundary: "demo",
    bands: [{ id: "core", label: { value: "Core", evidence: ARCH_EV }, order: 0, members: ["cli", "brain"] }],
    nodes: [
      { id: "cli", kind: "cont", title: { value: "CLI", evidence: ARCH_EV }, band: { value: "core", evidence: ARCH_EV }, drillTo: "cli" },
      { id: "brain", kind: "cont", title: { value: "Brain", evidence: ARCH_EV }, band: { value: "core", evidence: ARCH_EV }, drillTo: "brain" },
    ],
    edges: [{ source: "cli", target: "brain", verb: { value: "uses", evidence: ARCH_EV } }],
  };

  function seedCachedModel(metaOver: Partial<ArchModelMeta> = {}): void {
    const { storage_dir } = resolveRepoGraphLocation(cwd, { home });
    mkdirSync(storage_dir, { recursive: true });
    const meta: ArchModelMeta = {
      schemaVersion: 1,
      fingerprint: "fp-test",
      graphIndexedTs: "2026-06-12T00:00:00Z",
      costUsd: 0.3,
      groundedPct: 78,
      model: "sonnet",
      generatedTs: "2026-06-12T00:00:00Z",
      ...metaOver,
    };
    writeArchModel(storage_dir, ARCH_DOC, meta, new Set(["cli", "brain"]));
  }

  test("GET /arch/model — response includes citedClaims/totalClaims/topologyBlindClaims when meta has them", async () => {
    await seedGraph(archGraph());
    seedCachedModel({ citedClaims: 29, totalClaims: 37, topologyBlindClaims: 2 });
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/arch/model"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { citedClaims?: number; totalClaims?: number; topologyBlindClaims?: number; groundedPct: number };
    };
    // all 3 grounding counts present in response.
    expect(body.data.citedClaims).toBe(29);
    expect(body.data.totalClaims).toBe(37);
    expect(body.data.topologyBlindClaims).toBe(2);
  });

  test("GET /arch/model — legacy meta WITHOUT counts → fields absent in response, never 0 (honesty rule)", async () => {
    await seedGraph(archGraph());
    seedCachedModel({}); // no citedClaims/totalClaims/topologyBlindClaims
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/arch/model"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { citedClaims?: number; totalClaims?: number; topologyBlindClaims?: number };
    };
    // fields ABSENT (undefined/missing), never fabricated 0.
    expect(body.data.citedClaims).toBeUndefined();
    expect(body.data.totalClaims).toBeUndefined();
    expect(body.data.topologyBlindClaims).toBeUndefined();
  });
});

describe("GET /api/repo-graph/files", () => {
  test("200 returns FileLevel: files + subdir meta + neighbors", async () => {
    await seedGraph(
      makeGraphWith(
        [
          { id: "file:src/cli/doctor.ts:", type: "file", name: "doctor.ts", path: "src/cli/doctor.ts" },
          { id: "file:src/cli/explain.ts:", type: "file", name: "explain.ts", path: "src/cli/explain.ts" },
          { id: "file:src/brain/b.ts:", type: "file", name: "b.ts", path: "src/brain/b.ts" },
          { id: "function:src/cli/doctor.ts:runDoctor", type: "function", name: "runDoctor", path: "src/cli/doctor.ts" },
        ],
        [["src/cli/doctor.ts", "../brain/b"]],
      ),
    );
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/files?subdir=src/cli/"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        subdir: { id: string; files: number };
        files: Array<{ path: string; symbols: number; explainState: string }>;
        neighbors: { outbound: Array<{ id: string; weight: number }> };
      };
    };
    expect(body.data.subdir.id).toBe("cli");
    const paths = body.data.files.map((f) => f.path).sort();
    expect(paths).toEqual(["src/cli/doctor.ts", "src/cli/explain.ts"]);
    expect(body.data.files.find((f) => f.path === "src/cli/doctor.ts")?.symbols).toBe(1);
    expect(body.data.files[0]!.explainState).toBe("none");
    expect(body.data.neighbors.outbound).toContainEqual({ id: "brain", weight: 1 });
  });

  test("auto-appends trailing slash so src/cli does not match src/client/", async () => {
    await seedGraph(
      makeGraphWith([
        { id: "file:src/cli/doctor.ts:", type: "file", name: "doctor.ts", path: "src/cli/doctor.ts" },
        { id: "file:src/client/types.ts:", type: "file", name: "types.ts", path: "src/client/types.ts" },
      ]),
    );
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/files?subdir=src/cli"));
    const body = (await res.json()) as { data: { files: Array<{ path: string }> } };
    expect(body.data.files.map((f) => f.path)).toEqual(["src/cli/doctor.ts"]);
  });

  test("resolves a bare subdir id (no slash) the same as the path prefix (cytoscape island)", async () => {
    await seedGraph(
      makeGraphWith(
        [
          { id: "file:src/cli/doctor.ts:", type: "file", name: "doctor.ts", path: "src/cli/doctor.ts" },
          { id: "file:src/cli/explain.ts:", type: "file", name: "explain.ts", path: "src/cli/explain.ts" },
          { id: "file:src/brain/b.ts:", type: "file", name: "b.ts", path: "src/brain/b.ts" },
        ],
        [["src/cli/doctor.ts", "../brain/b"]],
      ),
    );
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/files?subdir=cli"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        subdir: { id: string; files: number };
        files: Array<{ path: string }>;
        neighbors: { outbound: Array<{ id: string; weight: number }> };
      };
    };
    expect(body.data.subdir.id).toBe("cli");
    expect(body.data.files.map((f) => f.path).sort()).toEqual([
      "src/cli/doctor.ts",
      "src/cli/explain.ts",
    ]);
    expect(body.data.neighbors.outbound).toContainEqual({ id: "brain", weight: 1 });
  });

  test("bare subdir id does not match a sibling whose id is a prefix substring", async () => {
    await seedGraph(
      makeGraphWith([
        { id: "file:src/cli/doctor.ts:", type: "file", name: "doctor.ts", path: "src/cli/doctor.ts" },
        { id: "file:src/client/types.ts:", type: "file", name: "types.ts", path: "src/client/types.ts" },
      ]),
    );
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/files?subdir=cli"));
    const body = (await res.json()) as { data: { files: Array<{ path: string }> } };
    expect(body.data.files.map((f) => f.path)).toEqual(["src/cli/doctor.ts"]);
  });

  // ── trace-tree: read-only `functions` count field ──
  test("each file row carries `functions` = count of function-type symbols (not total)", async () => {
    await seedGraph(
      makeGraphWith([
        { id: "file:src/cli/doctor.ts:", type: "file", name: "doctor.ts", path: "src/cli/doctor.ts" },
        { id: "function:src/cli/doctor.ts:runDoctor", type: "function", name: "runDoctor", path: "src/cli/doctor.ts" },
        { id: "function:src/cli/doctor.ts:checkAll", type: "function", name: "checkAll", path: "src/cli/doctor.ts" },
        { id: "class:src/cli/doctor.ts:Doctor", type: "class", name: "Doctor", path: "src/cli/doctor.ts" },
      ]),
    );
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/files?subdir=cli"));
    const body = (await res.json()) as { data: { files: Array<{ path: string; symbols: number; functions: number }> } };
    const f = body.data.files.find((x) => x.path === "src/cli/doctor.ts")!;
    expect(f.symbols).toBe(3); // total symbols (2 fn + 1 class)
    expect(f.functions).toBe(2); // functions only — the badge value
  });

  test("a file with 0 functions reads functions:0 while symbols>0 (badge distinction — the hide prerequisite)", async () => {
    await seedGraph(
      makeGraphWith([
        { id: "file:src/cli/types.ts:", type: "file", name: "types.ts", path: "src/cli/types.ts" },
        { id: "class:src/cli/types.ts:Config", type: "class", name: "Config", path: "src/cli/types.ts" },
        { id: "symbol:src/cli/types.ts:DEFAULT", type: "symbol", name: "DEFAULT", path: "src/cli/types.ts" },
      ]),
    );
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/files?subdir=cli"));
    const body = (await res.json()) as { data: { files: Array<{ path: string; symbols: number; functions: number }> } };
    const f = body.data.files.find((x) => x.path === "src/cli/types.ts")!;
    expect(f.symbols).toBe(2);
    expect(f.functions).toBe(0);
  });

  test("ONLY adds `functions` — every existing file-row field byte-unchanged (only-add guard)", async () => {
    await seedGraph(
      makeGraphWith([
        { id: "file:src/cli/doctor.ts:", type: "file", name: "doctor.ts", path: "src/cli/doctor.ts" },
        { id: "function:src/cli/doctor.ts:runDoctor", type: "function", name: "runDoctor", path: "src/cli/doctor.ts" },
      ]),
    );
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/files?subdir=cli"));
    const body = (await res.json()) as { data: { files: Array<Record<string, unknown>> } };
    const f = body.data.files.find((x) => x.path === "src/cli/doctor.ts")!;
    // Exact key set = the 6 pre-existing fields + the 1 new field, nothing else
    // dropped/renamed; existing values unchanged.
    expect(Object.keys(f).sort()).toEqual(
      ["desc", "explainState", "functions", "loc", "name", "path", "symbols"],
    );
    expect(f.name).toBe("doctor.ts");
    expect(f.path).toBe("src/cli/doctor.ts");
    expect(f.symbols).toBe(1);
    expect(f.explainState).toBe("none");
    expect(typeof f.loc).toBe("number");
    expect(typeof f.desc).toBe("string");
  });

  test("parity tripwire: /files `functions` === /symbols function-kind count for the same file (one determination, not two)", async () => {
    await seedGraph(
      makeGraphWith([
        { id: "file:src/cli/doctor.ts:", type: "file", name: "doctor.ts", path: "src/cli/doctor.ts" },
        { id: "function:src/cli/doctor.ts:runDoctor", type: "function", name: "runDoctor", path: "src/cli/doctor.ts" },
        { id: "function:src/cli/doctor.ts:checkAll", type: "function", name: "checkAll", path: "src/cli/doctor.ts" },
        { id: "class:src/cli/doctor.ts:Doctor", type: "class", name: "Doctor", path: "src/cli/doctor.ts" },
      ]),
    );
    const app = makeApp();
    const filesRes = await app.fetch(new Request("http://localhost/api/repo-graph/files?subdir=cli"));
    const filesBody = (await filesRes.json()) as { data: { files: Array<{ path: string; functions: number }> } };
    const symRes = await app.fetch(new Request("http://localhost/api/repo-graph/symbols?file=src/cli/doctor.ts"));
    const symBody = (await symRes.json()) as { data: { symbols: Array<{ kind: string }> } };
    const filesFnCount = filesBody.data.files.find((x) => x.path === "src/cli/doctor.ts")!.functions;
    const symbolsFnCount = symBody.data.symbols.filter((s) => s.kind === "function").length;
    // The badge count and the expandable function leaves (leaf filter) MUST
    // be the SAME set — else "3 fns" ≠ what expands. Lock the two endpoints' notion
    // of "function" to one determination (the A/B shared-bucketer lesson).
    expect(filesFnCount).toBe(symbolsFnCount);
    expect(filesFnCount).toBe(2);
  });

  test("400 when subdir param missing", async () => {
    await seedGraph(emptyGraph());
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/files"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/repo-graph/symbols", () => {
  test("200 returns SymbolLevel: symbols + REAL intra-file call edges", async () => {
    const graph = makeGraphWith([
      { id: "file:src/x.ts:", type: "file", name: "x.ts", path: "src/x.ts" },
      { id: "function:src/x.ts:foo", type: "function", name: "foo", path: "src/x.ts", signature: "(a) => B", lineRange: [10, 20] },
      { id: "function:src/x.ts:bar", type: "function", name: "bar", path: "src/x.ts", lineRange: [30, 40] },
    ]);
    // Real call edge: foo() calls bar(). No synthesized hub anymore.
    graph.edges.push({
      id: "function:src/x.ts:foo::calls::bar",
      source: "function:src/x.ts:foo",
      target: "bar",
      type: "calls",
      weight: 1,
      call_kind: "static",
    });
    await seedGraph(graph);
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/symbols?file=src/x.ts"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        file: { name: string; subdir: string };
        symbols: Array<{ name: string; kind: string; line: number; signature: string }>;
        callEdges: Array<{ source: string; target: string }>;
      };
    };
    expect(body.data.file.name).toBe("x.ts");
    expect(body.data.symbols.map((s) => s.name).sort()).toEqual(["bar", "foo"]);
    expect(body.data.symbols.find((s) => s.name === "foo")?.signature).toBe("(a) => B");
    expect(body.data.symbols.find((s) => s.name === "foo")?.line).toBe(10);
    expect(body.data.callEdges).toEqual([{ source: "foo", target: "bar" }]);
  });

  test("404 when file not in graph", async () => {
    await seedGraph(emptyGraph());
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/symbols?file=src/ghost.ts"));
    expect(res.status).toBe(404);
  });

  test("400 when file param missing", async () => {
    await seedGraph(emptyGraph());
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/symbols"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/repo-graph/search", () => {
  test("200 returns SearchHit[] with kind=symbol shape", async () => {
    const queryIndex = emptyQueryIndex();
    queryIndex.name_to_node_ids["foo"] = ["function:src/x.ts:foo"];
    queryIndex.path_to_node_ids["src/x.ts"] = ["function:src/x.ts:foo"];
    await seedGraph(
      makeGraphWith([
        { id: "function:src/x.ts:foo", type: "function", name: "foo", path: "src/x.ts", signature: "() => void", lineRange: [5, 9] },
      ]),
      { queryIndex },
    );
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/search?q=foo"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { hits: Array<Record<string, unknown>> } };
    expect(body.data.hits).toHaveLength(1);
    expect(body.data.hits[0]).toMatchObject({
      kind: "symbol",
      name: "foo",
      symbolKind: "function",
      signature: "() => void",
      // CONSCIOUS FLIP (B-fix 2026-06-10): was "x.ts" — the old segment
      // heuristic shipped the FILENAME as a bucket id for a loose file right
      // under src/. No projection bucket claims "src/x.ts" → honest-zero "".
      subdir: "",
      file: "x.ts",
      line: 5,
    });
  });

  test("file hits map to kind=file", async () => {
    const queryIndex = emptyQueryIndex();
    queryIndex.path_to_node_ids["src/cli/doctor.ts"] = ["file:src/cli/doctor.ts:"];
    queryIndex.name_to_node_ids["doctor.ts"] = ["file:src/cli/doctor.ts:"];
    await seedGraph(
      makeGraphWith([{ id: "file:src/cli/doctor.ts:", type: "file", name: "doctor.ts", path: "src/cli/doctor.ts" }]),
      { queryIndex },
    );
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/search?q=doctor"));
    const body = (await res.json()) as { data: { hits: Array<{ kind: string; subdir: string; file: string }> } };
    const fileHit = body.data.hits.find((h) => h.kind === "file");
    expect(fileHit).toMatchObject({ kind: "file", subdir: "cli", file: "doctor.ts" });
  });

  test("no match → Levenshtein 'did you mean' suggestions (M4)", async () => {
    const queryIndex = emptyQueryIndex();
    queryIndex.name_to_node_ids["runExplain"] = ["function:src/explain/explain.ts:runExplain"];
    await seedGraph(
      makeGraphWith([
        { id: "function:src/explain/explain.ts:runExplain", type: "function", name: "runExplain", path: "src/explain/explain.ts" },
      ]),
      { queryIndex },
    );
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/search?q=runExpalin"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { hits: unknown[]; suggestions: Array<{ kind: string; name: string }> };
    };
    expect(body.data.hits).toHaveLength(0);
    expect(body.data.suggestions.map((s) => s.name)).toContain("runExplain");
    expect(body.data.suggestions[0]).toMatchObject({ kind: "suggestion" });
  });

  test("400 when q missing or empty", async () => {
    await seedGraph(emptyGraph());
    const app = makeApp();
    expect((await app.fetch(new Request("http://localhost/api/repo-graph/search"))).status).toBe(400);
    expect((await app.fetch(new Request("http://localhost/api/repo-graph/search?q="))).status).toBe(400);
  });

  test("limit capped at 50", async () => {
    const queryIndex = emptyQueryIndex();
    const nodes: SeedNode[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `function:src/f${i}.ts:fnPrefix${i}`;
      nodes.push({ id, type: "function", name: `fnPrefix${i}`, path: `src/f${i}.ts` });
      queryIndex.name_to_node_ids[`fnPrefix${i}`] = [id];
    }
    await seedGraph(makeGraphWith(nodes), { queryIndex });
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/search?q=fnPrefix&limit=200"));
    const body = (await res.json()) as { data: { hits: unknown[] } };
    expect(body.data.hits).toHaveLength(50);
  });

  test("404 when graph not found for cwd", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/search?q=foo"));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/repo-graph/explain (M5 cache-state)", () => {
  test("state none when no cache entry exists", async () => {
    await seedGraph(makeGraphWith([{ id: "file:src/x.ts:", type: "file", name: "x.ts", path: "src/x.ts" }]));
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/repo-graph/explain?target=file:src/x.ts:"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { state: string; fingerprint: string } };
    expect(body.data.state).toBe("none");
  });

  test("400 when target missing", async () => {
    await seedGraph(emptyGraph());
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/explain"));
    expect(res.status).toBe(400);
  });

  // Cache-key-mismatch regression (maintenance round #2): the writer stores
  // under cacheKey(resolved_node_id); a RAW PATH target read with
  // cacheKey(target) silently misses → "none" for an entry that exists.
  // Resolve-then-key (the /explain/result pattern) must apply here too.
  test("raw path target hits the node-id-keyed cache (resolve-then-key)", async () => {
    const queryIndex = emptyQueryIndex();
    queryIndex.path_to_node_ids["src/x.ts"] = ["file:src/x.ts:"];
    await seedGraph(
      makeGraphWith([{ id: "file:src/x.ts:", type: "file", name: "x.ts", path: "src/x.ts" }]),
      { queryIndex },
    );
    const { project_root } = resolveRepoGraphLocation(cwd, { home });
    await writeExplanation(project_root, cacheKey("file:src/x.ts:"), "# x.ts\nbody", {
      schemaVersion: EXPLANATION_SCHEMA_VERSION,
      target: "src/x.ts",
      target_node_id: "file:src/x.ts:",
      target_key_sha256: cacheKey("file:src/x.ts:"),
      graph_indexed_ts: new Date().toISOString(),
      brain_usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_cost_usd: 0,
      },
      evidence_score: 1,
      low_confidence: false,
      depth: 1,
      created_ts: "2026-06-10T00:00:00.000Z",
      source_fingerprint: "abc123",
    });
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/repo-graph/explain?target=src%2Fx.ts"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { state: string; cachedFingerprint?: string; cachedAt?: string };
    };
    // Empty fingerprints → honestly "stale", but NEVER "none": the entry exists.
    expect(body.data.state).not.toBe("none");
    expect(body.data.cachedFingerprint).toBe("abc123");
    expect(body.data.cachedAt).toBe("2026-06-10T00:00:00.000Z");
  });
});

describe("POST /api/repo-graph/explain (M5 generate)", () => {
  test("runs runExplain (stub Brain) detached → 202 {taskId}, records done+cost (Explanation delivered via cache + reconnect)", async () => {
    const queryIndex = emptyQueryIndex();
    queryIndex.path_to_node_ids["src/x.ts"] = ["file:src/x.ts:", "function:src/x.ts:foo"];
    queryIndex.name_to_node_ids["foo"] = ["function:src/x.ts:foo"];
    await seedGraph(
      makeGraphWith([
        { id: "file:src/x.ts:", type: "file", name: "x.ts", path: "src/x.ts" },
        { id: "function:src/x.ts:foo", type: "function", name: "foo", path: "src/x.ts", lineRange: [5, 9] },
      ]),
      { queryIndex },
    );
    const app = new Hono();
    mountRepoGraphRoutes(app, {
      cwd,
      home,
      secret: SECRET,
      explainSourceProvider: async () => "a\nb\nc\nd\nfunction foo() {}\n",
      explainBrainProvider: async () => ({
        markdown: "foo is the entry point of the module. See [src/x.ts:5] for details.",
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          input_tokens: 1,
          output_tokens: 1,
          total_cost_usd: 0.001,
        },
      }),
    });
    const res = await app.fetch(
      new Request("http://localhost/api/repo-graph/explain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "src/x.ts" }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { taskId: string; status: string };
    expect(body.taskId).toBeTruthy();
    expect(body.status).toBe("running");
    await pollTerminal();
    expect(taskRecord().status).toBe("done");
    expect(taskRecord().costUsd).toBeCloseTo(0.001, 6);
  });

  test("400 when target missing in body", async () => {
    await seedGraph(emptyGraph());
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/repo-graph/explain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("read routes are unauthenticated", () => {
  test("200 with no Bearer + 200 with wrong Bearer (token ignored)", async () => {
    await seedGraph(makeGraphWith([{ id: "file:src/x.ts:", type: "file", name: "x.ts", path: "src/x.ts" }]));
    const app = makeApp();
    expect((await app.fetch(new Request("http://localhost/api/repo-graph/arch"))).status).toBe(200);
    const res = await app.fetch(
      new Request("http://localhost/api/repo-graph/arch", { headers: { Authorization: "Bearer wrong" } }),
    );
    expect(res.status).toBe(200);
  });
});
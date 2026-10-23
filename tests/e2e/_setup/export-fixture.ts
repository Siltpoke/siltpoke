// Fixtures for the Code Map export e2e (repo-graph-export*.spec.ts). Each seeder
// writes into the same e2e SILTPOKE_HOME the daemon reads per request, so the
// specs can seed at test time; every seeder has a matching cleanup so the shared
// home is left as found (orphaned repos pollute the repo dropdown).
//
// EXPORT_HASH: a small repo with a real project root on disk (its own git repo,
// so the stamp has a commit), all three architecture sources, and edges chosen to
// cover every trust class:
//   alpha→beta   import exists, verb cited            → solid (import)
//   beta→gamma   import exists, verb only "inferred"  → solid (AC32: inferred-but-imported)
//   delta→beta   no import, cited file:line exists    → solid (cited)
//   delta→gamma  no import, inferred                  → dashed
//   gamma→delta  no import, cited file no longer exists → dashed (AC8)
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { computeRepoFingerprint } from "../../../src/explain/arch-cache";
import { writeFingerprints, writeGraph, writeMeta, writeQueryIndex } from "../../../src/repo-graph/store";
import {
  emptyCounters,
  emptyFingerprints,
  emptyQueryIndex,
  type RepoGraph,
  type RepoGraphMeta,
} from "../../../src/repo-graph/types";

export const EXPORT_HASH = "e0a70000c001";
export const EMPTY_HASH = "e0a70000c002";
export const HUGE_HASH = "e0a70000c003";
export const TALL_HASH = "e0a70000c004";

const HOME = join(process.cwd(), ".playwright-tmp", "siltpoke");
const TMP = join(process.cwd(), ".playwright-tmp");
export const EXPORT_ROOT = join(TMP, "export-repo");
const HUGE_ROOT = join(TMP, "export-huge-repo");
const TALL_ROOT = join(TMP, "export-tall-repo");
const EMPTY_ROOT = join(TMP, "export-empty-repo");
const storage = (hash: string): string => join(HOME, "repo-memory", hash);

const SRC_FILES: Record<string, string> = {
  "src/alpha/a.ts": 'import { b } from "../beta/b";\nimport { g } from "../gamma/g";\nexport const a = b + g;\n',
  "src/alpha/util.ts": "export const util = 1;\nexport const util2 = 2;\nexport const util3 = 3;\n",
  "src/beta/b.ts": 'import { g } from "../gamma/g";\nexport const b = g;\nexport const b2 = 2;\n',
  "src/gamma/g.ts": "export const g = 1;\nexport const g2 = 2;\nexport const g3 = 3;\n",
  "src/delta/d.ts": "export const d = 1;\nexport const d2 = 2;\nexport const d3 = 3;\n",
  "src/omega/o.ts": "export const o = 1;\nexport const o2 = 2;\nexport const o3 = 3;\n",
};

const CLAIM = (value: string, file?: string, line?: number, tier?: "cited" | "inferred") => ({
  value,
  evidence: file ? [{ file, line }] : [],
  ...(tier ? { tier } : {}),
});

function cont(id: string, title: string, desc: string, members: string[]) {
  return { id, kind: "cont", title: CLAIM(title), band: CLAIM("layer-app"), desc: CLAIM(desc), members };
}

export function exportArchDoc() {
  return {
    boundary: "export-fixture",
    bands: [
      {
        id: "layer-app",
        label: CLAIM("Application"),
        order: 0,
        members: ["c-alpha", "c-beta", "c-gamma", "c-delta"],
      },
    ],
    nodes: [
      cont("c-alpha", "Alpha Core", "Coordinates the other groups.", ["src/alpha/a.ts"]),
      cont("c-beta", "Beta Store", "Holds the shared records.", ["src/beta/b.ts"]),
      cont("c-gamma", "Gamma Gateway", "Talks to the outside world.", ["src/gamma/g.ts"]),
      cont("c-delta", "Delta Jobs", "Runs background work.", ["src/delta/d.ts"]),
      // One outside system, no edges: the page and the export place it level with the bands (F3).
      { id: "x-pay", kind: "ext", title: CLAIM("Payments API"), band: CLAIM("external"), desc: CLAIM("Hosted card processor.") },
    ],
    edges: [
      { source: "c-alpha", target: "c-beta", verb: CLAIM("calls", "src/alpha/a.ts", 1, "cited") },
      { source: "c-beta", target: "c-gamma", verb: CLAIM("reads", undefined, undefined, "inferred") },
      { source: "c-delta", target: "c-beta", verb: CLAIM("feeds", "src/delta/d.ts", 2, "cited") },
      { source: "c-delta", target: "c-gamma", verb: CLAIM("notifies", undefined, undefined, "inferred") },
      { source: "c-gamma", target: "c-delta", verb: CLAIM("syncs", "src/gone/x.ts", 9, "cited") },
    ],
    groundedPct: 60,
  };
}

function authoredDoc() {
  const node = (title: string, x: number, drillTo: string) => ({ kind: "cont", title, desc: `${title} (hand-authored)`, drillTo, members: [drillTo], x, y: 40, w: 190, h: 90 });
  return {
    schemaVersion: 1,
    N: { alpha: node("Alpha", 40, "alpha"), beta: node("Beta", 290, "beta"), gamma: node("Gamma", 540, "gamma") },
    E: [["alpha", "beta", "calls"], ["beta", "gamma", "reads"]],
    BANDS: [{ x: 20, y: 20, w: 740, h: 130, label: "App", color: "var(--sky)", lc: "var(--ink3)", note: "" }],
    BOUNDARY: { x: 10, y: 10, w: 760, h: 150, label: "export-fixture" },
    GROUP_ACCENT: { sky: "#7aa7c7", terra: "#c77a5a", moss: "#7ac78a", amber: "#c7a45a" },
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    encoding: "utf8",
  }).trim();
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

async function writeIndex(hash: string, root: string, files: string[], edges: RepoGraph["edges"], headCommit?: string): Promise<string> {
  const dir = storage(hash);
  mkdirSync(dir, { recursive: true });
  const graph: RepoGraph = {
    schemaVersion: 1,
    nodes: files.map((p) => ({ id: `file:${p}:`, type: "file", name: p.split("/").pop() ?? p, path: p, lineRange: [1, 3] })),
    edges,
  };
  const counters = emptyCounters();
  counters.nodes.file = files.length;
  counters.edges.imports = edges.length;
  const indexedTs = "2026-09-20T10:00:00.000Z";
  const meta: RepoGraphMeta = {
    schemaVersion: 1,
    project_root: root,
    proj_hash: hash,
    last_indexed_ts: indexedTs,
    build_duration_ms: 5,
    counters,
    building: false,
    ...(headCommit ? { head_commit: headCommit } : {}),
  };
  await writeGraph(dir, graph);
  await writeMeta(dir, meta);
  await writeQueryIndex(dir, emptyQueryIndex());
  await writeFingerprints(dir, emptyFingerprints());
  return indexedTs;
}

async function writeArch(hash: string, doc: unknown, indexedTs: string, headCommit?: string): Promise<void> {
  const dir = storage(hash);
  const meta = {
    schemaVersion: 1,
    fingerprint: computeRepoFingerprint(emptyFingerprints()),
    graphIndexedTs: indexedTs,
    costUsd: 0.5,
    groundedPct: 60,
    model: "sonnet",
    generatedTs: "2026-09-21T09:30:00.000Z",
    ...(headCommit ? { headCommit } : {}),
  };
  writeFileSync(join(dir, "arch-model.json"), JSON.stringify(doc));
  writeFileSync(join(dir, "arch-model.meta.json"), JSON.stringify(meta));
}

export async function seedExportFixture(): Promise<void> {
  rmSync(EXPORT_ROOT, { recursive: true, force: true });
  for (const [p, text] of Object.entries(SRC_FILES)) put(join(EXPORT_ROOT, p), text);
  put(join(EXPORT_ROOT, ".siltpoke/arch-c4.json"), JSON.stringify(authoredDoc()));
  git(EXPORT_ROOT, "init", "-q", "-b", "main");
  git(EXPORT_ROOT, "add", "-A");
  git(EXPORT_ROOT, "commit", "-q", "-m", "fixture");
  const sha = git(EXPORT_ROOT, "rev-parse", "HEAD");
  const edges: RepoGraph["edges"] = [
    { id: "e1", source: "file:src/alpha/a.ts:", target: "../beta/b", type: "imports", weight: 1 },
    { id: "e2", source: "file:src/alpha/a.ts:", target: "../gamma/g", type: "imports", weight: 1 },
    { id: "e3", source: "file:src/beta/b.ts:", target: "../gamma/g", type: "imports", weight: 1 },
  ];
  const ts = await writeIndex(EXPORT_HASH, EXPORT_ROOT, Object.keys(SRC_FILES), edges, sha);
  await writeArch(EXPORT_HASH, exportArchDoc(), ts, sha);
}

/** A generated model with no boxes at all (AC3: exportable button, but "No map yet"). */
export async function seedEmptyFixture(): Promise<void> {
  mkdirSync(EMPTY_ROOT, { recursive: true });
  const ts = await writeIndex(EMPTY_HASH, EMPTY_ROOT, ["src/alpha/a.ts"], []);
  await writeArch(EMPTY_HASH, { boundary: "empty-fixture", bands: [], nodes: [], edges: [] }, ts);
}

/** A generated model too big for a 1× canvas (AC22): boxes are laid out in bands
 * by the page itself, so only the document is synthetic. */
export async function seedHugeFixture(groups = 24, perGroup = 24, hash = HUGE_HASH, root = HUGE_ROOT): Promise<void> {
  mkdirSync(root, { recursive: true });
  const ts = await writeIndex(hash, root, ["src/alpha/a.ts"], []);
  const nodes = [];
  const bands = [];
  for (let g = 0; g < groups; g++) {
    const ids: string[] = [];
    for (let i = 0; i < perGroup; i++) {
      const id = `c-${g}-${i}`;
      ids.push(id);
      nodes.push({ id, kind: "cont", title: CLAIM(`Group ${g}-${i}`), band: CLAIM(`band-${g}`), desc: CLAIM("synthetic") });
    }
    bands.push({ id: `band-${g}`, label: CLAIM(`Layer ${g}`), order: g, members: ids });
  }
  await writeArch(hash, { boundary: hash === HUGE_HASH ? "huge-fixture" : "tall-fixture", bands, nodes, edges: [] }, ts);
}

/** A map taller than it is wide (six bands of three), like a real repo's: the preview's size check. */
export const seedTallFixture = (): Promise<void> => seedHugeFixture(6, 3, TALL_HASH, TALL_ROOT);

export function cleanupExportFixtures(): void {
  for (const h of [EXPORT_HASH, EMPTY_HASH, HUGE_HASH, TALL_HASH]) rmSync(storage(h), { recursive: true, force: true });
  for (const r of [EXPORT_ROOT, HUGE_ROOT, EMPTY_ROOT, TALL_ROOT]) rmSync(r, { recursive: true, force: true });
}

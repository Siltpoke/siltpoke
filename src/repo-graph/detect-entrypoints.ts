// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Entrypoint detection.
 *
 * The trace layer roots each path at a REAL resolved symbol. v1 uses an
 * authored allow-list of the three siltpoke roots, but every emitted entry
 * must point at a symbol that actually exists in the graph — we never invent
 * a root. Each role carries an ordered list of candidate names (so a rename
 * like startServer→startDaemon is tolerated) plus a module hint used to
 * disambiguate when a name occurs in more than one place.
 */
import type { QueryIndex, RepoGraph, SiltpokeGraphNode } from "./types";
import { resolveEntryRoot, type RootPick } from "./entrypoint-roots";
import { readManifest, remapToSource, parseScriptEntry, type FileResolution } from "./entrypoint-manifest";

/** Where an emitted entrypoint came from. */
export type EntrypointSource = "bin" | "script" | "framework" | "preset";

/** How sure we are this is a real entrypoint. */
export type EntrypointConfidence = "certain" | "inferred";

export interface Entrypoint {
  /** Role key, also the `?entry=` query value: "cli" | "daemon" | "dash". */
  id: string;
  label: string;
  fn: string;
  /** Path segment after `src/` (e.g. "hooks"), or the first segment. */
  module: string;
  /** Basename of the defining file. */
  file: string;
  line: number;
  /** Repo-relative path of the defining file. */
  path: string;
  /** Graph node id of the root — the start node for `tracePath`. */
  nodeId: string;
  source: EntrypointSource;
  confidence: EntrypointConfidence;
}

/** A detection strategy: given the graph + index (+ optional repoRoot), emit entrypoints. */
type Strategy = (
  graph: RepoGraph,
  queryIndex: QueryIndex,
  repoRoot: string | undefined,
) => Entrypoint[];

interface RoleSpec {
  id: string;
  label: string;
  names: string[];
  moduleHint: string;
}

const ROLES: RoleSpec[] = [
  { id: "cli", label: "CLI · Stop hook", names: ["handleStopHook"], moduleHint: "hooks" },
  { id: "daemon", label: "Daemon · server", names: ["startDaemon", "startServer"], moduleHint: "daemon" },
  // Prefer the SSR shell (Dashboard) over a single screen (Home): the shell is
  // the semantic render root and less of a leaf. NOTE: siltpoke's dashboard is
  // JSX-shallow, so no preset root traces deep — reordering picks the less-leafy
  // / righter root, it does not manufacture depth. Shallow-entrypoint repos are
  // served by "trace from any function", not by deep presets.
  { id: "dash", label: "Dashboard render", names: ["Dashboard", "Home", "renderDashboard"], moduleHint: "web" },
];

const ROOTABLE_TYPES = new Set(["function", "class"]);

function moduleOf(path: string): string {
  const segs = path.split("/").filter(Boolean);
  if (segs[0] === "src" && segs.length >= 2) return segs[1]!;
  return segs[0] ?? "";
}

function basenameOf(path: string): string {
  const segs = path.split("/").filter(Boolean);
  return segs.length ? segs[segs.length - 1]! : path;
}

/**
 * siltpoke's own authored allow-list of the three real roots (cli/daemon/dash).
 * Moved verbatim from the original detectEntrypoints loop — see module docstring.
 */
const presetStrategy: Strategy = (graph, queryIndex) => {
  const nodeById = new Map<string, SiltpokeGraphNode>();
  for (const node of graph.nodes) nodeById.set(node.id, node);

  const out: Entrypoint[] = [];
  for (const role of ROLES) {
    let chosen: SiltpokeGraphNode | null = null;
    for (const name of role.names) {
      const ids = queryIndex.name_to_node_ids[name] ?? [];
      const candidates = ids
        .map((id) => nodeById.get(id))
        .filter((n): n is SiltpokeGraphNode => !!n && ROOTABLE_TYPES.has(n.type));
      if (candidates.length === 0) continue;
      chosen =
        candidates.find((n) => moduleOf(n.path) === role.moduleHint) ?? candidates[0]!;
      break;
    }
    if (!chosen) continue;
    out.push({
      id: role.id,
      label: role.label,
      fn: chosen.name,
      module: moduleOf(chosen.path),
      file: basenameOf(chosen.path),
      line: chosen.lineRange[0],
      path: chosen.path,
      nodeId: chosen.id,
      source: "preset",
      confidence: "inferred",
    });
  }
  return out;
};

/**
 * Shared entry constructor for generic (non-preset) strategies: bin/script/
 * framework all resolve to a `RootPick` (Task 2) + `FileResolution` (Task 3)
 * and hand off here to build the `Entrypoint`. Confidence is "certain" only
 * when the manifest pointed directly at an indexed source file (no dist/
 * remap) AND the source itself is authored (bin/script) rather than
 * heuristically discovered.
 */
function makeEntry(
  id: string,
  label: string,
  source: EntrypointSource,
  pick: RootPick,
  res: FileResolution,
): Entrypoint {
  const n = pick.node;
  const confidence: EntrypointConfidence =
    res.resolvedBy === "direct" && (source === "bin" || source === "script") ? "certain" : "inferred";
  return {
    id,
    label,
    source,
    confidence,
    fn: n.type === "file" ? basenameOf(n.path) : n.name,
    module: moduleOf(n.path),
    file: basenameOf(n.path),
    line: n.lineRange[0],
    path: n.path,
    nodeId: n.id,
  };
}

/**
 * bin strategy: reads `package.json#bin` and, for each entry, remaps a
 * possibly-built path back to its source file (Task 3) then picks a trace
 * root within it (Task 2). Skips silently (no throw) when there is no
 * repoRoot, no manifest, or a bin target that isn't indexed — a bin entry we
 * can't resolve is dropped, never fabricated.
 */
const binStrategy: Strategy = (graph, queryIndex, repoRoot) => {
  if (!repoRoot) return [];
  const man = readManifest(repoRoot);
  if (!man) return [];
  const out: Entrypoint[] = [];
  for (const [name, p] of Object.entries(man.bin)) {
    const res = remapToSource(queryIndex, p, repoRoot);
    if (!res) continue;
    const pick = resolveEntryRoot(graph, queryIndex, res.filePath);
    if (!pick) continue;
    out.push(makeEntry(`ep:bin:${name}`, `bin · ${name}`, "bin", pick, res));
  }
  return out;
};

/**
 * script strategy: reads `package.json#scripts` for an allow-listed set of
 * keys (start/dev) and, for each one, parses the command through the
 * allow-listed grammar (`parseScriptEntry`) — opaque commands (framework
 * CLIs, chains) parse to null and are skipped, never guessed at. Otherwise
 * mirrors binStrategy: remap → pick root → makeEntry.
 */
const SCRIPT_KEYS = ["start", "dev"] as const;
const scriptStrategy: Strategy = (graph, queryIndex, repoRoot) => {
  if (!repoRoot) return [];
  const man = readManifest(repoRoot);
  if (!man) return [];
  const out: Entrypoint[] = [];
  for (const key of SCRIPT_KEYS) {
    const cmd = man.scripts[key];
    if (!cmd) continue;
    const file = parseScriptEntry(cmd);
    if (!file) continue;
    const res = remapToSource(queryIndex, file, repoRoot);
    if (!res) continue;
    const pick = resolveEntryRoot(graph, queryIndex, res.filePath);
    if (!pick) continue;
    out.push(makeEntry(`ep:script:${key}`, `script · ${key}`, "script", pick, res));
  }
  return out;
};

/** Cap on Next.js route entries emitted by frameworkStrategy per detection run. */
export const FRAMEWORK_ROUTE_CAP = 20;

function routeSlug(path: string): string {
  return path.replace(/\.(t|j)sx?$/, "").replace(/\//g, "-");
}

/**
 * framework strategy: `src/index.ts` / `src/main.ts` (distinct slugs, never
 * both `index`) plus Next.js route files under `pages/`/`app/`, capped at
 * FRAMEWORK_ROUTE_CAP with a warning when truncated. All entries are
 * `inferred` — a graph-visible file/convention match, not an authored
 * manifest pointer.
 *
 * Unlike the other strategies, framework also surfaces warnings, so it
 * returns a tuple and keeps ALL state in locals — NO module-level mutable
 * array. This is a re-entrancy requirement: the daemon calls detection per
 * request and twice per request (/entrypoints + /trace); a shared
 * module-level accumulator would race across concurrent calls.
 */
function frameworkStrategy(
  graph: RepoGraph,
  queryIndex: QueryIndex,
): { entries: Entrypoint[]; warnings: string[] } {
  const entries: Entrypoint[] = [];
  const warnings: string[] = [];
  const push = (file: string, slug: string) => {
    const pick = resolveEntryRoot(graph, queryIndex, file);
    if (!pick) return;
    entries.push(
      makeEntry(`ep:fw:${slug}`, `framework · ${slug}`, "framework", pick, {
        filePath: file,
        resolvedBy: "remap",
      }),
    );
  };
  const paths = Object.keys(queryIndex.path_to_node_ids);
  // Distinct slug per file so src/index.ts and src/main.ts never collide on
  // one id (codex/qoder catch: duplicate `ep:fw:index` poisons route/menu
  // lookup).
  if (queryIndex.path_to_node_ids["src/index.ts"]) push("src/index.ts", "index");
  if (queryIndex.path_to_node_ids["src/main.ts"]) push("src/main.ts", "main");
  const routes = paths.filter(
    (p) =>
      /(^|\/)(pages|app)\//.test(p) &&
      /(page|route|index)\.(t|j)sx?$|^pages\/.+\.(t|j)sx?$/.test(p),
  );
  const capped = routes.slice(0, FRAMEWORK_ROUTE_CAP);
  if (routes.length > capped.length) {
    warnings.push(
      `${routes.length - capped.length} more route entries omitted (cap ${FRAMEWORK_ROUTE_CAP})`,
    );
  }
  for (const r of capped) push(r, routeSlug(r));
  return { entries, warnings };
}

const SOURCE_PRIORITY: Record<EntrypointSource, number> = { bin: 0, script: 1, framework: 2, preset: 3 };
function score(e: Entrypoint): [number, number] {
  return [e.confidence === "certain" ? 0 : 1, SOURCE_PRIORITY[e.source]];
}
function lessThan(a: Entrypoint, b: Entrypoint): boolean {
  const [ac, ap] = score(a);
  const [bc, bp] = score(b);
  return ac < bc || (ac === bc && ap < bp);
}
/**
 * Collapse entries sharing a `nodeId`, keeping the best candidate, then sort
 * all winners by (confidence, sourcePriority). A group containing a preset
 * always keeps the preset id — backward compat: `?entry=cli|daemon|dash`
 * must keep resolving even when a certain generic (bin/script) strategy
 * independently roots at the same node.
 */
function rankAndDedup(entries: Entrypoint[]): Entrypoint[] {
  const groups = new Map<string, Entrypoint[]>();
  for (const e of entries) {
    const g = groups.get(e.nodeId);
    if (g) g.push(e);
    else groups.set(e.nodeId, [e]);
  }
  const winners: Entrypoint[] = [];
  for (const group of groups.values()) {
    const presets = group.filter((e) => e.source === "preset");
    if (presets.length > 0) {
      winners.push(presets.reduce((a, b) => (lessThan(b, a) ? b : a)));
      continue;
    }
    winners.push(group.reduce((a, b) => (lessThan(b, a) ? b : a)));
  }
  return winners.sort((a, b) => (lessThan(a, b) ? -1 : lessThan(b, a) ? 1 : 0));
}

export function detectEntrypointsWithWarnings(
  graph: RepoGraph,
  queryIndex: QueryIndex,
  repoRoot?: string,
): { entrypoints: Entrypoint[]; warnings: string[] } {
  const simple = [binStrategy, scriptStrategy, presetStrategy].flatMap((s) =>
    s(graph, queryIndex, repoRoot),
  );
  const fw = frameworkStrategy(graph, queryIndex);
  return { entrypoints: rankAndDedup([...simple, ...fw.entries]), warnings: fw.warnings };
}

export function detectEntrypoints(
  graph: RepoGraph,
  queryIndex: QueryIndex,
  repoRoot?: string,
): Entrypoint[] {
  return detectEntrypointsWithWarnings(graph, queryIndex, repoRoot).entrypoints;
}

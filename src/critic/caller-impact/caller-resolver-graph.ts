// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Graph-backed CallerResolver.
 *
 * The *graph arm*: same `CallerResolver` interface as the user-facing
 * `GrepCallerResolver`, but answers "who calls NAME?" by reading siltpoke's
 * structural repo-graph instead of grepping. It rides behind
 * `SILTPOKE_CALLER_RESOLVER=graph` (see `inject.ts`) and is NOT the default —
 * grep remains the shipped resolver; this exists so graph-vs-grep can be
 * measured head to head.
 *
 * The graph's `calls` edges carry `target` = the callee's BARE NAME string
 * (confirmed against the real on-disk graph: `{source: <caller node id>,
 * type: "calls", target: "<bare name>"}`, empty target for dynamic calls). So a
 * caller of NAME is any `calls` edge with `target === name`; its `source` node
 * id resolves to the calling function's `{path, lineRange}`.
 *
 * Robustness: never throws. No index on disk, a load failure, or any internal
 * error all degrade to `{unavailable: true}` so the caller (`graphThenGrep`)
 * falls back to grep and an unindexed repo still gets a block.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { resolveRepoGraphLocation } from "../../repo-graph/proj-hash.ts";
import { readGraph, readMeta, readQueryIndex } from "../../repo-graph/store.ts";
import type {
  QueryIndex,
  RepoGraph,
  SiltpokeGraphNode,
} from "../../repo-graph/types.ts";
import type { CallerResolver, CallerSet, ResolveOpts } from "./caller-resolver.ts";

/** Everything the resolver needs, already loaded into memory. */
export interface LoadedGraph {
  graph: RepoGraph;
  queryIndex: QueryIndex;
  /** ISO 8601 of the index's last successful build (the freshness baseline). */
  lastIndexedTs: string | null;
  /** Absolute project root the index was built for (for mtime comparison). */
  projectRoot: string;
  storageDir: string;
  /** True when the working tree is newer than the index. */
  stale: boolean;
}

/**
 * Injectable graph-loader seam — tests pass an in-memory graph (no disk). The
 * real default path is the async `loadFromDisk`; this sync shape is the test
 * seam, so a fake returns a fully-formed `LoadedGraph` (or null for unindexed)
 * with zero I/O.
 */
export type GraphLoadFn = (opts: ResolveOpts) => LoadedGraph | null;

const UNAVAILABLE: CallerSet = {
  callers: [],
  defs: 0,
  ambiguous: false,
  callsiteCount: 0,
  unavailable: true,
};

/**
 * Staleness primitive: true when ANY of `relFiles` has an mtime newer than
 * the index's `last_indexed_ts`. Bounded by the file list (not the whole tree),
 * and errs only toward "stale" (a stat error or missing baseline never flips it
 * to fresh). Used for TWO signals: at load time over the diff's changed files
 * (did the callee's def move?) and — the critical one — at resolve time over
 * the RESOLVED CALLER files (are the `:line` numbers we're about to emit still
 * trustworthy?). The caller-file signal is what protects out-of-diff callers
 * whose files changed without re-indexing; the diff-file signal alone would read
 * those as false-fresh.
 */
function anyFileNewerThanIndex(
  projectRoot: string,
  lastIndexedTs: string | null,
  relFiles: string[],
): boolean {
  if (!lastIndexedTs) return false; // no baseline — can't claim stale
  const indexedMs = Date.parse(lastIndexedTs);
  if (Number.isNaN(indexedMs)) return false;
  for (const rel of relFiles) {
    const abs = resolve(projectRoot, rel);
    if (!existsSync(abs)) continue;
    try {
      if (statSync(abs).mtimeMs > indexedMs) return true;
    } catch {
      // unreadable file — ignore, don't flip stale on a stat error
    }
  }
  return false;
}

/**
 * Normalize a path to cwd-relative so graph node paths (stored repo-relative)
 * and `excludeFiles` (which may be ABSOLUTE — Edit/Write tool_use records often
 * are) compare equal. Mirrors `GrepCallerResolver.toRelative`: an absolute path
 * is made relative to cwd; a relative path just loses a leading `./`. Without
 * this, an absolute changed-file entry never matches the graph's `src.path`, so
 * the changed function's OWN definition file leaks into the caller list.
 */
function toRel(p: string, cwd: string): string {
  if (isAbsolute(p)) return relative(cwd, p);
  return p.replace(/^\.\//, "");
}

/**
 * Async on-disk load — the real default path. Returns null when the repo has no
 * index dir, otherwise reads graph + queryIndex + meta and computes staleness.
 */
async function loadFromDisk(opts: ResolveOpts): Promise<LoadedGraph | null> {
  const loc = resolveRepoGraphLocation(opts.cwd);
  if (!existsSync(loc.storage_dir)) return null;
  const [graph, queryIndex, meta] = await Promise.all([
    readGraph(loc.storage_dir),
    readQueryIndex(loc.storage_dir),
    readMeta(loc.storage_dir),
  ]);
  // Empty graph (missing/corrupt graph.json) ⇒ treat as unindexed so grep wins.
  if (graph.nodes.length === 0) return null;
  const lastIndexedTs = meta?.last_indexed_ts ?? null;
  return {
    graph,
    queryIndex,
    lastIndexedTs,
    projectRoot: loc.project_root,
    storageDir: loc.storage_dir,
    stale: anyFileNewerThanIndex(loc.project_root, lastIndexedTs, opts.excludeFiles),
  };
}

/** A node-id → node lookup for resolving a caller edge's `source` to a file. */
function indexNodesById(graph: RepoGraph): Map<string, SiltpokeGraphNode> {
  const m = new Map<string, SiltpokeGraphNode>();
  for (const n of graph.nodes) m.set(n.id, n);
  return m;
}

/** Number of `calls` edges originating in each file (fan-in proxy for FM-6). */
function fanInByFile(
  graph: RepoGraph,
  byId: Map<string, SiltpokeGraphNode>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.type !== "calls") continue;
    const src = byId.get(e.source);
    if (!src) continue;
    counts.set(src.path, (counts.get(src.path) ?? 0) + 1);
  }
  return counts;
}

export class GraphCallerResolver implements CallerResolver {
  private readonly load: GraphLoadFn | null;

  /**
   * @param deps.load optional sync in-memory loader (tests). When absent the
   *   resolver loads from disk asynchronously (the real default path).
   */
  constructor(deps?: { load: GraphLoadFn }) {
    this.load = deps ? deps.load : null;
  }

  async resolveCallers(name: string, opts: ResolveOpts): Promise<CallerSet> {
    try {
      const loaded = this.load
        ? this.load(opts)
        : await loadFromDisk(opts);
      if (!loaded) return { ...UNAVAILABLE };
      return this.resolveFrom(name, loaded, opts);
    } catch {
      return { ...UNAVAILABLE };
    }
  }

  private resolveFrom(
    name: string,
    loaded: LoadedGraph,
    opts: ResolveOpts,
  ): CallerSet {
    const { graph, queryIndex } = loaded;

    // defs = function nodes sharing this name (via the query index).
    const ids = queryIndex.name_to_node_ids[name] ?? [];
    const byId = indexNodesById(graph);
    const defs = ids.filter((id) => byId.get(id)?.type === "function").length;
    const ambiguous = defs > 1;

    const excluded = new Set(opts.excludeFiles.map((f) => toRel(f, opts.cwd)));
    const fanIn = fanInByFile(graph, byId);

    // Collect cross-file callers: every `calls` edge with target === name,
    // resolve source → its file + first line. Dedup by file:line.
    const seen = new Set<string>();
    const collected: { file: string; line: number; fan: number }[] = [];
    for (const e of graph.edges) {
      if (e.type !== "calls" || e.target !== name) continue;
      const src = byId.get(e.source);
      if (!src) continue;
      if (excluded.has(toRel(src.path, opts.cwd))) continue; // cross-file only
      const line = src.lineRange[0];
      const key = `${src.path}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({ file: src.path, line, fan: fanIn.get(src.path) ?? 0 });
    }

    // FM-6: rank by source-file fan-in (desc) BEFORE any display cap, so the
    // assembler keeps the highest-blast-radius callers first. Stable tiebreak
    // on file:line for determinism.
    collected.sort((a, b) => {
      if (b.fan !== a.fan) return b.fan - a.fan;
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      return a.line - b.line;
    });

    const callers = collected.map((c) => ({ file: c.file, line: c.line }));
    // The line-number-trust signal: OR the load-time diff-file staleness
    // with a check over the RESOLVED CALLER files — those are exactly the files
    // whose `:line` we're about to emit, so a caller file changed post-index
    // (even if outside the diff) must downgrade to file-level.
    const callerStale = anyFileNewerThanIndex(
      loaded.projectRoot,
      loaded.lastIndexedTs,
      callers.map((c) => c.file),
    );
    return {
      callers,
      defs,
      ambiguous,
      callsiteCount: callers.length,
      unavailable: false,
      stale: loaded.stale || callerStale,
    };
  }
}

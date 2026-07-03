// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Repo-graph schema types.
 *
 * 5 node types + 5 edge types, critic-native metadata declared here but
 * populated lazily by later enrichment passes (the index build only fills
 * the deterministic fields — type/name/path/lineRange/signature/exported/
 * complexity).
 */

export type SiltpokeNodeType =
  | "file"
  | "function"
  | "class"
  | "module"
  | "symbol";

export type SiltpokeEdgeType = "imports" | "calls" | "contains";

export interface SiltpokeGraphNode {
  /** `{type}:{relPath}:{name}` — `file` nodes use `file:{relPath}:` (trailing colon). */
  id: string;
  type: SiltpokeNodeType;
  name: string;
  /** Repo-relative path (forward slashes, no leading `./`). */
  path: string;
  lineRange: [number, number];

  signature?: string;
  exported?: boolean;
  /** Cyclomatic complexity, 0 for non-function nodes. */
  complexity?: number;
  /**
   * First descriptive line of the symbol's leading JSDoc block,
   * captured at extraction time. Absent when the symbol has no doc-comment.
   * The trace layer reads this for a node's Purpose — it NEVER invents text.
   */
  doc?: string;

  // Critic-native metadata — declared here for forward-compat; the index build leaves these unset.
  last_critic_finding?: {
    critique_id: string;
    severity: "low" | "med" | "high";
    ts: string;
  };
  evidence_strength?: number;
  dismiss_history?: string[];
  traversal_memory?: {
    last_queried_ts: string;
    hit_count: number;
    successful_traversal_edges: string[];
  };
}

export interface SiltpokeGraphEdge {
  /** `{source}::{type}::{target}`. */
  id: string;
  source: string;
  target: string;
  type: SiltpokeEdgeType;
  /** Default 1; bumped when the same edge is observed multiple times (e.g., multiple call sites). */
  weight: number;

  /**
   * `calls` edges only. Extraction-time classification of the
   * call site, used by the CallResolver to derive the confidence klass:
   *   "static"  → the callee has a usable name (identifier or member prop)
   *   "dynamic" → computed / HOF / call-of-call; no static name → unresolvable
   * Stable across rebuilds (depends only on the file's own AST), so the
   * (raw) call edge survives incremental cache reuse and resolution is
   * recomputed against the current global index.
   */
  call_kind?: "static" | "dynamic";

  // Enrichment metadata — declared, not populated by the index build.
  traversal_score?: number;
  last_critic_evidence?: {
    critique_id: string;
    ts: string;
  };
}

export interface RepoGraph {
  schemaVersion: 1;
  nodes: SiltpokeGraphNode[];
  edges: SiltpokeGraphEdge[];
}

export interface QueryIndex {
  schemaVersion: 1;
  /** symbol/function/class name → list of node ids that share it. */
  name_to_node_ids: Record<string, string[]>;
  /** repo-relative path → list of node ids in that file (file + functions + classes + symbols). */
  path_to_node_ids: Record<string, string[]>;
}

export interface FileFingerprint {
  content_sha256: string;
  ast_sig: string;
}

export interface Fingerprints {
  schemaVersion: 1;
  files: Record<string, FileFingerprint>;
}

export interface RepoGraphMetaCounters {
  files_walked: number;
  files_cached: number;
  nodes: {
    file: number;
    function: number;
    class: number;
    module: number;
    symbol: number;
  };
  edges: {
    imports: number;
    calls: number;
    contains: number;
  };
  skipped: {
    tree_sitter_failed: number;
    too_large: number;
    not_a_source_file: number;
    /** Files dropped because the walk hit MAX_FILES. */
    file_cap: number;
  };
}

export type CoverageTier = "green" | "yellow" | "red";

/**
 * Repo-level call-resolution coverage — the go/no-go gate value,
 * computed + stored at index time. See `coverage.ts` for the definition.
 */
export interface Coverage {
  resolvedCallsites: number;
  totalCallsites: number;
  pct: number;
  tier: CoverageTier;
}

/**
 * A TS/JS path-alias rule discovered from tsconfig/jsconfig `paths` + `baseUrl`
 * (alias-edge resolution, 2026-06-08). Generic — learned from whatever the
 * project declares; never a hardcoded alias literal or framework name.
 */
export interface TsAliasRule {
  /**
   * Repo-relative dir of the declaring config (trailing slash; "" = repo root).
   * A source file uses the rule of its NEAREST enclosing config — the longest
   * `scopeDir` that prefixes the file's path.
   */
  scopeDir: string;
  /** Alias prefix, trailing-star stripped (`@/` for `@/*`; "" for baseUrl-only). */
  prefix: string;
  /**
   * Repo-relative target dir prefixes (each `paths` value resolved against the
   * config dir + `baseUrl`, trailing-star stripped, trailing slash). Usually
   * one; multiple when a `paths` entry declares several targets.
   */
  targets: string[];
}

/**
 * Index-time-discovered import anchors, baked into meta. Additive: nothing in
 * `graph.json` or the container partition (`deriveContainers`) depends on it —
 * it only feeds tier-4 edge resolution.
 */
export interface AnchorMap {
  tsAliases: TsAliasRule[];
  /** Repo-relative source-root dirs (trailing slash) for Python absolute imports. */
  pythonRoots: string[];
}

export interface RepoGraphMeta {
  schemaVersion: 1;
  project_root: string;
  proj_hash: string;
  last_indexed_ts: string;
  build_duration_ms: number;
  counters: RepoGraphMetaCounters;
  /** Persisted coverage gate. Absent on older cache entries. */
  coverage?: Coverage;
  /**
   * True while `runIndexBuild()` is in flight,
   * flipped to false on success. Missing on older cache entries —
   * readers MUST treat undefined as `false` ("ready"). Backward-compat
   * preserved by leaving the field optional.
   */
  building?: boolean;
  /**
   * Tier-4 import anchors (alias-edge resolution, 2026-06-08). Absent on
   * pre-anchor indexes — readers MUST treat undefined as "tier-4 disabled"
   * (resolution degrades to tier-1–3, byte-identical to before this field).
   */
  anchorMap?: AnchorMap;
}

export function emptyCounters(): RepoGraphMetaCounters {
  return {
    files_walked: 0,
    files_cached: 0,
    nodes: { file: 0, function: 0, class: 0, module: 0, symbol: 0 },
    edges: { imports: 0, calls: 0, contains: 0 },
    skipped: { tree_sitter_failed: 0, too_large: 0, not_a_source_file: 0, file_cap: 0 },
  };
}

export function emptyGraph(): RepoGraph {
  return { schemaVersion: 1, nodes: [], edges: [] };
}

export function emptyQueryIndex(): QueryIndex {
  return { schemaVersion: 1, name_to_node_ids: {}, path_to_node_ids: {} };
}

export function emptyFingerprints(): Fingerprints {
  return { schemaVersion: 1, files: {} };
}

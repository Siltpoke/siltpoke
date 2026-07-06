// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * /repo-graph Alpine island, hand-rolled DOM+SVG renderer.
 *
 * Direct port of the prototype renderer — NO cytoscape,
 * NO graph lib. The prototype draws absolute-positioned DOM cards inside a
 * pan/zoom `world`, group panels as `gbox` divs, and edges as inline SVG; this
 * island reproduces that exactly.
 *
 * Architecture: the renderer is vanilla DOM operating on the
 * SSR skeleton's ids (#rg-world, #rg-edges, …). Alpine `x-data="repoGraph"`
 * exists ONLY to trigger init(); it does not bind the graph.
 *
 * Responsibilities:
 *   • data adapter: window-free GROUPS / SUBDIRS / EDGES from `data-initial`
 *     (the SSR ArchitectureProjection), + groupOf / subdirsInGroup.
 *   • grouped 2×2 panel layout (port of layout.js `grouped`).
 *   • render containers (gbox) + subdir nodes + breadcrumb; pan / zoom / fit.
 *   • edges, hover-dim, slider; drill, panel, search, picker, explain;
 *     additional layouts / dark mode.
 */

import type { C4Model, C4Node } from "./repo-graph-c4-model";
// Pure keyspace fn (shared with the server — ONE-source discipline);
// safe in the client bundle, no fs/server imports behind it.
import { bucketIdOfPath } from "../../../repo-graph/project-architecture";
import {
  deriveC4FromProjection,
  type DerivableProjection,
} from "./repo-graph-c4-derive";
import { archDocToC4Model, edgeTierKey, type TierMap } from "./repo-graph-c4-adapter";
import { badgeLabel, breakdownRows } from "../../../repo-graph/container-stats-labels";
import { sumContainerStats, type ContainerStats } from "../../../repo-graph/container-stats";
import { HONEST_NOTES } from "../../../repo-graph/honest-notes";
import { shortestUniqueLabels } from "./repo-graph-file-labels";
import { funcNodeId, treeSubdirs, treeFiles, treeFunctions } from "./repo-graph-trace-tree";
import type { ArchModelDoc } from "../../../explain/arch-model-schema";
import { confirmModal } from "./confirm-modal";
import { openAnchorPopover } from "./anchor-popover";
import {
  confidenceTierWord,
  confidencePopoverTitle,
  buildConfidencePopoverHtml,
  groundedPopoverTitle,
  buildGroundedPopoverHtml,
} from "./repo-graph-popovers";

interface AlpineGlobal {
  data(name: string, factory: () => Record<string, unknown>): void;
  initTree?(rootEl: HTMLElement): void;
}

declare const globalThis: { Alpine?: AlpineGlobal };

// ─── Data-contract shapes (SSR ArchitectureProjection) ──────────────────────

interface ProjectionGroup {
  id: string;
  title: string;
  short: string;
  accent: string;
}

interface ProjectionSubdir {
  id: string;
  group: string;
  files: number;
  funcCount?: number;
  recurringBasenames?: Array<{ name: string; count: number }>;
  purpose: string;
  inbound: number;
  outbound: number;
  /** Bucket path ("scripts/", "src/explain/") — SSR ProjectionSubdir carries
   * it; display routes derive from it (B-fix), never from "src/" + id. */
  path?: string;
}

interface ProjectionEdge {
  source: string;
  target: string;
  weight: number;
}

interface ArchitectureProjection {
  groups: ProjectionGroup[];
  subdirs: ProjectionSubdir[];
  edges: ProjectionEdge[];
  /** Repo block (architecture-view LLM-derive): drives the honest-subset boundary
   * label + groupingMode. Optional because the empty default literal omits it. */
  repo?: { name: string; groupingMode?: "semantic" | "fallback" };
}

// ─── Prototype-shaped internal models ───────────────────────────────────────

/** Subdir node as the renderer consumes it (data.js `SUBDIRS` shape). */
interface Subdir {
  id: string;
  group: string;
  files: number;
  purpose: string;
  inbound: number;
  outbound: number;
  /** Bucket path from the projection ("scripts/", "src/explain/") — display
   * routes derive from THIS, never from a hardcoded "src/" + id guess. */
  path?: string;
}

/** Aggregated import edge (data.js `EDGES` shape: s→t, weight w). */
interface Edge {
  s: string;
  t: string;
  w: number;
  /** Rendered count label (scene edges only). */
  label?: string;
  /** Intra-file call/use edge (file/symbol levels) — no weight. */
  intra?: boolean;
  /** Trace edge confidence class (resolved|inferred|unresolved|unresolvable|dim|fork). */
  klass?: string;
  /** Trace-level edge — straight (no bow), always visible. */
  trace?: boolean;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LayoutResult {
  nodes: Record<string, Rect>;
  groups: Record<string, Rect>;
  bounds: { w: number; h: number };
}

/** File record as the renderer consumes it (mapped from /files contract). */
interface FileRec {
  name: string;
  path: string;
  loc: number;
  symbols: number;
  /** Function-symbol count (the trace-tree "N fns" badge; from the /files field). */
  functions: number;
  desc: string;
  /** Cached explanation up to date (drives the ✦ badge). */
  expl: boolean;
  explainState: "valid" | "stale" | "none";
}

/** Symbol record (mapped from /symbols contract). */
interface SymRec {
  name: string;
  kind: string;
  line: number;
  sig: string;
  desc: string;
}

/** 1-hop neighbor subdir for the file scene's left/right columns. */
interface Neighbor {
  id: string;
  w: number;
}

// ─── Trace-level contract (from /api/repo-graph/{trace,entrypoints}) ─

/** Detected trace root (GET /entrypoints). */
interface Entrypoint {
  id: string; // role id: "cli" | "daemon" | "dash"
  label: string;
  fn: string;
  module: string;
  file: string;
  line: number;
  path: string;
  nodeId: string;
}

/** One node on a traced call path (mirrors trace-path.ts TraceNode). */
interface TraceNodeData {
  id: string;
  fn: string;
  module: string;
  file: string;
  path: string;
  line: number;
  signature: string;
  io: { input: string; output: string };
  purpose: { src: string; text?: string };
  role?: "entry";
  shared?: boolean;
  warn?: boolean;
  klass?: string; // "unresolvable" for dynamic-dispatch tail nodes
  off?: string; // parent spine id (dimmed off-path sibling)
  tailOf?: string; // parent spine id (unresolvable continuation)
  branchOf?: string; // fork parent (not yet populated)
  branch?: string;
  weight?: number; // fan-in (off-path ranking)
}

interface TraceEdgeData {
  from: string;
  to: string;
  klass: string; // resolved | inferred | unresolved | unresolvable | dim | fork
}

interface TracePathData {
  entry: string;
  depth: number;
  spine: string[];
  nodes: TraceNodeData[];
  edges: TraceEdgeData[];
}

/** Repo-level coverage gate (GET /entrypoints). */
interface Coverage {
  resolvedCallsites: number; // confident (exact)
  totalCallsites: number; // in-repo-eligible
  pct: number;
  tier: "green" | "yellow" | "red";
}

type SceneNode =
  | { id: string; kind: "subdir"; data: Subdir; rect: Rect }
  | { id: string; kind: "file"; data: { subId: string; file: FileRec; label: string }; rect: Rect }
  | { id: string; kind: "neighbor"; data: { sub: Subdir; dir: "in" | "out" }; rect: Rect }
  | { id: string; kind: "symbol"; data: { sym: SymRec }; rect: Rect }
  | { id: string; kind: "trace"; data: { node: TraceNodeData }; rect: Rect }
  // "+N more" chip collapsing the off-path overflow under a spine node.
  | { id: string; kind: "tmore"; data: { parent: string; hidden: TraceNodeData[] }; rect: Rect };

interface SceneContainer {
  id: string;
  gid: string;
  title: string;
  accent: string;
  count: number;
  rect: Rect;
  /** Trace "call path" container → dashed ochre ph-trace-box styling. */
  isTrace?: boolean;
  /** Optional once-per-container note in the header (e.g. "shared infra"). */
  note?: string;
}

interface Scene {
  nodes: SceneNode[];
  containers: SceneContainer[];
  edges: Edge[];
  bounds: { w: number; h: number };
  /** Centered note when the scene has no cards (e.g. a 0-symbol file). */
  emptyNote?: string;
  /** Honest leaf-state note: shown BELOW the single entry node when a trace
   *  root has no resolved out-edges (clean leaf — no tail, no downstream). */
  leafNote?: string;
}

interface GraphState {
  level: "arch" | "file" | "symbol" | "trace";
  subId: string | null;
  file: string | null;
  selected: string | null;
  /** When set, the file scene shows ONLY these member
   * paths (door = the container's OWN files) under the container's title.
   * null = normal bucket semantics (subset/authored drill). */
  memberFilter: Set<string> | null;
  /** Buckets the member files live in (files are fetched per bucket). */
  memberBuckets: string[] | null;
  /** The drilled container's title — what the breadcrumb/scene header shows. */
  memberTitle: string | null;
  view: { scale: number; tx: number; ty: number };
  // Path Highlight (trace level).
  trace: {
    ep: string; // active entrypoint role id
    depth: number;
    data: TracePathData | null; // active trace
    entrypoints: Entrypoint[];
    expanded: Set<string>; // spine ids whose "+N more" off-path overflow is open
    offFor: string | null; // spine id whose off-path callees are currently revealed
    gen: Record<string, GenState>; // per-node grounded-purpose lifecycle
    coverage: Coverage | null; // repo-level go/no-go gate
    // Trace-root tree picker: which subdir / file rows are expanded. Lazy —
    // expanding a subdir fetches /files, a file fetches /symbols (once, cached).
    treeSubs: Set<string>; // expanded subdir ids
    treeFiles: Set<string>; // expanded file keys ("<subId>/<path>")
  };
}

/** A trace node's grounded-purpose generation state. */
interface GenState {
  state: "idle" | "loading" | "done" | "error";
  text?: string;
  cite?: string;
  error?: string;
}

// ─── HTML escape (port of app.js esc) ───────────────────────────────────────
function esc(s: unknown): string {
  return String(s).replace(
    /[&<>"]/g,
    (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }) as Record<string, string>)[c]!,
  );
}

/** Test/spec file? Used to sort sources ahead of tests in the Files list. */
function isTestFile(name: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name);
}

/**
 * Grid columns for the file/symbol scenes — ≈√n so a card grid stays roughly
 * square instead of a tall 2-column strip. Big subdirs (src/critic/ = 138,
 * src/web/ = 116) become a compact block fit() can scale, not a sliver. Min 2;
 * √ self-limits width (138 → 12 cols).
 */
function gridCols(n: number): number {
  return Math.max(2, Math.ceil(Math.sqrt(n)));
}

// rgba() from a #hex (port of app.js hexA).
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * Point on a rect's border along the ray from its center toward (tx,ty),
 * pushed `gap` px further out so an arrowhead clears the box edge (port of
 * app.js borderPoint).
 */
function borderPoint(r: Rect, tx: number, ty: number, gap: number): { x: number; y: number } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? r.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? r.h / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  const len = Math.hypot(dx, dy) || 1;
  return { x: cx + dx * t + (dx / len) * gap, y: cy + dy * t + (dy / len) * gap };
}

/**
 * Coupling-strength tier word for the edge hover tooltip (port of app.js
 * showEdgeTip wording). Thresholds match the strong-edge styling: >15 = heavy
 * (terra/strong), >=8 = moderate, else light.
 */
export function couplingTier(w: number): "heavy coupling" | "moderate" | "light" {
  if (w > 15) return "heavy coupling";
  if (w >= 8) return "moderate";
  return "light";
}

/**
 * Decide what trace affordance a panel foot earns. Pure so it's unit-testable
 * (attachSymTraceBtn is closure-local and not drivable). Three honest outcomes:
 *   "button" — a function symbol whose file path resolved → working "Trace from here".
 *   "note"   — a function symbol whose path did NOT resolve (getTarget="") → inert
 *              "can't trace" note, never a silent gap and never a dead button.
 *   "none"   — not a symbol foot, or a non-function symbol → no affordance (correct).
 */
export function symTraceAffordance(scope: {
  kind: "file" | "symbol";
  getTarget: string;
  symKind?: string;
}): "button" | "note" | "none" {
  if (scope.kind !== "symbol") return "none";
  if (scope.getTarget.startsWith("function:")) return "button";
  // Explicit empty-string guard (not just `symKind === "function"`) so the three
  // branches are mutually exclusive and match the JSDoc contract exactly: "note"
  // is ONLY the unresolved-path case, never a malformed non-empty getTarget.
  if (scope.symKind === "function" && scope.getTarget === "") return "note";
  return "none";
}

/**
 * Decode a canonical graph node id (`type:path:name`) into a
 * descriptor `{name, path, node_type}` that the descriptor branch of
 * `focusNodeFromChat` can route. Returns `null` for ids that are NOT in the
 * canonical format (e.g., true trace-graph-internal ids, ad-hoc strings).
 *
 * Canonical format (from extractor.ts `nodeId` fn):
 *   `${type}:${relPath}:${name}` where type ∈ {function, fn, file, class, module, symbol}.
 * File nodes have an empty name segment: `file:src/foo.ts:`.
 *
 * Split rule: first colon separates type; LAST colon separates name from path
 * (so `path` = everything between first and last colon). For a file node the
 * name is the empty string after the last colon, and `node_type` is "file".
 *
 * Exported for direct unit-testing (non-vacuous test).
 */
export function decodeCanonicalNodeId(
  nodeId: string,
): { node_type: string; path: string; name: string } | null {
  const CANONICAL_RE = /^(function|fn|file|class|module|symbol):(.+):([^:]*)$/;
  const m = CANONICAL_RE.exec(nodeId);
  if (!m) return null;
  const node_type = m[1]!;
  const path = m[2]!;
  const name = m[3]!;
  return { node_type, path, name };
}

// ── Arch affordance pure function (module-level, exported for tests) ────────────
//
// Pure function of (archSource, hasGenerated, generatedStale) — no DOM side
// effects. Encodes the affordance table below. Called from
// updateArchAffordance() inside the closure and imported directly by test suites.

/** Advisory copy — surfaced before/at the Generate trigger when the
 * pre-flight budgeter had to shard the repo context to fit the window (the
 * input-side signal that the run will likely peg its output cap and truncate).
 * Advisory only; the Generate/Re-generate action is NEVER blocked. */
export const ARCH_TRUNCATION_WARNING =
  "large repo — generate may hit the output cap and truncate";

/** The decision the affordance UI renders from (archSource, hasGenerated, stale). */
export interface ArchAffordanceDecision {
  visible: boolean;
  label: string;
  tier: "default" | "accent" | "ghost";
  hint: string | null; // muted text beside the label (fresh cache only)
  clickMode: "direct" | "modal";
}

/** Affordance table row for the given state:
 * - no cache (any view)      → direct fire, ⚡ Generate, default, no hint
 * - cache + stale (any view) → modal, ↻ Re-generate — code changed, accent, no hint
 * - cache + fresh (any view) → modal, ↻ Re-generate, ghost, "Diagram is current"
 */
export function archAffordanceState(
  _archSource: "authored" | "generated" | "subset",
  hasGenerated: boolean,
  generatedStale: boolean,
): ArchAffordanceDecision {
  // Source dimension deliberately collapsed — affordance is
  // identical across authored / generated / subset. If a future branch needs
  // per-source behavior, drop the underscore prefix and add exhaustive handling.
  if (!hasGenerated) {
    return {
      visible: true,
      label: "⚡ Generate architecture",
      tier: "default",
      hint: null,
      clickMode: "direct",
    };
  }
  if (generatedStale) {
    return {
      visible: true,
      label: "↻ Re-generate — code changed",
      tier: "accent",
      hint: null,
      clickMode: "modal",
    };
  }
  // cache + fresh
  return {
    visible: true,
    label: "↻ Re-generate",
    tier: "ghost",
    hint: "Diagram is current",
    clickMode: "modal",
  };
}

/**
 * Boot the renderer against an `.rg-host` root. Everything (data, layout,
 * scene state, DOM refs, render) is closure-local so each init() — including
 * an hx-boost re-mount — runs independently with no stale module state.
 */
function bootRepoGraph(root: HTMLElement): void {
  // ── data adapter: ArchitectureProjection → prototype globals ──────────────
  let proj: ArchitectureProjection = { groups: [], subdirs: [], edges: [] };
  let repoHash = "";
  // The cached generated model from the SSR page —
  // a raw ArchModelDoc (the adapter turns it into a C4Model + tier map) + its
  // grounded share + staleness. null when this repo hasn't been generated.
  type GeneratedPayload = {
    doc: ArchModelDoc;
    groundedPct: number;
    stale: boolean;
    /** Per-member-file function counts, SSR-computed
     * from the graph (≤3.6KB worst measured — bounded by member entries, not
     * repo size). Badge funcCount sums over a cont's OWN memberFiles. */
    fileFunctions?: Record<string, number> | null;
    /** ISO timestamp of generation — shown as "<age> ago" in the modal. */
    generatedTs?: string;
    /** Wall-clock duration of the Brain call (ms). Absent on legacy caches
     * predating this field — the modal omits the segment rather than showing "undefined". */
    durationMs?: number;
    costUsd?: number;
    /** Grounding counts. Absent on legacy caches — callers
     * MUST NOT default to 0; omit the formula line gracefully. */
    citedClaims?: number;
    totalClaims?: number;
    topologyBlindClaims?: number;
  };
  let generatedPayload: GeneratedPayload | null = null;
  // The authored model, SSR-loaded from the TARGET
  // repo's `.siltpoke/arch-c4.json` (already Zod-validated server-side) and
  // threaded through the payload — detection is "payload present", never a
  // repo-name check.
  let authoredPayload: C4Model | null = null;
  try {
    const raw = root.dataset.initial;
    if (raw) {
      const parsed = JSON.parse(raw) as {
        projection: ArchitectureProjection;
        currentProjHash?: string;
        repos?: Array<{ proj_hash: string; project_root: string | null }>;
        generatedModel?: GeneratedPayload | null;
        authoredModel?: C4Model | null;
      };
      proj = parsed.projection;
      repoHash = parsed.currentProjHash ?? "";
      generatedPayload = parsed.generatedModel ?? null;
      authoredPayload = parsed.authoredModel ?? null;
    }
  } catch (e) {
    console.warn("[repoGraph] failed to parse data-initial", e);
  }
  // Mutable — a completed in-session generate freshens the cache (the chip's
  // ·stale marker and the Re-generate affordance both read this).
  let generatedStale = generatedPayload?.stale ?? false;

  // Daemon secret embedded same-origin for the mutating index POSTs.
  const indexSecret = root.dataset.secret ?? "";

  // Render-mode flag for the ARCHITECTURE level
  // only. "c4" = the new C4 container diagram (default); "codemap" = the original
  // folder/import arch view, preserved + reachable via `?arch-mode=codemap`.
  // file / symbol / trace levels ignore this flag entirely.
  const archModeParam =
    typeof location !== "undefined"
      ? new URLSearchParams(location.search).get("arch-mode")
      : null;
  // Explicit source choice in the URL. A different axis
  // from ?arch-mode (which opts out of C4 entirely and wins over this).
  const archSourceParam =
    typeof location !== "undefined"
      ? new URLSearchParams(location.search).get("arch-source")
      : null;
  // Source gate, data-driven. All C4 sources feed the SAME render path; only the model
  // differs:
  //   authored  — the repo's `.siltpoke/arch-c4.json`, SSR-loaded into the
  //               payload (coexists with generated; DEFAULT when present —
  //               never auto-demoted by a fresh generate).
  //   generated — the cached LLM-derived model.
  //   subset    — the free honest-subset derived from the projection (Layer 1).
  //   codemap   — the original folder/import map (explicit ?arch-mode=codemap,
  //               or when there's nothing to derive).
  // Precedence: ?arch-mode=codemap > ?arch-source=<available source> >
  // authored-default > fresh generated > subset > codemap. An ?arch-source=
  // naming an unavailable source falls through to the next rule — the URL never
  // blanks the page. ?arch-source=generated renders even a STALE cache (the
  // explicit choice is respected; the stale affordance offers re-generate).
  type ArchSource = "authored" | "generated" | "subset" | "codemap";
  const hasAuthored = authoredPayload !== null;
  const canSubset = (proj.subdirs?.length ?? 0) > 0 && !!proj.repo;
  // "codemap" initial only satisfies definite-assignment through the
  // useGenerated closure — every gate branch overwrites it.
  let archSource: ArchSource = "codemap";
  // Pure placeholder — every C4 branch assigns its real model explicitly
  // (codemap never reads C4). Keeping it inert avoids the dual-purpose-
  // initializer trap for the authored↔generated toggle.
  let C4: C4Model = {
    N: {},
    E: [],
    BANDS: [],
    BOUNDARY: { x: 0, y: 0, w: 0, h: 0, label: "" },
    GROUP_ACCENT: { sky: "", terra: "", moss: "", amber: "" },
  };
  let c4Bounds = { w: 1500, h: 1170 };
  // Per-claim tiers for the generated model (cited solid / inferred dashed). null
  // for authored/subset (no grounding tiers there).
  let archTiers: TierMap | null = null;
  // The adapted generated model is needed beyond boot (chip toggling), so
  // it's cached — refreshed by loadGeneratedModel after an in-session generate.
  let generatedAdapted: ReturnType<typeof archDocToC4Model> | null = null;
  const getGeneratedAdapted = (): ReturnType<typeof archDocToC4Model> | null => {
    if (!generatedAdapted && generatedPayload) {
      generatedAdapted = archDocToC4Model(generatedPayload.doc, generatedPayload.groundedPct);
    }
    return generatedAdapted;
  };
  const useGenerated = (): void => {
    archSource = "generated";
    const adapted = getGeneratedAdapted()!;
    C4 = adapted.model;
    c4Bounds = adapted.model.__bounds;
    archTiers = adapted.tiers;
  };
  if (archModeParam === "codemap") {
    archSource = "codemap";
  } else if (archSourceParam === "generated" && generatedPayload) {
    useGenerated(); // explicit URL choice — stale included
  } else if (archSourceParam === "subset" && canSubset) {
    // Explicit ?arch-source=subset + canSubset → subset (the toggle-back).
    // Sits above hasAuthored deliberately: an authored repo never offers subset via
    // the chip, but a hand-crafted param is honored (harmless + keeps gate stateless).
    archSource = "subset";
    const derivedSub = deriveC4FromProjection(proj as unknown as DerivableProjection);
    // Raw assignment: the post-gate withStats(C4) below covers this branch;
    // archTiers stays at its null initial (only useGenerated() sets it).
    C4 = derivedSub;
    c4Bounds = derivedSub.__bounds;
  } else if (hasAuthored) {
    // Default when present. Also the fall-through target when
    // ?arch-source=generated names a model that doesn't exist.
    archSource = "authored";
    C4 = authoredPayload!;
    // c4Bounds stays at the 1500×1170 initializer ON PURPOSE: authored
    // geometry is baked to that canvas (previous behavior, byte-equivalence
    // gate). When authored models with other canvas sizes appear, derive
    // bounds from the file (e.g. BOUNDARY extent) — consciously, in its own
    // change.
  } else if (generatedPayload && !generatedPayload.stale) {
    useGenerated();
  } else if (canSubset) {
    archSource = "subset";
    const derived = deriveC4FromProjection(proj as unknown as DerivableProjection);
    C4 = derived;
    c4Bounds = derived.__bounds;
  } else {
    archSource = "codemap"; // nothing to derive → folder map
  }
  const ARCH_MODE: "c4" | "codemap" = archSource === "codemap" ? "codemap" : "c4";
  /** ONE predicate for glyph AND second-click drill.
   * Generated view: the evidence body alone, glyph =
   * memberFiles.length > 0 (the member-door made drillTo pure data here; the
   * previous drillTo conjunction is gone, members-without-drillTo conts are
   * normally drillable). Authored/subset: drillTo, unchanged. */
  const canDrillNode = (n: C4Node): boolean =>
    archSource === "generated" ? !!n.memberFiles?.length : !!n.drillTo;

  // The literal count badge belongs on EVERY view, not only the
  // honest-subset. A semantic box (generated/authored) carries the same literal
  // fact — "Next.js App · 229 files · 46× page.tsx" — counts complementing the
  // LLM name, not competing with it. Attach stats to any cont node lacking them
  // by SUMMING the index stats over the node's subdir set: `members` for an
  // aggregate (so it never undercounts to its primary), else `drillTo`, else
  // the node id. Derived/subset nodes already carry stats (skipped). Clone the
  // model first so the payload-owned authored model object is never mutated.
  const statsBySubdir = new Map<string, ContainerStats>(
    (proj.subdirs ?? []).map((s) => [
      s.id,
      { fileCount: s.files, funcCount: s.funcCount ?? 0, recurringBasenames: s.recurringBasenames ?? [] },
    ]),
  );
  // Per-member-file function counts (SSR-computed;
  // refreshed by loadGeneratedModel after an in-session generate).
  let memberFns: Record<string, number> = generatedPayload?.fileFunctions ?? {};
  /** Attach literal index counts to a C4 model's cont nodes (clone, never
   * mutate the payload object). Applied on every source switch.
   *
   * A cont carrying `memberFiles` (generated view)
   * counts ITS OWN files — fileCount = memberFiles.length, funcCount = Σ over
   * memberFns, recurring basenames over its members. A generated cont WITHOUT
   * memberFiles gets NO stats at all (no bucket fallback — a fabricated badge
   * is exactly the lie this kills; the report line says why). The subdir-id
   * bucket path below serves authored aggregates + subset 1:1, unchanged. */
  function withStats<M extends C4Model>(model: M): M {
    if (statsBySubdir.size === 0) return model;
    const out = { ...model, N: { ...model.N } };
    for (const id of Object.keys(out.N)) {
      const node = out.N[id]!;
      if (node.kind !== "cont" || node.stats) continue;
      if (node.memberFiles?.length) {
        const names = new Map<string, number>();
        for (const p of node.memberFiles) {
          const base = p.split("/").pop() ?? p;
          names.set(base, (names.get(base) ?? 0) + 1);
        }
        out.N[id] = {
          ...node,
          stats: {
            fileCount: node.memberFiles.length,
            funcCount: node.memberFiles.reduce((n, p) => n + (memberFns[p] ?? 0), 0),
            recurringBasenames: [...names.entries()]
              .filter(([, c]) => c > 1)
              .sort((a, b) => b[1] - a[1])
              .map(([name, count]) => ({ name, count })),
          },
        };
        continue;
      }
      // A generated cont's badge derives from member evidence ONLY.
      if (archSource === "generated") continue;
      const memberIds = node.members ?? (node.drillTo ? [node.drillTo] : [id]);
      const parts = memberIds
        .map((m) => statsBySubdir.get(m))
        .filter((s): s is ContainerStats => s !== undefined);
      if (parts.length > 0) out.N[id] = { ...node, stats: sumContainerStats(parts) };
    }
    return out;
  }
  C4 = withStats(C4);

  const GROUPS: ProjectionGroup[] = proj.groups ?? [];
  const SUBDIRS: Subdir[] = (proj.subdirs ?? []).map((s) => ({
    id: s.id,
    group: s.group,
    files: s.files,
    purpose: s.purpose,
    inbound: s.inbound,
    outbound: s.outbound,
    path: s.path,
  }));
  const EDGES: Edge[] = (proj.edges ?? []).map((e) => ({ s: e.source, t: e.target, w: e.weight }));

  const groupById = new Map(GROUPS.map((g) => [g.id, g]));
  const subById = new Map(SUBDIRS.map((s) => [s.id, s]));
  const FALLBACK_GROUP: ProjectionGroup = { id: "other", title: "Other", short: "Other", accent: "#8a7c64" };
  const groupOf = (subId: string): ProjectionGroup => groupById.get(subById.get(subId)?.group ?? "") ?? FALLBACK_GROUP;
  const subdirsInGroup = (gid: string): Subdir[] => SUBDIRS.filter((s) => s.group === gid);
  // B-fix 2026-06-10: display route for a bucket = its REAL projection path.
  // The old hardcoded `src/${id}/` lied on any repo whose buckets don't live
  // under src/ (plc's top-level scripts/ rendered as "src/scripts/").
  const subdirRoute = (subId: string): string => (subId ? (subById.get(subId)?.path ?? `${subId}/`) : "");

  // subdir-level import aggregates (sync, from EDGES) — drive the file scene's
  // importer/import columns + the side panel bars.
  const inbound = (id: string): Neighbor[] =>
    EDGES.filter((e) => e.t === id)
      .map((e) => ({ id: e.s, w: e.w }))
      .sort((a, b) => b.w - a.w);
  const outbound = (id: string): Neighbor[] =>
    EDGES.filter((e) => e.s === id)
      .map((e) => ({ id: e.t, w: e.w }))
      .sort((a, b) => b.w - a.w);
  const sum = (a: Neighbor[]): number => a.reduce((t, x) => t + x.w, 0);

  // ── async drill adapter (replaces the prototype's sync data.js globals) ────
  // The prototype read SYNC window.filesFor / symbolsFor; here they're caches
  // filled by ensureFiles / ensureSymbols before any render that needs them.
  const withRepo = (url: string): string =>
    repoHash ? `${url}${url.includes("?") ? "&" : "?"}repo=${encodeURIComponent(repoHash)}` : url;

  const filesCache = new Map<string, FileRec[]>();
  const symbolsCache = new Map<string, SymRec[]>();
  // Real relationship edges from the endpoints (basenames / symbol names), so
  // the file/symbol scenes draw the actual intra-subdir imports + calls/uses
  // instead of a synthetic first-file hub.
  const intraEdgesCache = new Map<string, Array<{ source: string; target: string }>>();
  const callEdgesCache = new Map<string, Array<{ source: string; target: string }>>();
  const filesFor = (subId: string): FileRec[] => filesCache.get(subId) ?? [];
  // `file` keys are full PATHS (not basenames) so same-basename files stay
  // distinct in the symbol cache + as file-node ids.
  const symbolsFor = (subId: string, filePath: string): SymRec[] => symbolsCache.get(`${subId}/${filePath}`) ?? [];
  const fileDesc = (subId: string, filePath: string): string => filesFor(subId).find((f) => f.path === filePath)?.desc ?? "";

  async function ensureFiles(subId: string): Promise<void> {
    if (filesCache.has(subId)) return;
    try {
      const res = await fetch(withRepo(`/api/repo-graph/files?subdir=${encodeURIComponent(subId)}`));
      if (!res.ok) {
        filesCache.set(subId, []);
        return;
      }
      const body = (await res.json()) as {
        data: {
          files: Array<{ name: string; path: string; loc: number; symbols: number; functions?: number; desc: string; explainState: "valid" | "stale" | "none" }>;
          intraEdges?: Array<{ source: string; target: string }>;
        };
      };
      intraEdgesCache.set(subId, body.data.intraEdges ?? []);
      const mapped: FileRec[] = body.data.files.map((f) => ({
        name: f.name,
        path: f.path,
        loc: f.loc,
        symbols: f.symbols,
        functions: f.functions ?? 0,
        desc: f.desc ?? "",
        expl: f.explainState === "valid",
        explainState: f.explainState,
      }));
      // Source files first, tests last (stable) — the API lists tests ahead of
      // sources, which made the Files list read test-first.
      mapped.sort((a, b) => (isTestFile(a.name) ? 1 : 0) - (isTestFile(b.name) ? 1 : 0));
      filesCache.set(subId, mapped);
    } catch {
      filesCache.set(subId, []);
    }
  }

  async function ensureSymbols(subId: string, filePath: string): Promise<void> {
    const key = `${subId}/${filePath}`;
    if (symbolsCache.has(key)) return;
    const path = filesFor(subId).find((f) => f.path === filePath)?.path;
    if (!path) {
      symbolsCache.set(key, []);
      return;
    }
    try {
      const res = await fetch(withRepo(`/api/repo-graph/symbols?file=${encodeURIComponent(path)}`));
      if (!res.ok) {
        symbolsCache.set(key, []);
        return;
      }
      const body = (await res.json()) as {
        data: {
          symbols: Array<{ name: string; kind: string; line: number; signature: string; desc?: string }>;
          callEdges?: Array<{ source: string; target: string }>;
        };
      };
      symbolsCache.set(
        key,
        body.data.symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.line, sig: s.signature ?? "", desc: s.desc ?? "" })),
      );
      callEdgesCache.set(key, body.data.callEdges ?? []);
    } catch {
      symbolsCache.set(key, []);
    }
  }

  // ── scene state ───────────────────────────────────────────────────────────
  const S: GraphState = {
    level: "arch",
    subId: null,
    file: null,
    selected: null,
    memberFilter: null,
    memberBuckets: null,
    memberTitle: null,
    view: { scale: 1, tx: 0, ty: 0 },
    trace: { ep: "cli", depth: 6, data: null, entrypoints: [], expanded: new Set(), offFor: null, gen: {}, coverage: null, treeSubs: new Set(), treeFiles: new Set() },
  };

  // ── Trace-level data adapter (entrypoints + per-entry trace, cached) ────
  const traceCache = new Map<string, TracePathData>();
  let entrypointsLoaded = false;

  async function ensureEntrypoints(): Promise<void> {
    if (entrypointsLoaded) return;
    try {
      const res = await fetch(withRepo("/api/repo-graph/entrypoints"));
      if (res.ok) {
        const body = (await res.json()) as { data: { entrypoints: Entrypoint[]; coverage?: Coverage } };
        S.trace.entrypoints = body.data.entrypoints ?? [];
        S.trace.coverage = body.data.coverage ?? null;
        entrypointsLoaded = true;
      }
    } catch {
      /* leave empty; toolbar still offers the default cli trace */
    }
  }

  async function ensureTrace(ep: string): Promise<TracePathData | null> {
    const cached = traceCache.get(ep);
    if (cached) return cached;
    try {
      const res = await fetch(withRepo(`/api/repo-graph/trace?entry=${encodeURIComponent(ep)}&depth=${S.trace.depth}`));
      if (!res.ok) return null;
      const body = (await res.json()) as { data: TracePathData };
      traceCache.set(ep, body.data);
      return body.data;
    } catch {
      return null;
    }
  }

  // ── layout (port of layout.js `grouped`; only one layout implemented so far) ─────────
  const PAD = 30;
  const GP_PAD = 18;
  const GP_HEAD = 34;
  const GAP = 16;

  // Node-detail is welded to "Detailed" (name + purpose + ↓in/↑out aggregate).
  function slot(): { w: number; h: number } {
    return { w: 236, h: 116 };
  }

  function grouped(): LayoutResult {
    const s = slot();
    const order = GROUPS.map((g) => g.id);
    const COLS = 2;
    const PANEL_GAP = 40;
    const panels: Record<string, { w: number; h: number; cols: number; members: Subdir[] }> = {};
    for (const gid of order) {
      const members = subdirsInGroup(gid);
      const cols = members.length >= 3 ? 2 : 1;
      const rows = Math.ceil(members.length / cols);
      const w = GP_PAD * 2 + cols * s.w + (cols - 1) * GAP;
      const h = GP_HEAD + GP_PAD + rows * s.h + (rows - 1) * GAP + GP_PAD;
      panels[gid] = { w, h, cols, members };
    }
    const colW: number[] = [];
    const rowH: number[] = [];
    order.forEach((gid, i) => {
      const c = i % COLS;
      const r = Math.floor(i / COLS);
      colW[c] = Math.max(colW[c] ?? 0, panels[gid]!.w);
      rowH[r] = Math.max(rowH[r] ?? 0, panels[gid]!.h);
    });
    const colX: number[] = [];
    let ax = PAD;
    for (let c = 0; c < COLS; c++) {
      colX[c] = ax;
      ax += (colW[c] ?? 0) + PANEL_GAP;
    }
    const rowY: number[] = [];
    let ay = PAD;
    const nRows = Math.ceil(order.length / COLS);
    for (let r = 0; r < nRows; r++) {
      rowY[r] = ay;
      ay += (rowH[r] ?? 0) + PANEL_GAP;
    }
    const groups: Record<string, Rect> = {};
    const nodes: Record<string, Rect> = {};
    order.forEach((gid, i) => {
      const c = i % COLS;
      const r = Math.floor(i / COLS);
      const p = panels[gid]!;
      const px = colX[c] ?? PAD;
      const py = rowY[r] ?? PAD;
      groups[gid] = { x: px, y: py, w: p.w, h: p.h };
      p.members.forEach((m, j) => {
        const mc = j % p.cols;
        const mr = Math.floor(j / p.cols);
        nodes[m.id] = {
          x: px + GP_PAD + mc * (s.w + GAP),
          y: py + GP_HEAD + GP_PAD + mr * (s.h + GAP),
          w: s.w,
          h: s.h,
        };
      });
    });
    const bw = (colX[COLS - 1] ?? PAD) + (colW[COLS - 1] ?? 0) + PAD;
    const bh = ay - PANEL_GAP + PAD;
    return { nodes, groups, bounds: { w: bw, h: bh } };
  }

  // ── scene builder (arch level) ─────────────────────────────────────────────
  function sceneArch(): Scene {
    const L = grouped();
    const nodes: SceneNode[] = SUBDIRS.map((sd) => ({ id: sd.id, kind: "subdir", data: sd, rect: L.nodes[sd.id]! }));
    const containers: SceneContainer[] = GROUPS.map((g) => ({
      id: "g:" + g.id,
      gid: g.id,
      title: g.title,
      accent: g.accent,
      count: subdirsInGroup(g.id).length,
      rect: L.groups[g.id]!,
    }));
    // All edges (the hide-links-<N slider was removed 2026-07-02); node→node
    // lines drawn under the cards, hidden at rest and revealed by
    // signal-focus (styleEdges).
    const edges: Edge[] = EDGES.map((e) => ({
      s: e.s,
      t: e.t,
      w: e.w,
      label: String(e.w),
    }));
    return { nodes, containers, edges, bounds: L.bounds };
  }

  // ── file level: spatial 3-column graph (port of app.js sceneFile) ──────────
  // Left = importer subdirs, center = the subdir's file cards (in a container),
  // right = imported subdirs; SVG edges link each side to the container + a
  // synthesized hub of intra-subdir file imports.
  function sceneFile(): Scene {
    const subId = S.subId!;
    // THE single filter point: a member-door shows the
    // union of the involved buckets' files restricted to the container's OWN
    // members; bucket semantics (subset/authored) untouched when no filter.
    const files = S.memberFilter
      ? (S.memberBuckets ?? [subId]).flatMap((b) => filesFor(b)).filter((f) => S.memberFilter!.has(f.path))
      : filesFor(subId);
    const inb = inbound(subId);
    const out = outbound(subId);
    const FW = 222;
    const FH = 88;
    const GAP = 13;
    const PAD = 30;
    const GP_PAD = 16;
    const HEAD = 34;
    const cols = gridCols(files.length);
    const rows = Math.ceil(files.length / cols);
    const cw = GP_PAD * 2 + cols * FW + (cols - 1) * GAP;
    const ch = HEAD + GP_PAD + rows * FH + (rows - 1) * GAP + GP_PAD;
    const NW = 178;
    const NH = 50;
    const NGAP = 16;
    const colInH = inb.length * NH + (inb.length - 1) * NGAP;
    const colOutH = out.length * NH + (out.length - 1) * NGAP;
    const contentH = Math.max(ch, colInH, colOutH);
    const cy = PAD + (contentH - ch) / 2;
    const cx = PAD + NW + 110;
    const ox = cx + cw + 110;

    const nodes: SceneNode[] = [];
    const edges: Edge[] = [];
    // Disambiguate colliding basenames (e.g. a wall of Next.js page.tsx) to
    // the shortest unique path suffix; unique names stay bare. Display only —
    // node ids are keyed on full paths (below), so the label is
    // free to be the short suffix.
    const fileLabels = shortestUniqueLabels(files);
    files.forEach((f, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      nodes.push({
        // Id keyed on the full PATH (not basename) so same-named
        // files (a wall of __init__.py) don't share one id — selecting/hovering
        // one no longer lights them all. Display label stays the short suffix.
        id: "f:" + f.path,
        kind: "file",
        data: { subId, file: f, label: fileLabels[i] ?? f.name },
        rect: { x: cx + GP_PAD + c * (FW + GAP), y: cy + HEAD + GP_PAD + r * (FH + GAP), w: FW, h: FH },
      });
    });
    const contId = "c:" + subId;
    const containers: SceneContainer[] = [
      { id: contId, title: S.memberTitle ?? subdirRoute(subId), accent: groupOf(subId).accent, gid: groupOf(subId).id, count: files.length, rect: { x: cx, y: cy, w: cw, h: ch } },
    ];
    const inStart = PAD + (contentH - colInH) / 2;
    inb.forEach((n, i) => {
      const sub = subById.get(n.id);
      if (!sub) return;
      nodes.push({ id: "n:" + n.id, kind: "neighbor", data: { sub, dir: "in" }, rect: { x: PAD, y: inStart + i * (NH + NGAP), w: NW, h: NH } });
      edges.push({ s: "n:" + n.id, t: contId, w: n.w, label: String(n.w) });
    });
    const outStart = PAD + (contentH - colOutH) / 2;
    out.forEach((n, i) => {
      const sub = subById.get(n.id);
      if (!sub) return;
      nodes.push({ id: "no:" + n.id, kind: "neighbor", data: { sub, dir: "out" }, rect: { x: ox, y: outStart + i * (NH + NGAP), w: NW, h: NH } });
      edges.push({ s: contId, t: "no:" + n.id, w: n.w, label: String(n.w) });
    });
    // Real intra-subdir file imports (from /files intraEdges, endpoints are full
    // PATHS) — only between files actually present in this scene.
    const present = new Set(files.map((f) => f.path));
    for (const e of intraEdgesCache.get(subId) ?? []) {
      if (e.source === e.target || !present.has(e.source) || !present.has(e.target)) continue;
      edges.push({ s: "f:" + e.source, t: "f:" + e.target, w: 0, intra: true });
    }
    const bw = ox + NW + PAD;
    const bh = PAD + contentH + PAD;
    return { nodes, containers, edges, bounds: { w: bw, h: bh } };
  }

  // ── symbol level: file container + symbol cards + intra calls/uses ─────────
  function sceneSymbol(): Scene {
    const subId = S.subId!;
    const file = S.file!;
    const syms = symbolsFor(subId, file);
    // Defensive empty state: if a 0-symbol file ever reaches symbol level
    // (drillToSymbol normally redirects these), render a centered note over the
    // viewport rather than a lone head-only box floating in the void.
    if (syms.length === 0) {
      const loc = filesFor(subId).find((f) => f.path === file)?.loc ?? 0;
      return {
        nodes: [],
        containers: [],
        edges: [],
        bounds: { w: 760, h: 420 },
        emptyNote: `${file.split("/").pop() ?? file} has no exported symbols · ${loc} lines`,
      };
    }
    const SW = 248;
    const SH = 104;
    const GAP = 14;
    const PAD = 36;
    const GP_PAD = 18;
    const HEAD = 36;
    const cols = gridCols(syms.length);
    const rows = Math.ceil(syms.length / cols);
    const cw = GP_PAD * 2 + cols * SW + (cols - 1) * GAP;
    const ch = HEAD + GP_PAD + rows * SH + (rows - 1) * GAP + GP_PAD;
    const cx = PAD;
    const cy = PAD;
    const nodes: SceneNode[] = [];
    const edges: Edge[] = [];
    const contId = "c:file";
    syms.forEach((sy, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      nodes.push({ id: "s:" + sy.name, kind: "symbol", data: { sym: sy }, rect: { x: cx + GP_PAD + c * (SW + GAP), y: cy + HEAD + GP_PAD + r * (SH + GAP), w: SW, h: SH } });
    });
    const containers: SceneContainer[] = [
      { id: contId, title: subdirRoute(subId) + (file.split("/").pop() ?? file), accent: groupOf(subId).accent, gid: groupOf(subId).id, count: syms.length, rect: { x: cx, y: cy, w: cw, h: ch } },
    ];
    // intra-file calls/uses (from /symbols callEdges — server-synthesized hub,
    // since the structural indexer has no real call edges; only between symbols present here).
    const present = new Set(syms.map((s) => s.name));
    for (const e of callEdgesCache.get(`${subId}/${file}`) ?? []) {
      if (e.source === e.target || !present.has(e.source) || !present.has(e.target)) continue;
      edges.push({ s: "s:" + e.source, t: "s:" + e.target, w: 0, intra: true });
    }
    return { nodes, containers, edges, bounds: { w: cx + cw + PAD, h: cy + ch + PAD } };
  }

  // ── trace level: vertical call-path spine + off-path / tail docks ──────────
  // Port of the prototype repo-graph/trace.js `buildScene` coordinate logic,
  // fed by REAL extracted data from /api/repo-graph/trace (not the authored
  // trace.js symbols). Spine runs down a dashed "call path" container; off-path
  // siblings dock left (capped top-N by fan-in + a "+N more" chip); the
  // unresolvable tail docks right; fork branches dock right (inert until fork
  // data is populated).
  const PH_OFF_CAP = 5;
  const PH = { NW: 256, NH: 62, VGAP: 46, PAD: 40, GP_PAD: 22, HEAD: 38 };

  function sceneTrace(): Scene {
    const data = S.trace.data;
    const ep = S.trace.entrypoints.find((e) => e.id === S.trace.ep);
    // For user-chosen roots (no matching preset), derive a human label from
    // the entry node's parsed fn name rather than showing the raw node id.
    const sceneEntryFn = data?.nodes.find((n) => n.id === data?.spine[0])?.fn;
    const epLabel = ep?.label ?? (sceneEntryFn ? `${sceneEntryFn}()` : S.trace.ep);
    if (!data || data.spine.length === 0) {
      // No root chosen (search-fallback entry) reads differently than a
      // chosen root that genuinely resolves to no path.
      const emptyNote = S.trace.ep ? "No call path for this entrypoint." : "Search for a function above to start tracing.";
      return { nodes: [], containers: [], edges: [], bounds: { w: 760, h: 420 }, emptyNote };
    }
    const tier = S.trace.coverage?.tier ?? "green";
    // Gate enforcement: red (<40%) suppresses the function-level path entirely
    // (the #rg-ph-fallback overlay explains the file-level fall back).
    if (tier === "red") {
      return { nodes: [], containers: [], edges: [], bounds: { w: 760, h: 420 } };
    }
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const route = data.spine;
    const routeSet = new Set(route);
    const { NW, NH, VGAP, PAD, GP_PAD, HEAD } = PH;
    const cx = PAD + 300;

    const pos: Record<string, Rect> = {};
    const nodes: SceneNode[] = [];

    // spine column (centre)
    route.forEach((id, i) => {
      const n = byId.get(id);
      if (!n) return;
      const r = { x: cx, y: PAD + HEAD + GP_PAD + i * (NH + VGAP), w: NW, h: NH };
      pos[id] = r;
      nodes.push({ id, kind: "trace", data: { node: n }, rect: r });
    });

    // unresolvable tail(s): dock right at the parent's row. Yellow tier draws
    // ONLY confirmed edges → the unresolved tail is left out.
    if (tier !== "yellow") {
      for (const n of data.nodes) {
        const tailParent = n.tailOf ? pos[n.tailOf] : undefined;
        if (!tailParent) continue;
        const r = { x: cx + NW + 70, y: tailParent.y, w: NW, h: NH };
        pos[n.id] = r;
        nodes.push({ id: n.id, kind: "trace", data: { node: n }, rect: r });
      }
    }

    // fork branches: dock right, slotted (no branchOf data populated yet — inert now)
    const brUsed: Record<string, number> = {};
    for (const n of data.nodes) {
      const bp = n.branchOf;
      const branchParent = bp ? pos[bp] : undefined;
      if (!bp || !branchParent) continue;
      const slot = brUsed[bp] ?? 0;
      const r = { x: cx + NW + 76, y: branchParent.y - 70 + slot * 92, w: 214, h: 58 };
      pos[n.id] = r;
      nodes.push({ id: n.id, kind: "trace", data: { node: n }, rect: r });
      brUsed[bp] = slot + 1;
    }

    // The dashed "call path" container wraps ONLY the path (spine + tail + fork) —
    // stable regardless of which node is selected, so revealing off-path callees
    // never resizes/shoves the spine.
    const pathXe = nodes.map((n) => n.rect.x + n.rect.w);
    const pathXs = nodes.map((n) => n.rect.x);
    const pathYe = nodes.map((n) => n.rect.y + n.rect.h);
    const bx = Math.min(...pathXs) - GP_PAD;
    const by = PAD;
    const bw = Math.max(...pathXe) + GP_PAD - bx;
    const bh = Math.max(...pathYe) + GP_PAD - by;
    // "shared infra" stated ONCE on the container header, and only when the
    // WHOLE path is shared (every spine node reachable from another entrypoint
    // family) — true for the CLI path, false for the daemon/dashboard ones, so
    // it distinguishes traces instead of decorating every node.
    const allShared = route.length > 0 && route.every((id) => byId.get(id)?.shared === true);
    const containers: SceneContainer[] = [
      {
        id: "c:trace",
        gid: "core",
        title: "call path · " + epLabel,
        accent: "#c9871f",
        count: route.length,
        rect: { x: bx, y: by, w: bw, h: bh },
        isTrace: true,
        ...(allShared ? { note: "shared infra" } : {}),
      },
    ];

    // Off-path callees are ON-DEMAND: only the SELECTED spine node's resolved-but-
    // off-spine callees appear, as a small cluster docked LEFT of that node
    // (outside the path box), capped PH_OFF_CAP by fan-in + a "+N more" chip.
    // Selecting another node moves the cluster; deselecting clears it. This keeps
    // the highlight/dim focus model (one path crisp, everything else quiet)
    // instead of a standing wall of dimmed cards.
    const offFor = S.trace.offFor;
    const offParent = offFor ? pos[offFor] : undefined;
    const offEdges: Edge[] = [];
    if (offFor && offParent && routeSet.has(offFor)) {
      const offs = data.nodes
        .filter((n) => n.off === offFor && !routeSet.has(n.id))
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || (a.fn < b.fn ? -1 : 1));
      const expanded = S.trace.expanded.has(offFor);
      const shown = expanded ? offs : offs.slice(0, PH_OFF_CAP);
      const hidden = expanded ? [] : offs.slice(PH_OFF_CAP);
      const rowH = NH + 14;
      const total = shown.length * rowH + (hidden.length > 0 ? 38 + 14 : 0);
      const ox = cx - 230; // dock left of the spine, clear of the path box
      let y = Math.max(PAD, offParent.y + NH / 2 - total / 2);
      for (const n of shown) {
        const r = { x: ox, y, w: 196, h: NH };
        pos[n.id] = r;
        nodes.push({ id: n.id, kind: "trace", data: { node: n }, rect: r });
        offEdges.push({ s: offFor, t: n.id, w: 0, klass: "dim", trace: true });
        y += rowH;
      }
      if (hidden.length > 0) {
        const mr = { x: ox, y, w: 196, h: 38 };
        pos[`more:${offFor}`] = mr;
        nodes.push({ id: `more:${offFor}`, kind: "tmore", data: { parent: offFor, hidden }, rect: mr });
      }
    }

    // path edges (spine / tail / fork) — drop any whose endpoint isn't laid out;
    // plus the on-demand dim edges to the revealed off-path cluster.
    const pathEdges: Edge[] = data.edges
      .filter((e) => e.klass !== "dim" && pos[e.from] && pos[e.to])
      .map((e) => ({ s: e.from, t: e.to, w: 0, klass: e.klass, trace: true }));
    const edges: Edge[] = [...pathEdges, ...offEdges];

    // Honest leaf state: data.nodes.length === 1 means the backend returned ONLY
    // the entry node — no resolved downstream calls, no unresolvable tail, no
    // fork branches. This is distinct from the "⚠ path may continue" tail case
    // (tail nodes have tailOf set and bring data.nodes.length to ≥ 2).
    const isCleanLeaf = data.nodes.length === 1;

    // scene bounds include the (transient) off cluster so it's never clipped;
    // reveal happens via render(false) so the spine never recenters.
    const allXs = nodes.map((n) => n.rect.x);
    const allXe = nodes.map((n) => n.rect.x + n.rect.w);
    const allYe = nodes.map((n) => n.rect.y + n.rect.h);
    const sx = Math.min(...allXs, bx) - PAD;
    const sw = Math.max(...allXe, bx + bw) + PAD - sx;
    const sh = Math.max(...allYe, by + bh) + PAD;
    return {
      nodes,
      containers,
      edges,
      bounds: { w: sx + sw, h: sh },
      ...(isCleanLeaf ? { leafNote: "No further resolved calls from here." } : {}),
    };
  }

  // The C4 diagram is drawn directly by drawArchC4()
  // (its DOM differs too much from the codemap Scene to reuse the generic node/
  // edge loop). This returns an empty scene carrying the fixed C4 world bounds so
  // the shared fit()/pan-zoom frame the diagram correctly.
  function sceneArchC4(): Scene {
    return { nodes: [], containers: [], edges: [], bounds: c4Bounds };
  }

  function buildScene(): Scene {
    if (S.level === "file") return sceneFile();
    if (S.level === "symbol") return sceneSymbol();
    if (S.level === "trace") return sceneTrace();
    return ARCH_MODE === "c4" ? sceneArchC4() : sceneArch();
  }

  // ── DOM refs (scoped to this host) ─────────────────────────────────────────
  // Guard first so a missing skeleton bails out; the `!` then types the four
  // required refs non-null so the renderer closures don't re-narrow.
  if (
    !root.querySelector("#rg-world") ||
    !root.querySelector("#rg-edges") ||
    !root.querySelector("#rg-stage") ||
    !root.querySelector("#rg-viewport")
  )
    return;
  const world = root.querySelector<HTMLElement>("#rg-world")!;
  const svg = root.querySelector<SVGSVGElement>("#rg-edges")!;
  const stage = root.querySelector<HTMLElement>("#rg-stage")!;
  const viewport = root.querySelector<HTMLElement>("#rg-viewport")!;
  const crumbsEl = root.querySelector<HTMLElement>("#rg-crumbs");
  const panelEl = root.querySelector<HTMLElement>("#rg-panel");
  const pHead = root.querySelector<HTMLElement>("#rg-phead");
  const pBody = root.querySelector<HTMLElement>("#rg-pbody");
  const pFoot = root.querySelector<HTMLElement>("#rg-pfoot");
  // Edge tooltip + explain modal live at document level (outside the host).
  const edgeTip = document.getElementById("rg-edge-tip");
  const exOverlay = document.getElementById("rg-ex-overlay");
  const exModal = document.getElementById("rg-ex-modal");

  let SCENE: Scene | null = null;
  let dragMoved = false;
  // C4 render state for signal-focus.
  // bx/by = the label's base midpoint (de-overlap resets here before nudging).
  let c4EdgeEls: Array<{ s: string; t: string; path: SVGPathElement; lab: HTMLElement; bx: number; by: number }> = [];
  let c4NodeEls: Record<string, HTMLElement> = {};

  // ── Generate affordance (button + grounded chip) ─────────
  const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
  const genLabel = root.querySelector<HTMLElement>("#rg-arch-gen-label");
  const genCost = root.querySelector<HTMLElement>("#rg-arch-gen-cost");
  // The hairline divider pairs with the button — orphaned 1px line when the
  // button hides (codemap mode) reads as a glitch, so visibility mirrors genBtn.
  const genDivider = root.querySelector<HTMLElement>(".pagehead-divider");
  const archChip = root.querySelector<HTMLElement>("#rg-arch-chip");
  const archChipPct = root.querySelector<HTMLElement>("#rg-arch-chip-pct");
  const archChipBlind = root.querySelector<HTMLElement>("#rg-arch-chip-blind");
  // Wire grounded chip → anchor-popover with buildGroundedPopoverHtml.
  // Reads generatedPayload at click time (not at wire time) so it uses the latest
  // payload (e.g. after an in-session re-generate).
  // Chip relocated from pagehead-right to toolbar-right (2026-06-12).
  // align:"right" — chip is at the toolbar's right edge; popover extends leftward, no
  // off-screen clip. The chip is wrapped by .arch-chip-tbwrap (position:relative, SSR)
  // so the popover anchors to the chip, not the whole toolbar. No wrapper needed here in
  // JS — openAnchorPopover uses trigger.parentElement which is .arch-chip-tbwrap.
  if (archChip) {
    archChip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!generatedPayload) return;
      openAnchorPopover({
        trigger: archChip,
        contentHtml: buildGroundedPopoverHtml({
          doc: generatedPayload.doc,
          groundedPct: generatedPayload.groundedPct,
          citedClaims: generatedPayload.citedClaims,
          totalClaims: generatedPayload.totalClaims,
          topologyBlindClaims: generatedPayload.topologyBlindClaims,
        }),
        ariaLabel: groundedPopoverTitle(),
        width: 340,
        align: "right",
      });
    });
  }
  // The LOUD honest-degrade line.
  const archNoEvi = root.querySelector<HTMLElement>("#rg-arch-noevi");
  // Source chip — only meaningful on a repo with an authored model.
  const srcChip = root.querySelector<HTMLElement>("#rg-src-chip");
  const segAuthored = root.querySelector<HTMLButtonElement>("#rg-src-authored");
  const segGenerated = root.querySelector<HTMLButtonElement>("#rg-src-generated");
  const segStale = root.querySelector<HTMLElement>("#rg-src-stale");

  let estFetched = false;
  let archEstUsd: number | null = null; // last successful estimate value (for modal copy)
  let generating = false;
  // In-flight cancel guard — prevents double-firing POST /arch/cancel while a
  // cancel request is already in-flight. Reset to false when `generating` clears.
  let cancellingArch = false;
  // 🖱️ double-click trap guard: while running, the button IS cancel — a habitual
  // double-click would fire generate then instantly cancel it. Cancel only arms
  // this long after observeArchRun starts driving the UI.
  const ARCH_CANCEL_ARM_MS = 600;
  let archCancelArmedAtMs = 0;
  // Terminal-error state for the generate affordance label. Single-writer rule:
  // ONLY updateArchAffordance renders the label from state; finishUI and the
  // run starters mutate this field instead of writing the DOM directly (two
  // independent writers to one surface was the clobber bug — the "⚠ … retry"
  // label never survived the subset branch). Persists until the next run.
  let archTerminalError: string | null = null;

  /** Reflect the current source on the chip.
   *
   * Gate: inArchC4 && (hasAuthored || (canSubset && hasGenerated))
   *   hasAuthored  → "Authored | Generated" label pair (existing path, byte-identical)
   *   else         → "Auto | Generated" label pair; left click → subset, right → generated
   *
   * Seam: two label pairs, one element — a 4th source type must revisit this branch.
   */
  function updateSrcChip(inArchC4: boolean): void {
    if (!srcChip) return;
    const hasGenerated = generatedPayload !== null;
    srcChip.hidden = !(inArchC4 && (hasAuthored || (canSubset && hasGenerated)));
    if (srcChip.hidden) return;
    if (segAuthored) {
      // Label + tooltip are constant after boot (hasAuthored never changes for a
      // mounted repo) — write only on change so render()-frequency calls stay no-op.
      const label = hasAuthored ? "Authored" : "Auto";
      if (segAuthored.textContent !== label) {
        segAuthored.textContent = label;
        segAuthored.title = hasAuthored
          ? "Hand-authored architecture (.siltpoke/arch-c4.json)"
          : "Derived from project structure — deterministic, no AI";
      }
    }
    segAuthored?.classList.toggle(
      "active",
      archSource === (hasAuthored ? "authored" : "subset"),
    );
    segGenerated?.classList.toggle("active", archSource === "generated");
    // No generated model yet → the segment is inert (dimmed); the Generate
    // button beside the chip is the way in.
    segGenerated?.classList.toggle("off", !generatedPayload && archSource !== "generated");
    if (segStale) segStale.hidden = !(generatedPayload !== null && generatedStale);
  }

  /** Show/hide the generate button + grounded chip for the current state.
   *
   * Affordance is a pure function of (archSource, hasGenerated,
   * generatedStale) via archAffordanceState(). The three old hide-branches are
   * replaced by a single decision. The grounded chip remains visible when
   * archSource==="generated" regardless of the button's new visibility.
   */
  function updateArchAffordance(forceHide = false): void {
    if (!genBtn || !archChip) return;
    const inArchC4 = !forceHide && S.level === "arch" && ARCH_MODE === "c4";
    updateSrcChip(inArchC4); // Chip visibility/active state tracks the same gating
    if (!inArchC4 || generating) {
      if (!generating) {
        genBtn.hidden = true;
        if (genDivider) genDivider.hidden = true;
        archChip.hidden = true;
        if (archNoEvi) archNoEvi.hidden = true;
      }
      return;
    }

    // ── Grounded chip: visible whenever viewing the generated model ────────────
    const showGroundedChip = archSource === "generated";
    archChip.hidden = !showGroundedChip;
    if (showGroundedChip) {
      // Count conts the model drew WITHOUT file evidence — surfaced, not
      // silent (claude-code's truncated model honestly reads 19 here).
      if (archNoEvi) {
        const k = Object.values(C4.N).filter((n) => n.kind === "cont" && !n.memberFiles?.length).length;
        if (k > 0) {
          archNoEvi.textContent = `${k} containers carry no file evidence`;
          archNoEvi.hidden = false;
        } else {
          archNoEvi.hidden = true;
        }
      }
      if (archChipPct) archChipPct.textContent = `${archTiers?.groundedPct ?? 0}%`;
      // Count topology-blind bands from the tier map (derived, no new
      // payload field). Surfaced as a NEUTRAL "· K layer-not-confirmable" — these
      // are honest abstentions (cores the import gradient can't place), NOT
      // grounding failures, so they sit apart from the grounded %.
      const blind = archChipBlind;
      if (blind) {
        const k = Object.values(archTiers?.bands ?? {}).filter((t) => t === "topology-blind").length;
        if (k > 0) {
          blind.textContent = `· ${k} layer-not-confirmable`;
          blind.hidden = false;
        } else {
          blind.hidden = true;
        }
      }
    } else {
      if (archNoEvi) archNoEvi.hidden = true;
    }

    // ── Affordance: pure function decides visibility, label, tier ───────────
    // inArchC4 guarantees ARCH_MODE="c4" and archSource is never "codemap" here.
    // Defensive guard: if the invariant is ever broken, bail rather than casting
    // an unsupported source through the affordance table.
    if (archSource === "codemap") return;
    const hasGenerated = generatedPayload !== null;
    const dec = archAffordanceState(
      archSource,
      hasGenerated,
      generatedStale,
    );

    genBtn.hidden = !dec.visible;
    if (genDivider) genDivider.hidden = !dec.visible;
    // Apply tier class (mutually exclusive). Must be set before the terminal-error
    // early-return so a failed-generate label doesn't silently erase the tier
    // (error state is an overlay on the tier, not a tier erasure).
    genBtn.classList.toggle("rg-btn-accent", dec.tier === "accent");
    genBtn.classList.toggle("rg-btn-ghost", dec.tier === "ghost");
    genBtn.classList.toggle("stale", dec.tier === "accent"); // keep legacy `.stale` for compat

    if (archTerminalError !== null) {
      // Terminal error overlays the label; tier/visibility already set above.
      if (genLabel) genLabel.textContent = archTerminalError;
      if (!estFetched) void fetchArchEstimate();
      return;
    }

    if (genLabel) genLabel.textContent = dec.label;
    // genCost must be written for EVERY tier on every call to avoid stale-text
    // retention across transitions (fresh→stale used to leave "Diagram is current · ≈$X"
    // while the label already showed "↻ Re-generate — code changed").
    // - fresh (hint non-null): show "Diagram is current · ≈$X" or hint alone.
    // - stale / no-cache (hint null): clear the span so no ghost text lingers.
    // The no-cache path's fetchArchEstimate() writes the est label independently
    // after it resolves — that write is preserved byte-identical.
    if (genCost) {
      if (dec.hint !== null) {
        // Re-generate cost dedup — ≈$ lives in the confirm modal only.
        // The button cost span shows just the hint text ("Diagram is current")
        // regardless of whether archEstUsd is available; the first-Generate
        // path (no-cache) is the ONLY pre-burn ≈$ surface on the button
        // (fetchArchEstimate writes "≈$X · uses Claude" there — byte-identical).
        genCost.textContent = dec.hint;
      } else {
        // Stale or no-cache: clear any previously written hint text.
        genCost.textContent = "";
      }
    }
    if (!estFetched) void fetchArchEstimate();
  }

  /** Switch the rendered source in place. Authored → BARE url (the
   * default semantics — a reload lands on authored); generated → explicit
   * `?arch-source=generated` deep link; subset → `?arch-source=subset`
   * (the toggle-back). Unavailable source → no-op. */
  function applySource(src: "authored" | "generated" | "subset"): boolean {
    if (src === archSource) return true;
    if (src === "authored") {
      if (!authoredPayload) return false;
      archSource = "authored";
      C4 = withStats(authoredPayload);
      c4Bounds = { w: 1500, h: 1170 }; // authored canvas is baked (see gate comment)
      archTiers = null;
    } else if (src === "subset") {
      if (!canSubset) return false;
      archSource = "subset";
      const derivedApply = deriveC4FromProjection(proj as unknown as DerivableProjection);
      C4 = withStats(derivedApply);
      c4Bounds = derivedApply.__bounds;
      archTiers = null;
    } else {
      const adapted = getGeneratedAdapted();
      if (!adapted) return false;
      archSource = "generated";
      C4 = withStats(adapted.model);
      c4Bounds = adapted.model.__bounds;
      archTiers = adapted.tiers;
    }
    const url = new URL(location.href);
    if (src === "generated") url.searchParams.set("arch-source", "generated");
    else if (src === "subset") url.searchParams.set("arch-source", "subset");
    else url.searchParams.delete("arch-source"); // bare URL = authored default
    history.replaceState(null, "", url);
    render(true); // re-draw in place; render → updateArchAffordance → chip refresh
    return true;
  }
  // Left-seg listener: authored repos → authored; non-authored repos → subset.
  segAuthored?.addEventListener("click", () =>
    void applySource(hasAuthored ? "authored" : "subset"),
  );
  segGenerated?.addEventListener("click", () => void applySource("generated"));

  /** Pre-flight cost → the button's "≈$X" (approximate; real cost is post-call).
   * Also stores the fetched value in `archEstUsd` for use in the modal body copy.
   *
   * Cost dedup: only write ≈$ to the button span on the NO-CACHE path
   * (no modal gate, so the button IS the only pre-burn cost signal). On the
   * FRESH-CACHE path (ghost tier) the cost lives in the confirm modal body only;
   * writing here would restore ≈$ to the button after updateArchAffordance already
   * cleared it. Detection: archAffordanceState() hint is null only on no-cache/stale;
   * at resolve time we re-evaluate the current state to write correctly. */
  async function fetchArchEstimate(): Promise<void> {
    estFetched = true;
    if (!genCost) return;
    try {
      const res = await fetch(`/api/repo-graph/arch/estimate?repo=${encodeURIComponent(repoHash)}`);
      const body = (await res.json()) as { success: boolean; data?: { estUsd: number; mayTruncate?: boolean } };
      if (body.success && body.data) {
        archEstUsd = body.data.estUsd;
        // Re-evaluate the current affordance state at resolve time (archSource /
        // generatedPayload may have changed if the island transitioned during fetch).
        const currentDec = archSource === "codemap"
          ? null
          : archAffordanceState(archSource, generatedPayload !== null, generatedStale);
        // Only write ≈$ to the button when hint is null (no-cache or stale tier;
        // the currentDec===null arm is the codemap defensive branch — unreachable
        // in practice, codemap never shows the button) — on the no-cache path this
        // IS the only pre-burn cost signal on the button. On the fresh-cache path
        // (hint non-null) suppress: cost lives in the modal body.
        if (currentDec === null || currentDec.hint === null) {
          // Advisory truncation heads-up, appended to the pre-burn cost
          // line. Advisory only — the button still fires (never blocks).
          const warn = body.data.mayTruncate ? ` · ${ARCH_TRUNCATION_WARNING}` : "";
          genCost.textContent = `≈$${body.data.estUsd.toFixed(2)} · uses Claude${warn}`;
        }
      }
    } catch {
      /* leave the cost blank — the button still works */
    }
  }

  // ── Reconnect: the generate is DETACHED — POST returns {taskId}
  // and the run survives navigate-away. The client fires, OBSERVES the run via
  // GET /arch/task (snapshot-first poll, no progress to stream), and on done
  // FETCHES the cached model from GET /arch/model — rendering in place, no reload.
  type ArchTaskSnapshot = {
    id: string;
    kind: string;
    repo: string;
    status: "running" | "done" | "failed" | "cancelled" | "crashed";
    startedTs: string;
    startedAgoMs: number;
    /** Persisted reason for a malformed/failed paid run (capped 500c
     * server-side, includes the output-token count). Rides the existing /arch/task
     * snapshot — the route spreads the full record. Absent on success. */
    errorMsg?: string;
  };
  async function fetchArchTask(): Promise<ArchTaskSnapshot | null> {
    try {
      // ?repo= → server returns OUR repo's latest only (the registry is global
      // one-task-at-a-time; unfiltered, another repo's run bleeds in here).
      const res = await fetch(`/api/repo-graph/arch/task?repo=${encodeURIComponent(repoHash)}`);
      const body = (await res.json()) as { data: { task: ArchTaskSnapshot | null } };
      return body.data.task;
    } catch {
      return null;
    }
  }
  /** Poll the snapshot until OUR task reaches a terminal; returns its status (or
   * "gone" if it vanished — never a forever-spinner) plus the persisted `errorMsg`
   * (the real reason for a malformed/failed run, undefined on success/gone).
   * One-at-a-time means while ours runs it IS `latest()`. */
  async function pollArchTaskTerminal(
    taskId: string,
    onTick: () => void,
  ): Promise<{ status: string; errorMsg?: string }> {
    for (;;) {
      const t = await fetchArchTask();
      onTick();
      if (!t || t.id !== taskId) return { status: "gone" };
      if (t.status !== "running") return { status: t.status, errorMsg: t.errorMsg };
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  /** Humanize a wall-clock duration in ms → "2m 14s" / "45s". */
  function humanizeDurationMs(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  }

  /** Humanize an ISO timestamp as "just now" / "<N>m ago" / "<N>h ago" / "<N>d ago".
   * Falls back to "" on parse failure (legacy / missing ts).
   * Near-duplicate of CompactFactoidRow.relativeAgo — that one lives in SSR-only
   * TSX this bundled client script can't import; don't add a third copy. */
  function humanizeGeneratedAgo(isoTs: string): string {
    const then = Date.parse(isoTs);
    if (Number.isNaN(then)) return "";
    const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (secs < 60) return "just now";
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function archTerminalLabel(status: string): string {
    if (status === "crashed") return "⚠ Generate timed out / killed — retry";
    if (status === "cancelled") return "Generate cancelled — retry";
    return "⚠ Generate failed — retry"; // failed / gone / unknown
  }
  /** errorMsg is server-capped at 500c but that's still too long for a button
   * label. Collapse whitespace + cap to a UI-sane length; the full reason lives in
   * the task's `.out`. Single-line — newlines in a malformed dump would break the
   * label layout. */
  function archUiTruncate(msg: string, max = 160): string {
    const oneLine = msg.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
  }
  /** Fetch the cached generated model + upgrade the view in place. */
  async function loadGeneratedModel(): Promise<boolean> {
    try {
      const res = await fetch(`/api/repo-graph/arch/model?repo=${encodeURIComponent(repoHash)}`);
      if (!res.ok) return false;
      const body = (await res.json()) as {
        data: {
          model: ArchModelDoc;
          groundedPct: number;
          fileFunctions?: Record<string, number> | null;
          generatedTs?: string;
          durationMs?: number;
          costUsd?: number;
          /** Grounding counts — optional; absent on legacy caches. */
          citedClaims?: number;
          totalClaims?: number;
          topologyBlindClaims?: number;
        };
      };
      const adapted = archDocToC4Model(body.data.model, body.data.groundedPct);
      // The fresh result IS the new cached-generated state — chip ·stale
      // clears, the toggled-to view reuses this adapt, badges attach like boot.
      generatedPayload = {
        doc: body.data.model,
        groundedPct: body.data.groundedPct,
        stale: false,
        fileFunctions: body.data.fileFunctions ?? null,
        generatedTs: body.data.generatedTs,
        durationMs: body.data.durationMs,
        costUsd: body.data.costUsd,
        citedClaims: body.data.citedClaims,
        totalClaims: body.data.totalClaims,
        topologyBlindClaims: body.data.topologyBlindClaims,
      };
      memberFns = body.data.fileFunctions ?? {};
      generatedAdapted = adapted;
      generatedStale = false;
      // archSource FIRST: withStats reads it (member-evidence-only rule for
      // generated conts) — statting before the flip hands member-less conts a
      // fabricated bucket badge (a lesson from the post-generate path).
      archSource = "generated";
      C4 = withStats(adapted.model);
      c4Bounds = adapted.model.__bounds;
      archTiers = adapted.tiers;
      // Deliberately NO ?arch-source= write here: the in-place switch is session
      // UX; a bare-URL reload returns to the authored DEFAULT (a standing rule).
      render(true); // seamless upgrade — re-draw the generated C4 in place
      return true;
    } catch {
      return false;
    }
  }
  /** Drive the generating UI for a known taskId: elapsed timer + observe → on
   * `done` load the model, on any other terminal show that state (no spinner).
   *
   * The button is ENABLED during the run — it becomes the cancel affordance.
   * The 1s tick updates the label to "🔄 M:SS · ✕ Cancel"; the click handler
   * branches on `generating` to fire runArchCancel() instead of a new generate.
   * On `cancelled` terminal: restore affordance + write muted note to genCost
   * (NOT the error-label path). failed/crashed keep the existing error path. */
  async function observeArchRun(taskId: string, startedAtMs: number): Promise<void> {
    generating = true;
    cancellingArch = false; // reset cancel guard for this run
    archCancelArmedAtMs = Date.now() + ARCH_CANCEL_ARM_MS; // 🖱️ arm cancel after the double-click window
    archTerminalError = null; // a new run is the "next user action" that retires the prior error
    // Do NOT disable the button — it is the cancel affordance while running.
    if (genCost) genCost.textContent = "";
    const tick = (): void => {
      // While cancel is pending the label shows "cancelling…" — don't overwrite it.
      if (cancellingArch) return;
      const s = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
      const mm = Math.floor(s / 60);
      const ss = String(s % 60).padStart(2, "0");
      // Slot-swap: running label = elapsed + Cancel (not the old "Generating… · usually ~2-3 min")
      if (genLabel) genLabel.innerHTML = `<span class="spin"></span> ${mm}:${ss} · ✕ Cancel`;
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    const finishUI = (label?: string): void => {
      generating = false;
      cancellingArch = false; // always clear with generating
      window.clearInterval(timer);
      archTerminalError = label ?? null;
      updateArchAffordance();
    };
    const { status, errorMsg } = await pollArchTaskTerminal(taskId, tick);
    // A malformed/failed run persists the real reason (capped 500c server-side,
    // includes output_tokens). Surface it AS-IS — finishUI writes it via
    // genLabel.textContent (NOT innerHTML), so daemon-generated text is rendered
    // inert. UI-truncate to keep the button label readable; full reason lives in .out.
    const reason = errorMsg ? `⚠ ${archUiTruncate(errorMsg)}` : null;
    if (status === "done") {
      const ok = await loadGeneratedModel();
      // done-but-no-model (malformed) is honest, not a spinner. If the run
      // persisted a reason, show it instead of the generic "No model produced".
      finishUI(ok ? undefined : (reason ?? "⚠ No model produced — retry"));
    } else if (status === "cancelled") {
      // Cancelled is NOT an error — restore normal affordance + muted note.
      archTiers = null; // clear tiers just like other non-done terminals
      generating = false;
      cancellingArch = false;
      window.clearInterval(timer);
      archTerminalError = null; // no error label
      updateArchAffordance();
      // Write muted "Last run cancelled · HH:MM" into the cost/hint span (ghost-tier, NOT error-red).
      if (genCost) {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, "0");
        const mm2 = String(now.getMinutes()).padStart(2, "0");
        genCost.textContent = `Last run cancelled · ${hh}:${mm2}`;
      }
    } else {
      archTiers = null; // don't leave a prior run's tiers live after a non-done terminal
      // Real reason replaces the generic archTerminalLabel when persisted;
      // absent errorMsg (e.g. crashed/gone with no record) → generic label.
      finishUI(reason ?? archTerminalLabel(status));
    }
  }
  /** Fire the cancel for the in-flight generate. One-shot: cancellingArch
   * guards against double-fire. The kill is async (SIGTERM → SIGKILL after 5s);
   * the button shows "cancelling…" until the poll returns the cancelled terminal.
   * On cancel POST failure (404, network) the run keeps going — only the task's
   * own terminal (failed/crashed/done) surfaces any state change. */
  function runArchCancel(): void {
    if (cancellingArch) return; // in-flight guard
    // 🖱️ double-click trap: a click landing within the arm window is almost
    // certainly the second half of the double-click that STARTED the run —
    // ignore it instead of killing a just-fired paid call.
    if (Date.now() < archCancelArmedAtMs) return;
    cancellingArch = true;
    if (genLabel) genLabel.textContent = "cancelling…";
    fetch("/api/repo-graph/arch/cancel", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": indexSecret },
    }).catch((e) => {
      // Cancel POST failed (network error) — keep polling, run continues honestly.
      console.warn("[repoGraph] arch cancel POST failed", e);
    });
    // Note: we do NOT reset cancellingArch on failure — the guard stays locked
    // for this run. The user would need to wait for the natural terminal.
  }

  /** Fire the paid generate (detached), then observe + fetch the result. */
  async function runArchGenerate(): Promise<void> {
    if (!genBtn || generating) return;
    generating = true;
    archTerminalError = null; // user retried — retire the prior terminal error
    // Do NOT disable genBtn here — it becomes the cancel affordance in observeArchRun.
    genBtn.classList.remove("stale");
    if (genCost) genCost.textContent = "";
    // Initial label: observeArchRun will overwrite with the elapsed+Cancel slot-swap,
    // but set a minimal interim so there's no flash of stale affordance label.
    if (genLabel) genLabel.innerHTML = `<span class="spin"></span> 0:00 · ✕ Cancel`;
    try {
      const res = await fetch("/api/repo-graph/arch/generate", {
        method: "POST",
        headers: { "X-Siltpoke-Secret": indexSecret, "content-type": "application/json" },
        // force:true whenever a cached model exists at fire time — the user has
        // passed the modal gate to REPLACE it (re-generate semantics), regardless
        // of whether the cache is stale or fresh. Without force:true on a fresh
        // cache, the server short-circuits at arch-generate.ts:297 (`if (!ctx.force)`)
        // and returns the cached result instantly — a silent no-op. First-generate
        // (generatedPayload null) keeps force:false (irrelevant — cache miss anyway).
        body: JSON.stringify({ repo: repoHash, force: generatedPayload !== null }),
      });
      if (res.status === 409) {
        // A run is already going — attach ONLY when it's OUR repo's run (e.g.
        // fired in another tab). The lock is global across repos, so a foreign
        // repo's run also 409s here; spinning for it would be the cross-repo
        // bleed. Foreign → re-enable + an honest one-line status instead.
        const b = (await res.json().catch(() => ({}))) as {
          activeTaskId?: string;
          activeTaskRepo?: string | null;
        };
        if (b.activeTaskId && b.activeTaskRepo === repoHash) {
          // Keep `generating` TRUE across the fetch → observe handoff: the click
          // handler's `if (generating)` branch routes any click in the await gap
          // to cancel (button is enabled), so no second observer can spawn.
          const t = await fetchArchTask();
          await observeArchRun(b.activeTaskId, Date.now() - (t?.startedAgoMs ?? 0));
        } else {
          generating = false;
          if (genBtn) genBtn.disabled = false;
          if (b.activeTaskId) archTerminalError = "⏳ Another repo's generate is running — retry when it finishes";
          updateArchAffordance();
        }
        return;
      }
      const body = (await res.json()) as { success: boolean; error?: string; taskId?: string };
      if (!res.ok || !body.taskId) throw new Error(body.error ?? `HTTP ${res.status}`);
      // `generating` stays true through the handoff — observeArchRun owns it.
      await observeArchRun(body.taskId, Date.now());
    } catch (e) {
      generating = false;
      cancellingArch = false; // theory-race hardening: a cancel fired in the await gap must not freeze the next run's tick
      if (genBtn) genBtn.disabled = false;
      archTiers = null;
      archTerminalError = "⚠ Generate failed — retry";
      updateArchAffordance();
      console.warn("[repoGraph] arch generate failed", e);
    }
  }
  /** Page-load reconnect: a detached run started on a prior visit may still
   * be running — attach to it so returning to the page resumes the live view
   * instead of a stale "Generate" button. */
  async function reconnectArchTask(): Promise<void> {
    if (generating) return;
    // Do NOT pre-claim `generating` here — this runs on every page load, and a
    // synchronous `generating = true` before the await would suppress the initial
    // updateArchAffordance (which gates the Generate button on !generating),
    // hiding the button on every repo. Instead RE-CHECK `!generating` AFTER the
    // await: if the user clicked Generate during the fetch gap, runArchGenerate
    // already set generating=true (its POST 409s on the running task + attaches),
    // so we skip here — no second observer, and the button is never suppressed.
    const t = await fetchArchTask();
    // `t.repo === repoHash` is the client half of the cross-repo guard (belt to
    // the server's ?repo= filter): a generate running on repo-A must not spin
    // the "Generating…" UI on repo-B's page.
    if (t && t.kind === "arch_generate" && t.status === "running" && t.repo === repoHash && !generating) {
      void observeArchRun(t.id, Date.now() - t.startedAgoMs);
    }
  }

  /** Modal-aware click handler.
   *
   * - No cache → direct fire (byte-identical to the pre-modal behavior).
   * - Cache present → fetch estimate → open confirm modal.
   *   • estimate fail/non-success → "estimate unavailable" in modal, confirm enabled.
   *   • cancel → zero cost.
   *   • confirm → fire runArchGenerate() exactly once.
   * - In-flight → fires runArchCancel() immediately (the button IS the cancel
   *   affordance while running — never disabled; cancel is idempotent via its
   *   own in-flight guard). */
  genBtn?.addEventListener("click", () => {
    // While running, the button IS the cancel affordance — fire cancel, not generate.
    if (generating) {
      runArchCancel();
      return;
    }
    // Re-evaluate the cache snapshot at click time (not at last render time) to
    // avoid a TOCTOU: if generatedPayload arrived between the last render and this
    // click, we must still gate through the modal.
    const hasGeneratedNow = generatedPayload !== null;
    if (!hasGeneratedNow) {
      // No cache → direct fire.
      void runArchGenerate();
      return;
    }
    // Cache present → modal gate.
    void (async () => {
      // Fetch estimate for modal copy; on any failure fall back to "unavailable".
      // Confirm button is a bare "Re-generate" — the ≈$ lives once, in the
      // consequence line directly above it (user decision: body + button
      // double-print was the last cost duplication).
      const confirmLabel = "Re-generate";
      // estUsdStr: the formatted string used in consequence lines — scoped so the
      // consequence builder can use it without re-calling .toFixed(2) on
      // archEstUsd (which is typed `number | null` and not narrowable here).
      let estUsdStr: string | null = null;
      let mayTruncate = false;
      try {
        const res = await fetch(`/api/repo-graph/arch/estimate?repo=${encodeURIComponent(repoHash)}`);
        const body = (await res.json()) as { success: boolean; data?: { estUsd: number; mayTruncate?: boolean } };
        if (body.success && body.data) {
          const usd = body.data.estUsd.toFixed(2);
          archEstUsd = body.data.estUsd;
          estUsdStr = usd;
          mayTruncate = body.data.mayTruncate === true;
          // Re-fetch to freshen a possibly-aged boot estimate before showing money
          // in the modal; this is a cheap deterministic endpoint with no Brain call.
          // Re-generate cost dedup — ≈$ is shown in the modal body below,
          // not on the button cost span. Button span keeps "Diagram is current".
          if (genCost) genCost.textContent = "Diagram is current";
        }
      } catch (e) {
        console.warn("[repoGraph] estimate fetch failed — modal shows unavailable", e);
      }
      // Modal body (per user decision), two lines:
      //   Line 1 (metadata): "Generated <age> ago [· <Xm Ys>]"
      //     — duration segment omitted when durationMs absent (legacy caches).
      //     grounded% deliberately NOT here: the header chip carries it and is
      //     on-screen above the open modal — same-screen duplication.
      //   Line 2 (consequence): freshness-aware replacement warning with cost.
      // Re-read generatedStale at this point (post-await) — it may have changed
      // if the payload was refreshed during the estimate fetch.
      const payload = generatedPayload; // snapshot after estimate await
      const metaParts: string[] = [];
      if (payload?.generatedTs) {
        const age = humanizeGeneratedAgo(payload.generatedTs);
        if (age) metaParts.push(`Generated ${age}`);
      }
      if (payload?.durationMs !== undefined) {
        // "took" prefix: a bare "6m 44s" beside "8m ago" reads ambiguous (user feedback).
        metaParts.push(`took ${humanizeDurationMs(payload.durationMs)}`);
      }
      if (payload?.costUsd !== undefined) {
        // Past spend, labeled "cost" — distinct from the FUTURE "≈$" estimate in
        // the consequence line below (user feedback: append last run's cost).
        metaParts.push(`cost $${payload.costUsd.toFixed(2)}`);
      }
      const metaLine = metaParts.length > 0 ? metaParts.join(" · ") : "";

      // Consequence line — fresh vs stale vs estimate-unavailable.
      const consequenceLine = estUsdStr === null
        ? "Re-generating will replace it (estimate unavailable)."
        : generatedStale
          ? `Code changed since last generation — re-generating ≈$${estUsdStr} will replace it.`
          : `Re-generating ≈$${estUsdStr} will replace it.`;

      // Advisory truncation line in the modal body — advisory only,
      // the Re-generate confirm stays enabled (never blocks).
      const baseLines = metaLine ? [metaLine, consequenceLine] : [consequenceLine];
      const bodyLines = mayTruncate ? [...baseLines, `⚠ ${ARCH_TRUNCATION_WARNING}`] : baseLines;
      const confirmed = await confirmModal({
        title: "Re-generate diagram?",
        bodyLines,
        confirmLabel,
        cancelLabel: "Cancel",
      });
      if (confirmed) {
        void runArchGenerate();
      }
    })();
  });
  // On load, attach to any detached generate still running from a prior visit.
  void reconnectArchTask();
  let c4Sel: string | null = null;

  function makeNode(n: SceneNode): HTMLElement {
    const d = document.createElement("div");
    const r = n.rect;
    Object.assign(d.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px" });
    if (n.kind === "subdir") {
      // Node-detail welded to "Detailed": always show purpose + ↓in/↑out aggregate.
      // Group color welded to "Full": always render the accent dot.
      const acc = groupOf(n.data.id).accent;
      const accDot = `<span class="nacc" style="background:${acc}"></span>`;
      const io = `<div class="nio"><span>↓ ${sum(inbound(n.data.id))} in</span><span>↑ ${sum(outbound(n.data.id))} out</span></div>`;
      d.className = "node kind-subdir";
      d.innerHTML =
        `<div class="ntop">${accDot}<span class="nname">${esc(subdirRoute(n.data.id))}</span><span class="nbadge" title="${n.data.files} files">${n.data.files}</span></div>` +
        `<div class="npurpose" title="${esc(n.data.purpose)}">${esc(n.data.purpose)}</div>${io}`;
    } else if (n.kind === "neighbor") {
      d.className = "node kind-subdir compact";
      const acc = groupOf(n.data.sub.id).accent;
      const accDot = `<span class="nacc" style="background:${acc}"></span>`;
      d.innerHTML = `<div class="ntop">${accDot}<span class="nname">${esc(n.data.sub.id)}/</span><span class="nbadge">${n.data.dir === "in" ? "→" : "←"}</span></div>`;
      d.style.height = r.h + "px";
    } else if (n.kind === "file") {
      d.className = "node kind-file";
      d.style.height = r.h + "px";
      const fsyms = symbolsFor(n.data.subId, n.data.file.path);
      const fdesc = fileDesc(n.data.subId, n.data.file.path) || n.data.file.desc;
      const explBadge = n.data.file.expl ? '<span class="nbadge expl" title="explanation cached · up to date">✦</span>' : "";
      d.innerHTML =
        `<div class="ntop"><span class="nname" title="${esc(n.data.file.path)}">${esc(n.data.label)}</span>${explBadge}</div>` +
        `<div class="npurpose" title="${esc(fdesc)}">${esc(fdesc)}</div>` +
        `<div class="ksub">${n.data.file.loc} loc · ${fsyms.length || n.data.file.symbols} symbols</div>`;
    } else if (n.kind === "symbol") {
      d.className = "node kind-symbol";
      d.style.height = r.h + "px";
      const sy = n.data.sym;
      d.innerHTML =
        `<div class="ntop"><span class="nname">${esc(sy.name)}</span><span class="nbadge">${esc(sy.kind)}</span></div>` +
        (sy.desc ? `<div class="npurpose" title="${esc(sy.desc)}">${esc(sy.desc)}</div>` : "") +
        `<div class="nsig" title="${esc(sy.sig)}">${esc(sy.sig)} · :${sy.line}</div>`;
    } else if (n.kind === "tmore") {
      // collapsed off-path overflow chip — expands inline on click (progressive
      // disclosure; nothing is hidden, just deferred).
      d.className = "node kind-trace ph-off ph-more";
      d.style.height = r.h + "px";
      d.innerHTML = `<div class="ntop"><span class="nname">+${n.data.hidden.length} more</span></div>`;
    } else {
      // trace node. Renders the ▶ entry marker plus the 🔗/⚠/⑂ badges + card.
      // English copy, matching the mockup + the shipped dashboard.
      const t = n.data.node;
      d.className =
        "node kind-trace" +
        (t.off ? " ph-off" : " ph-on") +
        (t.branchOf ? " ph-branch" : "") +
        (t.role === "entry" ? " ph-entry" : "") +
        (t.klass === "unresolvable" ? " ph-unres" : "");
      d.style.height = r.h + "px";
      const loc = t.path ? `${t.path}${t.line ? ":" + t.line : ""}` : "static analysis can't link this call";
      if (t.branchOf) {
        d.innerHTML =
          `<div class="ntop"><span class="nname">${esc(t.fn)}()</span><span class="ph-brtag">${esc(t.branch ?? "")}</span></div>` +
          `<div class="nsig" title="${esc(loc)}">${esc(loc)}</div>`;
      } else {
        // Badges: only the EXCEPTIONAL ⚠ (the one node with a drawn
        // unresolved tail — "path may continue past here") rides the graph node.
        // 🔗 shared is saturated on shared-infra traces (every cli node is reached
        // by another entrypoint) → it's pure decoration on the graph; that context
        // lives in the card chip instead.
        let badges = t.role === "entry" ? `<span class="ph-flag">▶ entry</span>` : "";
        if (!t.off && t.warn) {
          badges += `<span class="ph-bdg warn" title="Path may continue — an unresolved next step the static pass couldn't link">⚠</span>`;
        }
        d.innerHTML =
          `<div class="ntop"><span class="nname">${esc(t.fn)}()</span>${badges}</div>` +
          `<div class="nsig" title="${esc(loc)}">${esc(loc)}</div>`;
      }
    }
    if (n.id === S.selected) d.classList.add("sel");
    d.dataset.id = n.id;
    d.addEventListener("mouseenter", () => {
      if (!dragMoved) focusNode(n.id);
    });
    d.addEventListener("mouseleave", () => {
      if (!dragMoved) focusNode(S.selected);
    });
    d.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!dragMoved) void onNodeClick(n);
    });
    return d;
  }

  // ── click routing (port of app.js onNodeClick) ─────────────────────────────
  // Two-click drill: 1st click selects (opens panel), 2nd click on the same
  // node drills a level deeper. Neighbor cards jump straight to that subdir.
  async function onNodeClick(n: SceneNode): Promise<void> {
    if (S.level === "arch") {
      if (n.kind === "subdir") {
        if (S.selected === n.id) await drillToFile(n.id);
        else {
          await ensureFiles(n.id);
          select(n.id);
        }
      }
    } else if (S.level === "file") {
      if (n.kind === "file") {
        if (S.selected === n.id) await drillToSymbol(n.data.subId, n.data.file.path);
        else {
          await ensureSymbols(n.data.subId, n.data.file.path);
          select(n.id);
        }
      } else if (n.kind === "neighbor") {
        await drillToFile(n.data.sub.id);
      }
    } else if (S.level === "symbol") {
      if (n.kind === "symbol") select(n.id);
    } else if (S.level === "trace") {
      if (n.kind === "tmore") {
        S.trace.expanded.add(n.data.parent);
        render(false);
      } else if (n.kind === "trace") {
        // Selecting a spine node reveals ITS off-path callees (on-demand cluster)
        // and opens the node card; selecting an off node keeps its parent's
        // cluster open; the unresolvable tail clears it.
        const t = n.data.node;
        const wasOpen = panelEl?.classList.contains("open") ?? false;
        S.selected = n.id;
        if (t.off) S.trace.offFor = t.off;
        else if (S.trace.data?.spine.includes(n.id)) S.trace.offFor = n.id;
        else S.trace.offFor = null;
        render(false);
        focusNode(n.id);
        openTracePanel(n.id);
        // Re-center ONLY when the panel just opened (the gap narrows). Selecting a
        // different spine node must NOT refit: the off-path cluster docks at a fixed
        // x in the reserved left gap, so the spine stays put — re-fitting per node
        // makes the graph jump around while you walk the path. Solved on
        // ENTER instead (phEnter frames with the entry's cluster already shown).
        if (!wasOpen) refitTrace();
      }
    }
  }

  function select(id: string): void {
    S.selected = id;
    render(false);
    openPanel(id);
  }

  async function drillToFile(subId: string): Promise<void> {
    await ensureFiles(subId);
    S.level = "file";
    S.subId = subId;
    S.file = null;
    S.selected = null;
    S.memberFilter = null; // bucket door — member filter never leaks across drills
    S.memberBuckets = null;
    S.memberTitle = null;
    render(true);
    closePanel();
  }

  /** Open the file scene filtered to a generated
   * container's OWN members. Buckets resolve through the SAME exported
   * keyspace fn the server uses (bucketIdOfPath, no re-fork); members
   * whose path no bucket claims simply can't render (honest thinner door). */
  async function drillToMembers(n: C4Node): Promise<void> {
    const memberFiles = n.memberFiles ?? [];
    if (memberFiles.length === 0) return;
    const withPath = (proj.subdirs ?? []).filter(
      (sd): sd is typeof sd & { path: string } => typeof sd.path === "string" && sd.path.length > 0,
    );
    let buckets = [...new Set(
      memberFiles
        .map((f) => bucketIdOfPath(withPath, f))
        .filter((b): b is string => b !== null),
    )];
    if (buckets.length === 0 && n.drillTo) buckets = [n.drillTo];
    if (buckets.length === 0) {
      // Honest boundary: members exist but no projection bucket claims them
      // (index↔model keyspace disagreement). Door can't open; leave a signal.
      console.warn("[repoGraph] member door: no bucket claims any member of", n.title);
      return;
    }
    await Promise.all(buckets.map((b) => ensureFiles(b)));
    S.level = "file";
    S.subId = buckets[0]!; // primary bucket drives the neighbor columns (bucket-scoped v1)
    S.memberBuckets = buckets;
    S.memberFilter = new Set(memberFiles);
    S.memberTitle = n.title;
    S.file = null;
    S.selected = null;
    render(true);
    closePanel();
  }

  async function drillToSymbol(subId: string, file: string, highlight?: string): Promise<void> {
    await ensureSymbols(subId, file);
    // 0-symbol files (e.g. pure test files) have no symbol canvas — never drill
    // in. Land on the file scene with the file selected so the sidebar carries
    // the "no exported symbols" explanation instead of an empty symbol level.
    // This guard covers every entry point: in-scene 2nd-click, subdir filelist
    // rows, and search-result jumps.
    if (symbolsFor(subId, file).length === 0) {
      if (S.level === "file" && S.subId === subId) {
        select("f:" + file);
      } else {
        await ensureFiles(subId);
        // member state intentionally PRESERVED: landing back on the file level
        // from inside a member door stays inside that door — this is the one
        // transition that keeps the filter on purpose.
        S.level = "file";
        S.subId = subId;
        S.file = null;
        S.selected = "f:" + file;
        render(true);
        openPanel("f:" + file);
      }
      return;
    }
    S.level = "symbol";
    S.subId = subId;
    S.file = file;
    S.selected = null;
    render(true);
    if (highlight) {
      S.selected = "s:" + highlight;
      render(false);
      openPanel(S.selected);
    } else {
      closePanel();
    }
  }

  function goArch(): void {
    const wasTrace = S.level === "trace";
    S.level = "arch";
    S.memberFilter = null;
    S.memberBuckets = null;
    S.memberTitle = null;
    S.subId = null;
    S.file = null;
    S.selected = null;
    if (wasTrace) {
      // Leave trace mode cleanly: restore the normal toolbar, drop the legend +
      // any open overlays + the red-coverage fallback so nothing is left stuck.
      root.classList.remove("ph-active-bar");
      S.trace.offFor = null;
      phCloseOverlays();
      removePhLegend();
      clearTraceFallback();
      phSyncBar();
    }
    render(true);
    closePanel();
  }

  // ── side panel (port of app.js openPanel + sub/file/symbol panels) ─────────
  function closePanel(): void {
    panelEl?.classList.remove("open");
    publishViewed(null, "");
  }

  /**
   * Bridge (pull model) — publish the node the user is currently
   * viewing to a window global the floating chat reads when pinning a new
   * conversation. A DESCRIPTOR ({name, path}) not a render id — the backend
   * resolves it (option b), so this never couples to the graph id format. Pull
   * model (a plain global, no addEventListener) deliberately sidesteps the
   * hx-boost morph listener-drop pitfall. Cleared on closePanel / drill.
   */
  function publishViewed(
    target: { name: string; path: string; node_type?: string } | null,
    label: string,
  ): void {
    if (typeof window === "undefined") return;
    (window as unknown as { __siltpokeViewedNode?: unknown }).__siltpokeViewedNode = target
      ? { target, projHash: repoHash, label }
      : null;
    // fire the bridge event so the floating chat (a separate, hx-preserved
    // island) re-renders — the window global alone isn't Alpine-reactive.
    window.dispatchEvent(new CustomEvent("siltpoke:viewed-changed"));
  }

  /**
   * Reverse bridge (chat → graph). The chat island calls this
   * when the user clicks "↩ go to node" on a pinned conversation. It navigates
   * the graph to the anchor target and focuses the node.
   *
   * Accepts a ViewedNode target (either node_id or descriptor form) and returns
   * true if the node was found and focused, false if not in the current graph
   * (forward-compat: caller can use the boolean for the dead-anchor state).
   *
   * Pull model (exposed on window.__siltpokeFocusNode) — same philosophy as
   * publishViewed. Re-registered on every bootRepoGraph call so hx-boost
   * re-mounts always get the fresh closure's state.
   */
  async function focusNodeFromChat(
    target: { node_id: string } | { name: string; path: string; node_type?: string },
  ): Promise<boolean> {
    if ("node_id" in target) {
      // A rehydrated conv stores the server canonical node_id
      // (`type:path:name`) as anchorNodeId. Decode it first — if it's in
      // canonical form, route through the descriptor branch which works at all
      // levels (subdir / file / symbol). Only fall through to the trace-node
      // path when decoding returns null (genuine trace-graph-internal id).
      const decoded = decodeCanonicalNodeId(target.node_id);
      if (decoded !== null) {
        return focusNodeFromChat(decoded);
      }
      // True trace-level node id — only navigable when the graph is in trace mode.
      if (S.level !== "trace") return false;
      const traceNode = S.trace.data?.nodes.find((n) => n.id === target.node_id);
      if (!traceNode) return false;
      S.selected = target.node_id;
      render(false);
      focusNode(target.node_id);
      openTracePanel(target.node_id);
      fit();
      return true;
    }

    // Descriptor form: {name, path, node_type?}
    const { name, path: filePath, node_type } = target;
    const subdirList = (proj.subdirs ?? []).filter(
      (sd): sd is typeof sd & { path: string } => typeof sd.path === "string" && sd.path.length > 0,
    );
    const subId = bucketIdOfPath(subdirList, filePath);

    if (node_type === "file" || (!node_type && filePath)) {
      // File node — all async work BEFORE any state mutation to avoid the
      // render-race between the two awaits.
      if (!subId) return false;
      await ensureFiles(subId);
      const fileExists = filesFor(subId).some((f) => f.path === filePath);
      if (!fileExists) return false;
      // Load symbols now (cache-first, fast-path if already warm) so the file
      // panel's symbol list is populated when openPanel fires.
      await ensureSymbols(subId, filePath);
      // Navigate to file level if not already there for this subdir.
      if (S.level !== "file" || S.subId !== subId) {
        S.level = "file";
        S.subId = subId;
        S.file = null;
        S.selected = null;
        S.memberFilter = null;
        S.memberBuckets = null;
        S.memberTitle = null;
        render(true);
        closePanel();
      }
      const nodeId = "f:" + filePath;
      S.selected = nodeId;
      render(false);
      openPanel(nodeId);
      focusNode(nodeId);
      fit();
      return true;
    }

    if (node_type === "function" || node_type === "fn") {
      // Symbol node — all async work before state mutation (same race fix).
      if (!subId) return false;
      await ensureFiles(subId);
      const fileRec = filesFor(subId).find((f) => f.path === filePath);
      if (!fileRec) return false;
      await ensureSymbols(subId, filePath);
      const sym = symbolsFor(subId, filePath).find((s) => s.name === name);
      if (!sym) return false;
      // Navigate to symbol level.
      if (S.level !== "symbol" || S.subId !== subId || S.file !== filePath) {
        S.level = "symbol";
        S.subId = subId;
        S.file = filePath;
        S.selected = null;
        render(true);
        closePanel();
      }
      const nodeId = "s:" + name;
      S.selected = nodeId;
      render(false);
      openPanel(nodeId);
      focusNode(nodeId);
      fit();
      return true;
    }

    return false;
  }

  if (typeof window !== "undefined") {
    (window as unknown as { __siltpokeFocusNode?: unknown }).__siltpokeFocusNode = focusNodeFromChat;
    // Fire the viewed-changed bridge event so the floating-chat island
    // re-evaluates canReturnToNode() — it reads window.__siltpokeFocusNode
    // synchronously but Alpine won't re-render until a tracked reactive value
    // changes; the event triggers syncViewed() which updates `this.viewed` and
    // forces a re-render. This ensures the ↩ button appears after hx-boost nav
    // to the /repo-graph page without requiring the user to interact first.
    window.dispatchEvent(new CustomEvent("siltpoke:viewed-changed"));
  }

  function section(title: string, count: number | "", inner: string, hint?: string): string {
    return `<div class="p-sec"><h4>${esc(title)}${count !== "" ? `<span class="ct">${count}</span>` : ""}</h4>${hint ? `<div class="p-hint">${hint}</div>` : ""}${inner}</div>`;
  }

  function impSection(title: string, list: Neighbor[], dir: "in" | "out", hint: string): string {
    if (!list.length) return section(title, 0, `<div style="font-family:var(--mono);font-size:11px;color:var(--ink3)">none</div>`, hint);
    const max = Math.max(...list.map((x) => x.w));
    const rows = list
      .slice(0, 5)
      .map((x) => {
        const lvl = x.w > 15 ? "heavily coupled" : x.w >= 8 ? "moderately coupled" : "lightly coupled";
        return `<div class="improw" title="${x.w} import statement${x.w > 1 ? "s" : ""} — ${lvl}"><span class="ar">${dir === "in" ? "↓" : "→"}</span><span class="im-name" data-nav="${esc(x.id)}">${esc(x.id)}</span><span class="bar"><i class="${x.w > 15 ? "strong" : ""}" style="width:${Math.round((x.w / max) * 100)}%"></i></span><span class="w">${x.w}<span class="wu"> imp</span></span></div>`;
      })
      .join("");
    return section(title, list.length, `<div class="imps">${rows}</div>`, hint);
  }

  // ── explain lifecycle — panel foot 3-state button + modal ──────────────────
  // state ∈ none/valid/stale drives the button
  // label + data-act + the modal's freshly-generated/from-cache tag. Explain
  // applies to FILE and SYMBOL scopes only — never a subdir (the backend
  // explains a node, not a directory).
  type ExplState = "none" | "valid" | "stale";
  interface ExplScope {
    kind: "file" | "symbol";
    state: ExplState;
    /** resolveTarget-friendly POST target (path | path:symbol). */
    target: string;
    /** node-id GET target for the cache-state read (file:<path>: | <kind>:<path>:<name>). */
    getTarget: string;
    title: string;
    /** subdir whose file cache to invalidate after a fresh generate. */
    subId: string;
    /** The symbol's kind (function/class/…), so attachSymTraceBtn can tell a
     * function whose file path didn't resolve (getTarget="") from a non-function
     * symbol — the former earns an honest "can't trace" note, not a silent gap. */
    symKind?: string;
  }

  // Footer HTML for the file/symbol panel. The click handler branches on
  // `data-act` ("open"|"gen") — NOT the label text.
  function explBtn(scope: ExplScope): string {
    let label: string;
    let note: string;
    if (scope.state === "valid") {
      label = "Open explanation";
      note = '<span class="ok">✓ cached</span> · up to date with the code';
    } else if (scope.state === "stale") {
      label = "Re-generate explanation";
      note = '<span class="warn">↻ code changed</span> · cached copy was cleared';
    } else {
      label = "Generate explanation";
      note = '<span class="muted">not generated yet · runs /siltpoke-explain</span>';
    }
    const act = scope.state === "valid" ? "open" : "gen";
    return `<a class="btn primary" id="rg-expl-btn" data-act="${act}">${label} <span class="arrow">→</span></a><div class="p-note">${note}</div>`;
  }

  // Bind the explain button — #rg-expl-btn is recreated on every panel/foot
  // render, so the handler MUST be rebound each time. Decision
  // open-vs-generate reads data-act.
  function bindExplBtn(scope: ExplScope): void {
    const btn = root.querySelector<HTMLElement>("#rg-expl-btn");
    if (!btn) return;
    btn.onclick = () => {
      if (btn.dataset.act === "open") void openExplain(scope, false);
      else void generateExplain(scope, btn);
    };
  }

  function renderFoot(scope: ExplScope): void {
    if (!pFoot) return;
    pFoot.innerHTML = explBtn(scope);
    bindExplBtn(scope);
    attachSymTraceBtn(scope);
    // Symbol state isn't carried in /files — read it, then re-render the foot.
    if (scope.kind === "symbol") void refreshSymbolState(scope);
  }

  // The symbol foot gets repainted by renderFoot /
  // refreshSymbolState / generateExplain — each resets `pFoot.innerHTML`, which
  // would clobber a one-time-appended button. So re-attach the "⟜ Trace from
  // here" button after EVERY foot repaint. Gated to function symbols;
  // `scope.getTarget` is the canonical `function:path:name` node id.
  function attachSymTraceBtn(scope: ExplScope): void {
    if (!pFoot) return;
    const affordance = symTraceAffordance(scope);
    if (affordance === "button") {
      const rawNodeId = scope.getTarget;
      const traceBtn = document.createElement("button");
      traceBtn.className = "btn ph-trace";
      traceBtn.id = "rg-sym-trace-btn";
      traceBtn.innerHTML = `<span class="ph-trace-icon">⟜</span> Trace from here`;
      pFoot.appendChild(traceBtn);
      traceBtn.onclick = () => void phTraceFromNode(rawNodeId);
      return;
    }
    // A function symbol whose file path didn't resolve (getTarget="") would
    // otherwise vanish silently — no button, no reason, indistinguishable from an
    // untraceable symbol. Surface an honest, INERT note (no click handler — never
    // a dead no-op). Non-function symbols still get nothing (correct).
    if (affordance === "note") {
      const note = document.createElement("div");
      note.className = "ph-trace-na";
      note.id = "rg-sym-trace-na";
      note.innerHTML = `<span class="ph-trace-icon">⟜</span> Can't trace — this symbol's file path didn't resolve`;
      pFoot.appendChild(note);
    }
  }

  async function refreshSymbolState(scope: ExplScope): Promise<void> {
    try {
      const res = await fetch(withRepo(`/api/repo-graph/explain?target=${encodeURIComponent(scope.getTarget)}`));
      if (!res.ok) return;
      const body = (await res.json()) as { data: { state: ExplState } };
      scope.state = body.data.state;
      if (pFoot) {
        pFoot.innerHTML = explBtn(scope);
        bindExplBtn(scope);
        attachSymTraceBtn(scope);
      }
    } catch {
      /* keep the optimistic foot */
    }
  }

  // none/stale → generate. Spinner shows until the POST resolves; try/finally
  // GUARANTEES the button leaves the spinner even on error (no dead spin).
  async function generateExplain(scope: ExplScope, btn: HTMLElement): Promise<void> {
    btn.classList.add("gening");
    btn.innerHTML = '<span class="spin"></span> Analyzing subgraph…';
    btn.style.pointerEvents = "none";
    let ok = false;
    try {
      ok = await openExplain(scope, true);
    } finally {
      if (ok) {
        // Cache now warm: flip the foot to ✓ cached + invalidate the file cache
        // so the ✦ badge re-derives from live state on next render.
        scope.state = "valid";
        filesCache.delete(scope.subId);
        if (pFoot) {
          pFoot.innerHTML = explBtn(scope);
          bindExplBtn(scope);
          attachSymTraceBtn(scope);
        }
        if (S.level === "file" && S.subId === scope.subId) {
          await ensureFiles(scope.subId);
          render(false);
        }
      } else if (pFoot) {
        // Failed: restore the button out of the spinner — never leave it dead.
        pFoot.innerHTML = explBtn(scope);
        bindExplBtn(scope);
        attachSymTraceBtn(scope);
      }
    }
  }

  function chips(list: Neighbor[], dir: "in" | "out"): string {
    if (!list.length) return `<span class="ex-chip" style="color:var(--ink3)">none</span>`;
    return list
      .slice(0, 6)
      .map((x) => `<span class="ex-chip"><span class="ar">${dir === "in" ? "↓" : "→"}</span><b>${esc(x.id)}</b> ${x.w}</span>`)
      .join("");
  }

  interface ExplanationData {
    target: string;
    route: string;
    title: string;
    grounded: number;
    fresh: boolean;
    lead: string;
    dependsOn: Array<{ id: string; weight: number }>;
    usedBy: Array<{ id: string; weight: number }>;
    citations: Array<{ ref: string; text: string }>;
  }

  function bindModalClose(): void {
    exModal?.querySelector<HTMLElement>("#rg-ex-close")?.addEventListener("click", closeExplain);
  }

  // `fresh` is the CLIENT's action verdict (generate → true, open-cache →
  // false) — deterministic regardless of the API flag (also fixed server-side).
  function renderModal(d: ExplanationData, fresh: boolean): void {
    if (!exModal) return;
    const depends: Neighbor[] = d.dependsOn.map((x) => ({ id: x.id, w: x.weight }));
    const used: Neighbor[] = d.usedBy.map((x) => ({ id: x.id, w: x.weight }));
    exModal.innerHTML =
      `<div class="ex-head"><div class="ex-route"><span>/siltpoke-explain</span><span class="rt">${esc(d.target)}</span><button class="xx" id="rg-ex-close">×</button></div>` +
      `<div class="ex-title">${esc(d.title)}</div>` +
      `<span class="ex-guard"><span class="gck"></span>evidence-guard · ${Math.round((d.grounded ?? 0) * 100)}% grounded · ${fresh ? "freshly generated" : "from cache"}</span></div>` +
      `<div class="ex-body"><p class="ex-lead">${esc(d.lead)}</p>` +
      `<div class="ex-sec"><h5>Depends on (outbound imports)</h5><div class="ex-chips">${chips(depends, "out")}</div></div>` +
      `<div class="ex-sec"><h5>Used by (inbound imports)</h5><div class="ex-chips">${chips(used, "in")}</div></div>` +
      (d.citations.length
        ? `<div class="ex-sec"><h5>Evidence — grounded citations</h5><div class="ex-ev">${d.citations
            .map((cn) => `<div class="ex-evrow"><span class="ln">[${esc(cn.ref)}]</span> ${esc(cn.text)}</div>`)
            .join("")}</div></div>`
        : "") +
      `</div>` +
      `<div class="ex-foot">Assembled from the structural index · Brain call + evidence guard + cache</div>`;
    bindModalClose();
  }

  function modalShell(title: string, route: string, bodyHtml: string): string {
    return (
      `<div class="ex-head"><div class="ex-route"><span>/siltpoke-explain</span><span class="rt">${esc(route)}</span><button class="xx" id="rg-ex-close">×</button></div>` +
      `<div class="ex-title">${esc(title)}</div></div><div class="ex-body">${bodyHtml}</div>`
    );
  }

  function closeExplain(): void {
    exOverlay?.classList.remove("open");
  }

  // POST the explain run + render the modal. fresh = client action verdict.
  // Returns true on success (cache now warm).
  async function openExplain(scope: ExplScope, fresh: boolean): Promise<boolean> {
    if (!exOverlay || !exModal) return false;
    exOverlay.classList.add("open");
    exModal.innerHTML = modalShell(
      scope.title,
      scope.target,
      `<div style="padding:18px;font-family:var(--mono);font-size:12px;color:var(--ink3)"><span class="spin"></span> Analyzing subgraph…</div>`,
    );
    bindModalClose();
    const note = (msg: string): boolean => {
      exModal!.innerHTML = modalShell(scope.title, scope.target, `<p class="ex-lead">${esc(msg)}</p>`);
      bindModalClose();
      return false;
    };
    // Explain is DETACHED — POST returns {taskId}; observe via
    // GET /arch/task, then fetch the built Explanation from GET /explain/result.
    const showResult = async (): Promise<boolean> => {
      const r = await fetch(withRepo(`/api/repo-graph/explain/result?target=${encodeURIComponent(scope.target)}&fresh=${fresh ? "true" : "false"}`));
      if (!r.ok) return note("No explanation available for this scope.");
      const body = (await r.json()) as { data: ExplanationData };
      renderModal(body.data, fresh);
      return true;
    };
    try {
      const res = await fetch("/api/repo-graph/explain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: scope.target, repo: repoHash, force: scope.state === "stale" }),
      });
      if (res.status === 409) return note("Another task is running — try again in a moment.");
      const body = (await res.json()) as { taskId?: string; error?: string };
      if (!res.ok || !body.taskId) return note(body.error ?? "Explanation unavailable for this scope.");
      const { status } = await pollArchTaskTerminal(body.taskId, () => {});
      if (status === "done") return await showResult();
      return note(
        status === "crashed" ? "Explain timed out / killed — retry."
          : status === "cancelled" ? "Explain cancelled — retry."
          : "Explain failed — retry.",
      );
    } catch {
      return note("Explain request failed — is the daemon reachable?");
    }
  }

  // Subdir module overview — structural, instant, no Brain/cache. Route +
  // title are ALWAYS src/<subdir>/ (never a file name — that was the old bug).
  // Evidence samples SOURCE files only (tests filtered by the source-first sort
  // + the slice below skipping any *.test.*).
  async function openModuleOverview(sub: Subdir): Promise<void> {
    if (!exOverlay || !exModal) return;
    const route = subdirRoute(sub.id);
    exOverlay.classList.add("open");
    exModal.innerHTML = modalShell(
      route,
      route,
      `<div style="padding:18px;font-family:var(--mono);font-size:12px;color:var(--ink3)"><span class="spin"></span> Assembling module overview…</div>`,
    );
    bindModalClose();
    // Sample a few SOURCE files for [file:line] evidence (skip tests).
    const sources = filesFor(sub.id).filter((f) => !isTestFile(f.name)).slice(0, 3);
    const evidence: Array<{ ref: string; text: string }> = [];
    for (const f of sources) {
      await ensureSymbols(sub.id, f.path);
      for (const s of symbolsFor(sub.id, f.path).slice(0, 2)) {
        evidence.push({ ref: `${f.path}:${s.line}`, text: `${s.name} · ${s.sig || s.kind}` });
        if (evidence.length >= 6) break;
      }
      if (evidence.length >= 6) break;
    }
    const out = outbound(sub.id);
    const inb = inbound(sub.id);
    const guard = `module overview · structural · ${sources.length} source file${sources.length === 1 ? "" : "s"}`;
    exModal.innerHTML =
      `<div class="ex-head"><div class="ex-route"><span>/siltpoke-explain</span><span class="rt">${esc(route)}</span><button class="xx" id="rg-ex-close">×</button></div>` +
      `<div class="ex-title">${esc(route)}</div>` +
      `<span class="ex-guard"><span class="gck"></span>${esc(guard)}</span></div>` +
      `<div class="ex-body"><p class="ex-lead">${esc(sub.purpose || "—")}</p>` +
      `<div class="ex-sec"><h5>Depends on (outbound imports)</h5><div class="ex-chips">${chips(out, "out")}</div></div>` +
      `<div class="ex-sec"><h5>Used by (inbound imports)</h5><div class="ex-chips">${chips(inb, "in")}</div></div>` +
      (evidence.length
        ? `<div class="ex-sec"><h5>Evidence — source symbols</h5><div class="ex-ev">${evidence
            .map((e) => `<div class="ex-evrow"><span class="ln">[${esc(e.ref)}]</span> ${esc(e.text)}</div>`)
            .join("")}</div></div>`
        : "") +
      `</div>` +
      `<div class="ex-foot">Assembled from the structural index — no Brain call</div>`;
    bindModalClose();
  }

  function openPanel(id: string): void {
    const node = SCENE?.nodes.find((n) => n.id === id);
    if (!node) {
      closePanel();
      return;
    }
    if (node.kind === "subdir") openSubdirPanel(node.data);
    else if (node.kind === "neighbor") openSubdirPanel(node.data.sub);
    else if (node.kind === "file") openFilePanel(node.data.subId, node.data.file);
    else if (node.kind === "symbol") openSymbolPanel(node.data.sym);
    else if (node.kind === "trace") openTracePanel(node.id);
    // tmore (the "+N more" chip) has no card.
  }

  function openSubdirPanel(sub: Subdir): void {
    if (!panelEl || !pHead || !pBody || !pFoot) return;
    const g = groupOf(sub.id);
    const inb = inbound(sub.id);
    const out = outbound(sub.id);
    const files = filesFor(sub.id);
    pHead.innerHTML =
      `<div class="p-eyebrow"><span class="gd" style="background:${g.accent}"></span>${esc(g.title)}<button class="p-close" id="rg-pclose">×</button></div>` +
      `<div class="p-title">${esc(subdirRoute(sub.id))}</div><div class="p-purpose">${esc(sub.purpose)}</div>`;
    pBody.innerHTML =
      section(
        "Files",
        sub.files,
        `<div class="filelist">${files
          .map((f) => `<div class="filerow" data-file="${esc(f.path)}"><span class="fdot ${f.expl ? "" : "off"}"></span><span class="fn">${esc(f.name)}</span><span class="fl">${f.loc} loc</span></div>`)
          .join("")}</div>`,
      ) +
      impSection("Imports", out, "out", "What " + esc(subdirRoute(sub.id)) + " depends on. The number = how many <b>import statements</b> point at each — higher means a tighter dependency.") +
      impSection("Imported by", inb, "in", "What depends on " + esc(subdirRoute(sub.id)) + " — higher means more of the codebase relies on it.");
    // Subdir scope = a structural MODULE OVERVIEW, not a Brain explanation:
    // authored purpose + aggregated imports + source-file evidence, assembled
    // client-side. No fake spinner/cache (the prototype's were localStorage
    // illusions). The backend can't explain a directory — a real dir-scope
    // Brain run is a deferred follow-up. Title/route stay src/<subdir>/ always.
    if (pFoot) {
      pFoot.innerHTML =
        `<a class="btn primary" id="rg-module-btn">Open module overview <span class="arrow">→</span></a>` +
        `<div class="p-note"><span class="muted">structural · authored purpose + imports + source evidence</span></div>`;
      const mbtn = root.querySelector<HTMLElement>("#rg-module-btn");
      if (mbtn) mbtn.onclick = () => void openModuleOverview(sub);
    }
    panelEl.classList.add("open");
    publishViewed(null, ""); // a subdir is not an anchorable node (only function/file are)
    wirePanelRows(sub.id);
  }

  function openFilePanel(subId: string, file: FileRec): void {
    if (!panelEl || !pHead || !pBody || !pFoot) return;
    const g = groupOf(subId);
    const syms = symbolsFor(subId, file.path);
    const fdesc = fileDesc(subId, file.path) || file.desc;
    pHead.innerHTML =
      `<div class="p-eyebrow"><span class="gd" style="background:${g.accent}"></span>${esc(subdirRoute(subId))}<button class="p-close" id="rg-pclose">×</button></div>` +
      `<div class="p-title">${esc(file.name)}</div><div class="p-purpose">${esc(fdesc)}</div>` +
      `<div class="p-meta">${file.loc} lines · ${syms.length} symbols</div>`;
    if (syms.length === 0) {
      // No exported symbols (commonly a pure test file): no symbol level to drill
      // into. Explain the empty state in the sidebar instead of an empty section.
      const isTest = /\.(test|spec)\.[cm]?[jt]sx?$/.test(file.name) || /(^|\/)__tests__\//.test(file.path);
      pBody.innerHTML = section(
        "Symbols",
        0,
        `<div class="p-empty">no exported symbols · ${file.loc} lines${isTest ? ' · <span class="symk">test file</span>' : ""}</div>`,
      );
    } else {
      pBody.innerHTML = section(
        "Symbols",
        syms.length,
        `<div class="symlist">${syms
          .map(
            (s) =>
              `<div class="symrow" data-sym="${esc(s.name)}"><div class="symtop"><span class="fn">${esc(s.name)}</span><span class="symk">${esc(s.kind)}</span><span class="fl">:${s.line}</span></div>` +
              (s.desc ? `<div class="symdesc">${esc(s.desc)}</div>` : "") +
              (s.sig ? `<div class="symsig">${esc(s.sig)}</div>` : "") +
              `</div>`,
          )
          .join("")}</div>`,
        "Click a symbol to open it at symbol level.",
      );
    }
    renderFoot({
      kind: "file",
      state: file.explainState,
      target: file.path,
      getTarget: `file:${file.path}:`,
      title: file.name,
      subId,
    });
    panelEl.classList.add("open");
    publishViewed({ name: file.name, path: file.path, node_type: "file" }, file.name);
    pBody.querySelectorAll<HTMLElement>(".symrow[data-sym]").forEach((row) => {
      row.onclick = () => void drillToSymbol(subId, file.path, row.dataset.sym);
    });
    wireClose();
  }

  function openSymbolPanel(sym: SymRec): void {
    if (!panelEl || !pHead || !pBody || !pFoot) return;
    const g = groupOf(S.subId ?? "");
    pHead.innerHTML =
      `<div class="p-eyebrow"><span class="gd" style="background:${g.accent}"></span>${esc(subdirRoute(S.subId ?? ""))}${esc((S.file ?? "").split("/").pop() ?? "")}<button class="p-close" id="rg-pclose">×</button></div>` +
      `<div class="p-title">${esc(sym.name)}</div><div class="p-purpose">${esc(sym.desc || sym.kind)}</div><div class="p-meta">${esc(sym.kind)}</div>`;
    pBody.innerHTML =
      section("Signature", "", `<div class="p-sig">${esc(sym.sig || "—")}</div>`) +
      section("Location", "", `<div class="p-sig">${esc(subdirRoute(S.subId ?? ""))}${esc((S.file ?? "").split("/").pop() ?? "")}<b style="color:var(--ink)">:${sym.line}</b></div>`);
    const symPath = filesFor(S.subId ?? "").find((f) => f.path === S.file)?.path ?? "";
    renderFoot({
      kind: "symbol",
      state: "none",
      target: symPath ? `${symPath}:${sym.name}` : sym.name,
      getTarget: symPath ? `${sym.kind}:${symPath}:${sym.name}` : "",
      title: sym.name,
      subId: S.subId ?? "",
      symKind: sym.kind,
    });
    // "⟜ Trace from here" is attached by renderFoot → attachSymTraceBtn
    // so it survives the async refreshSymbolState foot repaint.
    panelEl.classList.add("open");
    // Use S.file (the file path drilled into) directly — the `symPath` filesFor
    // lookup above can miss when FileRec.path isn't the full repo-relative path,
    // which would silently leave the chat unanchored on a real symbol select.
    // S.file is set canonically by drillToSymbol.
    const anchorPath = S.file ?? "";
    // Include node_type so focusNodeFromChat routes to the
    // symbol branch (not the file-fallback). sym.kind matches graph node types
    // (e.g. "function", "class") — the same values the descriptor branch checks.
    if (anchorPath) publishViewed({ name: sym.name, path: anchorPath, node_type: sym.kind }, sym.name);
    else publishViewed(null, "");
    wireClose();
  }

  // ── Trace node card + grounded-purpose generate lifecycle ───
  function traceClass(t: TraceNodeData): { klass: string; label: string } {
    if (t.klass === "unresolvable") return { klass: "unresolvable", label: "dynamic · static can't see the next step" };
    if (t.role === "entry") return { klass: "entry", label: "entry · resolved" };
    return { klass: "resolved", label: "resolved call" };
  }

  function offParentFn(parentId: string | undefined): string {
    return S.trace.data?.nodes.find((n) => n.id === parentId)?.fn ?? parentId ?? "";
  }

  // Stepper: the walkable hops = spine + the unresolvable tail(s).
  function traceWalk(): string[] {
    const data = S.trace.data;
    if (!data) return [];
    const tails = data.nodes.filter((n) => n.tailOf).map((n) => n.id);
    return [...data.spine, ...tails];
  }

  function phStepBtns(nodeId: string): string {
    const walk = traceWalk();
    const i = walk.indexOf(nodeId);
    if (i < 0) return ""; // off-path / branch nodes aren't on the walk
    return (
      `<span class="ph-step" title="Previous / next hop along the call path">` +
      `<button class="ph-stb" data-step="prev" ${i === 0 ? "disabled" : ""} aria-label="Previous hop">▲</button>` +
      `<button class="ph-stb" data-step="next" ${i === walk.length - 1 ? "disabled" : ""} aria-label="Next hop">▼</button></span>`
    );
  }

  function phStep(dir: number): void {
    const walk = traceWalk();
    let i = walk.indexOf(S.selected ?? "");
    if (i < 0) i = 0;
    i = Math.max(0, Math.min(walk.length - 1, i + dir));
    const id = walk[i];
    if (!id) return;
    S.selected = id;
    S.trace.offFor = S.trace.data?.spine.includes(id) ? id : null;
    render(false);
    focusNode(id);
    openTracePanel(id);
    // No refit while walking — the spine is fixed in world coords and the
    // off-path cluster swaps in the reserved left gap, so re-centering per hop
    // would make the graph jump around. Frame is set once on trace enter.
  }

  // Purpose field — progressive disclosure: JSDoc (free) → empty + ✨ button →
  // loading → grounded sentence + cite → Brain-unavailable error + retry.
  function phPurpose(t: TraceNodeData): string {
    const g = S.trace.gen[t.id];
    if (t.purpose.src === "jsdoc") {
      return `<div class="ph-val">${esc(t.purpose.text ?? "")}</div><div class="ph-hint">Source: code comment (JSDoc) · free</div>`;
    }
    if (g?.state === "done" && g.text) {
      return `<div class="ph-val gen"><span class="ph-spark">✨</span> ${esc(g.text)}<div class="ph-cite">grounded · <a>${esc(g.cite ?? "")}</a> · cached</div></div>`;
    }
    if (g?.state === "loading") {
      return `<div class="ph-val loading"><span class="ph-spin"></span> siltpoke is reading this function…</div><div class="ph-hint">Read the source → produce one grounded sentence → cache it. Counts once.</div>`;
    }
    if (g?.state === "error") {
      return `<div class="ph-err"><b>⚠ Brain unavailable</b><div class="ph-er">${esc(g.error ?? "unknown error")}</div><button class="ph-genbtn" data-gen="${esc(t.id)}">↻ Retry</button></div>`;
    }
    const isU = t.purpose.src === "unresolvable";
    const empty = isU
      ? "There IS a next step, but static analysis can't tell who — so it won't guess for you"
      : "no comment — null";
    const hint = isU
      ? "Dynamic call — static analysis can't link it. Click to let siltpoke read the actual code and give you one sourced sentence with a file:line citation."
      : "Click → siltpoke reads this function, produces one grounded sentence, and caches it. Shows the reason if the Brain is unavailable.";
    return `<div class="ph-val empty">${empty}<button class="ph-genbtn" data-gen="${esc(t.id)}">✨ Let siltpoke look</button></div><div class="ph-hint">${hint}</div>`;
  }

  function openTracePanel(nodeId: string): void {
    if (!panelEl || !pHead || !pBody || !pFoot) return;
    const t = S.trace.data?.nodes.find((n) => n.id === nodeId);
    if (!t) {
      closePanel();
      return;
    }
    if (t.path) publishViewed({ name: t.fn, path: t.path, node_type: "function" }, t.fn);
    const g = groupOf(t.module);
    const isOff = !!t.off;
    const { klass, label } = traceClass(t);
    const loc = t.path
      ? `${esc(subdirRoute(t.module))}${esc(t.file)}${t.line ? ":" + t.line : ""}`
      : "static analysis can't link this call";
    pHead.innerHTML =
      `<div class="p-eyebrow"><span class="gd" style="background:${g.accent}"></span>trace · ${isOff ? "off-path node" : "node card"}` +
      `<span class="p-eyebrow-r">${phStepBtns(t.id)}<button class="p-close" id="rg-pclose">×</button></span></div>` +
      `<div class="p-title">${esc(t.fn)}()</div>` +
      `<div class="p-purpose" style="font-family:var(--mono);font-size:11px">${loc}</div>` +
      `<div class="ph-class ${klass}">${esc(label)}</div>`;
    pBody.innerHTML =
      (isOff
        ? `<div class="ph-offnote">↪ <b>Off-path node</b> — reachable near <code>${esc(offParentFn(t.off))}()</code>, but this trace's main path <b>doesn't take it</b>. Context only — not a step on the path.</div>`
        : "") +
      `<div class="ph-f"><div class="ph-lbl">Input · takes</div><div class="ph-val mono">${esc(t.io.input || "—")}</div></div>` +
      `<div class="ph-f"><div class="ph-lbl">Output · returns</div><div class="ph-val mono">${esc(t.io.output || "—")}</div></div>` +
      `<div class="ph-f"><div class="ph-lbl">Purpose · what it does</div>${phPurpose(t)}</div>` +
      // 🔗 shared dropped as a per-node chip (it was true for every node on a
      // shared-infra path → decoration); stated once on the container header.
      (t.warn ? `<div class="ph-warn">⚠ Path may continue — an unresolved next step the static pass couldn't link.</div>` : "");
    pFoot.innerHTML =
      `<div class="p-note">Input/Output from the signature, Purpose from JSDoc; gaps generated on demand, grounded, with file:line</div>`;
    panelEl.classList.add("open");
    wireClose();
    pBody.querySelectorAll<HTMLElement>("[data-gen]").forEach((b) => {
      b.onclick = () => void phGenerate(b.dataset.gen ?? "");
    });
    pHead.querySelectorAll<HTMLElement>("[data-step]").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        phStep(b.dataset.step === "prev" ? -1 : 1);
      };
    });
    void ensurePurposeCache(t);
  }

  // On card open, read cache state once per node — a warm purpose loads instantly
  // without re-generating (idempotent; the `idle` sentinel blocks re-querying).
  async function ensurePurposeCache(t: TraceNodeData): Promise<void> {
    if (t.purpose.src === "jsdoc" || S.trace.gen[t.id]) return;
    S.trace.gen[t.id] = { state: "idle" };
    try {
      const res = await fetch(withRepo(`/api/repo-graph/trace/purpose?node=${encodeURIComponent(t.id)}`));
      if (!res.ok) return;
      const body = (await res.json()) as { data: { state: string; text?: string; cite?: string } };
      if (body.data.state === "cached" && body.data.text) {
        S.trace.gen[t.id] = { state: "done", text: body.data.text, cite: body.data.cite };
        if (S.selected === t.id) openTracePanel(t.id);
      }
    } catch {
      /* leave idle — the generate button stays available */
    }
  }

  // ✨ generate: POST the grounded run; loading → done (text + cite) or error
  // (real Brain reason + retry). runExplain writes no cache on failure.
  async function phGenerate(nodeId: string): Promise<void> {
    if (!S.trace.data?.nodes.some((n) => n.id === nodeId)) return;
    S.trace.gen[nodeId] = { state: "loading" };
    openTracePanel(nodeId);
    try {
      const res = await fetch("/api/repo-graph/trace/purpose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ node: nodeId, repo: repoHash }),
      });
      if (res.ok) {
        const body = (await res.json()) as { data: { text: string; cite: string } };
        S.trace.gen[nodeId] = { state: "done", text: body.data.text, cite: body.data.cite };
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        S.trace.gen[nodeId] = { state: "error", error: err.error ?? "Brain unavailable" };
      }
    } catch {
      S.trace.gen[nodeId] = { state: "error", error: "Explain request failed — is the daemon reachable?" };
    }
    if (S.selected === nodeId) openTracePanel(nodeId);
  }

  function wireClose(): void {
    const c = root.querySelector<HTMLElement>("#rg-pclose");
    if (c)
      c.onclick = () => {
        S.selected = null;
        S.trace.offFor = null; // closing a trace card also clears its off-path cluster
        closePanel();
        render(false);
        refitTrace(); // card gone → re-center the spine in the now-wider stage
      };
  }

  function wirePanelRows(subId: string): void {
    pBody?.querySelectorAll<HTMLElement>(".filerow[data-file]").forEach((row) => {
      row.onclick = () => void drillToSymbol(subId, row.dataset.file ?? "");
    });
    pBody?.querySelectorAll<HTMLElement>(".im-name[data-nav]").forEach((el) => {
      el.style.cursor = "pointer";
      el.onclick = async () => {
        const nav = el.dataset.nav;
        if (!nav) return;
        await ensureFiles(nav);
        S.level = "arch";
        S.memberFilter = null;
        S.memberBuckets = null;
        S.memberTitle = null;
        render(false);
        select(nav);
      };
    });
    wireClose();
  }

  const SVGNS = "http://www.w3.org/2000/svg";
  const rects: Record<string, Rect> = {};

  // ── C4 container diagram render ────────────────
  // C4 container diagram: DOM
  // boxes + SVG curved labeled edges, NO graph lib. Bypasses the generic codemap
  // node/edge loop; shares the world/stage + fit/pan-zoom. Calm at rest (edges
  // faint, labels hidden); hover/select adds focus lighting.
  function c4Center(n: C4Node): { x: number; y: number } {
    return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
  }
  function c4Border(n: C4Node, tx: number, ty: number): { x: number; y: number } {
    const c = c4Center(n);
    const dx = tx - c.x;
    const dy = ty - c.y;
    if (!dx && !dy) return c;
    const sx = dx ? n.w / 2 / Math.abs(dx) : 1e9;
    const sy = dy ? n.h / 2 / Math.abs(dy) : 1e9;
    const t = Math.min(sx, sy);
    return { x: c.x + dx * t, y: c.y + dy * t };
  }
  function drawArchC4(): void {
    const { N, E, BANDS, BOUNDARY } = C4;
    c4EdgeEls = [];
    c4NodeEls = {};
    c4Sel = null;

    // arrowhead markers — muted (rest) + terra (focus).
    const defs = document.createElementNS(SVGNS, "defs");
    defs.innerHTML =
      // calm marker is faded to match the rest line (0.32) — SVG markers don't
      // inherit stroke-opacity, so without this the head reads ~3x darker than
      // its faint line and floats near the external boxes. Focus uses c4-arrT (solid).
      '<marker id="c4-arr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 1 L9 5 L0 9" fill="none" stroke="#8a7c64" stroke-opacity="0.32" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>' +
      '<marker id="c4-arrT" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 1 L9 5 L0 9" fill="none" stroke="#d96b6b" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>';
    svg.appendChild(defs);

    // system boundary (externals sit outside it).
    const b = document.createElement("div");
    b.className = "c4-boundary";
    Object.assign(b.style, { left: BOUNDARY.x + "px", top: BOUNDARY.y + "px", width: BOUNDARY.w + "px", height: BOUNDARY.h + "px" });
    b.innerHTML = `<span class="c4-blab">${esc(BOUNDARY.label)}</span>`;
    world.appendChild(b);

    // 4 layer bands.
    for (const bd of BANDS) {
      const d = document.createElement("div");
      d.className = "c4-band";
      Object.assign(d.style, { left: bd.x + "px", top: bd.y + "px", width: bd.w + "px", height: bd.h + "px", background: bd.color });
      // Anti-slop: a taxonomy-guessed layer name ("by name") must never read
      // like an authored/grounded label — append a secondary, muted marker
      // inline after the label (so it never collides with the right-aligned note).
      const byName = bd.heuristic ? `<span class="c4-bandby" title="layer guessed from the folder name, not grounded">by name</span>` : "";
      // Band layer-label tier badge (3-way): cited → none (solid, corroborated);
      // inferred → "inferred layer" (anti-slop, orange-dashed = the LLM's
      // uncorroborated read); topology-blind → "layer not import-confirmable"
      // (neutral taupe-dotted) = a depended-upon core the import gradient
      // structurally can't place. The third state is a NEUTRAL unknown, never a
      // warning and never "worse than inferred".
      const bandTier = archTiers?.bands[bd.label];
      const bandTag =
        bandTier === "topology-blind"
          ? `<span class="c4-bandblind" title="depended-upon core — import topology can't determine its layer (not a grounding failure; awaiting human judgment)">layer not import-confirmable</span>`
          : bandTier === "inferred"
            ? `<span class="c4-bandinf" title="layer order not corroborated by the dependency gradient — the LLM's read">inferred layer</span>`
            : "";
      d.innerHTML = `<span class="c4-bandlab" style="color:${bd.lc}">${esc(bd.label)}${byName}${bandTag}</span><span class="c4-bandnote">${esc(bd.note)}</span>`;
      world.appendChild(d);
    }

    // Edges that share a source (or target) node fan out along that box's
    // edge instead of stacking on one line. Count per endpoint, then offset each
    // anchor tangentially by its index — clamped inside the box so it can't slip
    // off. Structural (degree-driven), no per-repo constants.
    const srcN = new Map<string, number>();
    const tgtN = new Map<string, number>();
    for (const [s, t] of E) {
      srcN.set(s, (srcN.get(s) ?? 0) + 1);
      tgtN.set(t, (tgtN.get(t) ?? 0) + 1);
    }
    const srcI = new Map<string, number>();
    const tgtI = new Map<string, number>();
    const FAN_SPREAD = 18;
    const fanAnchor = (
      border: { x: number; y: number },
      center: { x: number; y: number },
      node: C4Node,
      idx: number,
      n: number,
      exDx: number,
      exDy: number,
    ): { x: number; y: number } => {
      if (n <= 1) return border;
      const off = (idx - (n - 1) / 2) * FAN_SPREAD;
      // exit mostly horizontal → spread along the vertical edge (y), else along x.
      if (Math.abs(exDx) >= Math.abs(exDy)) {
        const m = Math.max(0, node.h / 2 - 8);
        return { x: border.x, y: center.y + Math.max(-m, Math.min(m, off)) };
      }
      const m = Math.max(0, node.w / 2 - 8);
      return { x: center.x + Math.max(-m, Math.min(m, off)), y: border.y };
    };

    // edges — quadratic-bowed arrows; calm at rest (faint, labels hidden).
    for (const [s, t, label] of E) {
      const a = N[s];
      const z = N[t];
      if (!a || !z) continue;
      const ca = c4Center(a);
      const cz = c4Center(z);
      const si = srcI.get(s) ?? 0;
      srcI.set(s, si + 1);
      const ti = tgtI.get(t) ?? 0;
      tgtI.set(t, ti + 1);
      const exDx = cz.x - ca.x;
      const exDy = cz.y - ca.y;
      const p1 = fanAnchor(c4Border(a, cz.x, cz.y), ca, a, si, srcN.get(s) ?? 1, exDx, exDy);
      const p2b = fanAnchor(c4Border(z, ca.x, ca.y), cz, z, ti, tgtN.get(t) ?? 1, -exDx, -exDy);
      // Push the endpoint a few px outside the target border so the
      // arrowhead sits in the gutter instead of poking inside the box.
      const ovx = p2b.x - cz.x;
      const ovy = p2b.y - cz.y;
      const ovl = Math.hypot(ovx, ovy) || 1;
      const ARROW_GAP = 6;
      const p2 = { x: p2b.x + (ovx / ovl) * ARROW_GAP, y: p2b.y + (ovy / ovl) * ARROW_GAP };
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const bow = Math.min(len * 0.06, 16);
      const cx = mx - (dy / len) * bow;
      const cy = my + (dx / len) * bow;
      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("d", `M${p1.x} ${p1.y} Q${cx} ${cy} ${p2.x} ${p2.y}`);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "#8a7c64");
      path.setAttribute("stroke-width", "1.4");
      path.setAttribute("stroke-opacity", "0.32");
      path.setAttribute("marker-end", "url(#c4-arr)");
      // Anti-slop: an inferred verb (couldn't be corroborated via a snippet
      // token — already degraded to "uses") draws dashed, never solid.
      const edgeInferred = archTiers?.edges[edgeTierKey(s, t)] === "inferred";
      if (edgeInferred) path.setAttribute("stroke-dasharray", "4 3");
      svg.appendChild(path);
      const lab = document.createElement("div");
      lab.className = edgeInferred ? "c4-elab inferred" : "c4-elab";
      lab.style.left = cx + "px";
      lab.style.top = cy + "px";
      lab.textContent = label;
      lab.title = label; // full verb on hover (also lives in the side panel)
      world.appendChild(lab);
      c4EdgeEls.push({ s, t, path, lab, bx: cx, by: cy });
    }

    // nodes — person (dark) / ext (dashed, outside) / cont (cream, layer border).
    for (const id in N) {
      const n = N[id];
      const d = document.createElement("div");
      // Anti-slop: an inferred ext node (call site not corroborated by a token)
      // draws dashed; cited ext draws solid.
      const nodeInf = archTiers?.nodes[id] === "inferred" ? " inferred" : "";
      // Drill affordance (discoverability): only nodes that CAN drill (drillTo
      // present — person/ext never, generated conts only when the doc says so)
      // carry the class + corner glyph, so the hint never lies.
      const drillable = canDrillNode(n) ? " drillable" : "";
      d.className = "c4-node " + (n.kind === "cont" ? "accent-" + n.accent : n.kind) + nodeInf + drillable;
      d.dataset.id = id;
      Object.assign(d.style, { left: n.x + "px", top: n.y + "px", width: n.w + "px", height: n.h + "px" });
      d.innerHTML =
        `<div class="c4-ntitle">${esc(n.title)}</div>` +
        (n.tech ? `<div class="c4-ntech">[${esc(n.tech)}]</div>` : "") +
        (n.desc ? `<div class="c4-ndesc">${esc(n.desc)}</div>` : "") +
        // Honest-subset count badge: derived nodes carry literal `stats`; the
        // box writes NO label of its own — it calls the guarded formatter.
        (n.stats ? `<div class="c4-ncount">${esc(badgeLabel(n.stats))}</div>` : "") +
        // Top-right corner is free real estate (title flows left, count badge
        // sits at the bottom, tier badges live on band labels).
        (canDrillNode(n) ? `<span class="c4-drill" title="Click twice to open files">›</span>` : "");
      // Signal-focus: hover lights connections while nothing is pinned; click
      // pins selection. mouseleave restores calm only when no selection is held.
      d.addEventListener("mouseenter", () => {
        if (!c4Sel) c4Focus(id);
      });
      d.addEventListener("mouseleave", () => {
        if (!c4Sel) c4Focus(null);
      });
      d.addEventListener("click", (ev) => {
        ev.stopPropagation();
        c4Select(id);
      });
      world.appendChild(d);
      c4NodeEls[id] = d;
    }
  }

  // C4 signal-focus (port of the oracle focus()). focusId=null → calm: every
  // edge faint, all labels hidden, no node dimmed. focusId set → the focused box's
  // connected edges light (terra) with labels; every other box + edge dims.
  function c4Focus(focusId: string | null): void {
    for (const k in c4NodeEls) {
      if (!focusId) {
        c4NodeEls[k].classList.remove("dim");
        continue;
      }
      const linked = k === focusId || C4.E.some(([s, t]) => (s === focusId && t === k) || (t === focusId && s === k));
      c4NodeEls[k].classList.toggle("dim", !linked);
    }
    for (const e of c4EdgeEls) {
      const on = !!focusId && (e.s === focusId || e.t === focusId);
      if (!focusId) {
        e.path.setAttribute("stroke", "#8a7c64");
        e.path.setAttribute("stroke-opacity", "0.32");
        e.path.setAttribute("stroke-width", "1.4");
        e.path.setAttribute("marker-end", "url(#c4-arr)");
        e.lab.classList.remove("show");
      } else if (on) {
        e.path.setAttribute("stroke", "#d96b6b");
        e.path.setAttribute("stroke-opacity", "1");
        e.path.setAttribute("stroke-width", "2.2");
        e.path.setAttribute("marker-end", "url(#c4-arrT)");
        e.lab.classList.add("show");
      } else {
        e.path.setAttribute("stroke", "#8a7c64");
        e.path.setAttribute("stroke-opacity", "0.08");
        e.path.setAttribute("stroke-width", "1.4");
        // SVG markers don't inherit stroke-opacity — a 0.08 line keeps a solid
        // arrowhead, leaving floating heads near the external boxes. Drop the
        // marker on backgrounded edges so the arrow fades with its line.
        e.path.removeAttribute("marker-end");
        e.lab.classList.remove("show");
      }
    }
    if (focusId) c4DeOverlapLabels(focusId);
  }

  // The focused node's edge labels can sit on top of each other (opaque
  // chips cover adjacent verbs — the "truncation" was really overlap).
  // Reset each shown label to its base midpoint, then greedily push overlapping
  // ones downward so neighbours stay readable. Only the focused set is shown, so
  // this is a handful of labels per call.
  function c4DeOverlapLabels(focusId: string): void {
    const hit = (r: { x: number; y: number; w: number; h: number }, cx: number, cy: number, w: number, h: number) =>
      Math.abs(r.x - cx) < (r.w + w) / 2 + 3 && Math.abs(r.y - cy) < (r.h + h) / 2 + 3;
    // Node boxes are obstacles too, so a label can't land on a box (a fixed
    // bug: "scrapes…" on Ollama, "dispatch (gated)" on Router). Seed the
    // placed set with every node rect (centre-based) before placing labels.
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const id in C4.N) {
      const nd = C4.N[id];
      placed.push({ x: nd.x + nd.w / 2, y: nd.y + nd.h / 2, w: nd.w, h: nd.h });
    }
    const MAX_NUDGE = 80; // give up past this so a label never flies off its edge
    const shown = c4EdgeEls
      .filter((e) => e.s === focusId || e.t === focusId)
      .sort((p, q) => p.by - q.by || p.bx - q.bx);
    for (const e of shown) {
      e.lab.style.left = e.bx + "px";
      const w = e.lab.offsetWidth || 80;
      const h = e.lab.offsetHeight || 16;
      const cxp = e.bx;
      // chips are translate(-50%,-50%) → rect is centred on (cxp, cyp).
      let cyp = e.by;
      for (let guard = 0; guard < 60; guard++) {
        if (!placed.some((r) => hit(r, cxp, cyp, w, h))) break;
        cyp += 7;
        if (cyp - e.by > MAX_NUDGE) {
          cyp = e.by; // can't clear nearby — keep it on its own edge, not adrift
          break;
        }
      }
      e.lab.style.top = cyp + "px";
      placed.push({ x: cxp, y: cyp, w, h });
    }
  }
  function c4Select(id: string): void {
    // Click selects + opens panel; clicking an ALREADY-selected container
    // drills into its files (reuse the codemap drillToFile). person/ext have no
    // drillTo → re-click just keeps them selected (never drill).
    const n = C4.N[id];
    if (c4Sel === id && n && canDrillNode(n)) {
      if (archSource === "generated" && n.memberFiles?.length) {
        void drillToMembers(n);
        return;
      }
      if (!n.drillTo) return; // TS narrowing only — unreachable (canDrillNode guarantees drillTo here)
      void drillToFile(n.drillTo);
      return;
    }
    c4Sel = id;
    for (const k in c4NodeEls) c4NodeEls[k].classList.toggle("sel", k === id);
    c4Focus(id);
    openSubdirPanelC4(id);
  }
  function c4Deselect(): void {
    c4Sel = null;
    for (const k in c4NodeEls) c4NodeEls[k].classList.remove("sel");
    c4Focus(null);
    closePanel();
  }

  // C4 side panel — eyebrow (kind + layer dot + ×) → title + [tech] + purpose
  // → Key pieces (comp) → Talks to (out edges) → Called by (in edges). ext has no
  // Key pieces; person/ext eyebrow reads Actor / External system.
  const C4_KIND_LABEL: Record<string, string> = { person: "Actor", ext: "External system", cont: "Container" };
  function openSubdirPanelC4(id: string): void {
    if (!panelEl || !pHead || !pBody || !pFoot) return;
    const n = C4.N[id];
    if (!n) return;
    const acc = n.accent ? C4.GROUP_ACCENT[n.accent] : "var(--ink3)";
    const out = C4.E.filter((e) => e[0] === id).map((e) => ({ other: e[1], vb: e[2] }));
    const inb = C4.E.filter((e) => e[1] === id).map((e) => ({ other: e[0], vb: e[2] }));
    pHead.innerHTML =
      `<div class="p-eyebrow"><span class="gd" style="background:${acc}"></span>${esc(C4_KIND_LABEL[n.kind] ?? "Container")}<button class="p-close" id="rg-pclose">×</button></div>` +
      `<div class="p-title">${esc(n.title)}</div>` +
      (n.tech ? `<div class="p-tech">[${esc(n.tech)}]</div>` : "") +
      (n.desc ? `<div class="p-purpose">${esc(n.desc)}</div>` : "");
    let body = "";
    // Honest-subset structure section: literal counts + recurring-basename
    // breakdown (all rows built by the guarded formatter — the panel writes no
    // label text) + the two-layer disclaimer. apiRoute note only when the
    // container has functions (a count that must NOT be read as endpoints).
    if (n.stats) {
      body += `<div class="p-sec"><h4>Structure</h4><div class="c4-breakdown">${breakdownRows(
        n.stats,
      )
        .map((r) => `<div class="bdrow">${esc(r)}</div>`)
        .join("")}</div>` +
        `<div class="p-honest">${esc(HONEST_NOTES.structural)}</div>` +
        (n.stats.funcCount > 0
          ? `<div class="p-honest">${esc(HONEST_NOTES.apiRoute)}</div>`
          : "") +
        `</div>`;
    }
    if (n.comp && n.comp.length) {
      body += `<div class="p-sec"><h4>Key pieces</h4><div class="comp">${n.comp
        .map((c) => `<div class="comprow"><span class="cn">${esc(c[0])}</span><span class="cd">${esc(c[1])}</span></div>`)
        .join("")}</div></div>`;
    }
    if (out.length) {
      body += `<div class="p-sec"><h4>Talks to</h4><div class="rel">${out
        .map((r) => `<div class="relrow"><span class="ar">→</span><span><span class="vb">${esc(r.vb)}</span> <b>${esc(C4.N[r.other]?.title ?? r.other)}</b></span></div>`)
        .join("")}</div></div>`;
    }
    if (inb.length) {
      body += `<div class="p-sec"><h4>Called by</h4><div class="rel">${inb
        .map((r) => `<div class="relrow"><span class="ar">←</span><span><b>${esc(C4.N[r.other]?.title ?? r.other)}</b> <span class="vb">${esc(r.vb)}</span></span></div>`)
        .join("")}</div></div>`;
    }
    pBody.innerHTML = body || `<div class="p-sec" style="color:var(--ink3);font-family:var(--mono);font-size:11px">no modeled relationships</div>`;
    pFoot.innerHTML =
      n.kind === "cont"
        ? `<div class="p-note">${canDrillNode(n) ? `<span class="p-drill">Click the box again to open its files ›</span><br>` : ""}${archSource === "generated" && !n.memberFiles?.length ? `<span class="p-drill">no file evidence — not drillable</span><br>` : ""}<span class="muted">runtime container · all labels human-authored</span></div>`
        : n.kind === "ext"
          ? `<div class="p-note"><span class="muted">external system — outside the siltpoke boundary</span></div>`
          : `<div class="p-note"><span class="muted">actor</span></div>`;
    panelEl.classList.add("open");
    publishViewed(null, ""); // a container/actor is not an anchorable node
    const c = root.querySelector<HTMLElement>("#rg-pclose");
    if (c) c.onclick = () => c4Deselect();
  }

  function render(refit: boolean): void {
    SCENE = buildScene();
    world.querySelectorAll(".node,.gbox,.c4-node,.c4-boundary,.c4-band,.c4-elab").forEach((n) => n.remove());
    viewport.querySelector(".rg-empty-center")?.remove();
    viewport.querySelector(".rg-leaf-note")?.remove();
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    for (const k of Object.keys(rects)) delete rects[k];

    // Dedicated C4 render path (bypasses the generic
    // codemap loop; reuses the shared world/stage + fit/pan-zoom + crumbs).
    if (S.level === "arch" && ARCH_MODE === "c4") {
      // Authored/generated C4 edges are verb labels, so the codemap toolbar's
      // import-count slider + imports/strong legend + help are meaningless →
      // `rg-arch-c4` hides them. The honest SUBSET, by contrast, draws real
      // import-count edges, so it keeps the slider + legend and only hides the
      // codemap "?" help (`rg-arch-c4-derived`). CSS for both in RepoGraph.tsx.
      root.classList.remove("rg-arch-c4", "rg-arch-c4-derived");
      root.classList.add(archSource === "subset" ? "rg-arch-c4-derived" : "rg-arch-c4");
      world.className = "world gc-full detail-detailed";
      world.dataset.phTreat = "ribbon";
      drawArchC4();
      if (refit) fit();
      else applyView();
      renderCrumbs();
      updateArchAffordance();
      return;
    }
    root.classList.remove("rg-arch-c4", "rg-arch-c4-derived");
    updateArchAffordance(true); // hide generate button + chip off the arch level

    world.className = "world gc-full detail-detailed" + (S.level === "trace" ? " ph-mode" : "");
    world.dataset.phTreat = "ribbon";

    // arrowhead marker — markerUnits=userSpaceOnUse keeps it a constant size
    // regardless of stroke width; fill:context-stroke matches the edge color.
    const defs = document.createElementNS(SVGNS, "defs");
    defs.innerHTML =
      '<marker id="rg-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">' +
      '<path d="M0 1 L9 5 L0 9" fill="none" stroke="context-stroke" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>';
    svg.appendChild(defs);

    // containers (behind the nodes)
    for (const c of SCENE.containers) {
      rects[c.id] = c.rect;
      const box = document.createElement("div");
      box.className = "gbox" + (c.isTrace ? " ph-trace-box" : "");
      Object.assign(box.style, {
        left: c.rect.x + "px",
        top: c.rect.y + "px",
        width: c.rect.w + "px",
        height: c.rect.h + "px",
      });
      box.style.borderColor = hexA(c.accent, c.isTrace ? 0.6 : 0.5);
      const dotColor = c.accent;
      const unit =
        S.level === "arch" ? "modules" : S.level === "file" ? "files" : S.level === "trace" ? "steps" : "symbols";
      const noteHtml = c.note ? `<span class="gnote" title="Every step here is reusable infrastructure reached by other entrypoints too">🔗 ${esc(c.note)}</span>` : "";
      box.innerHTML = `<div class="ghead"><span class="gdot" style="background:${dotColor}"></span>${esc(c.title)}${noteHtml}<span class="gcount">${c.count} ${unit}</span></div>`;
      world.appendChild(box);
    }

    // edges (node→node lines, drawn beneath the cards)
    for (const n of SCENE.nodes) rects[n.id] = n.rect;
    for (const e of SCENE.edges) {
      const r1 = rects[e.s];
      const r2 = rects[e.t];
      if (!r1 || !r2) continue;
      const p1 = center(r1);
      const p2 = center(r2);
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const bow = e.intra || e.trace ? 0 : Math.min(len * 0.08, 26);
      const cxp = mx - (dy / len) * bow;
      const cyp = my + (dx / len) * bow;
      const a = borderPoint(r1, cxp, cyp, 0);
      const b = borderPoint(r2, cxp, cyp, 3);
      const dPath = `M${a.x} ${a.y} Q${cxp} ${cyp} ${b.x} ${b.y}`;
      const strong = e.w > 15;
      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("d", dPath);
      path.setAttribute(
        "class",
        "elink" + (strong ? " strong" : "") + (e.intra ? " intra" : "") + (e.klass ? " ph-" + e.klass : "") + (e.trace ? " ph-edge" : ""),
      );
      (path as unknown as { _edge: Edge })._edge = e;
      svg.appendChild(path);
      // transparent wide hit-area for hover tooltips
      const hit = document.createElementNS(SVGNS, "path");
      hit.setAttribute("d", dPath);
      hit.setAttribute("class", "ehit");
      hit.setAttribute("stroke-width", "14");
      hit.addEventListener("mouseenter", (ev) => showEdgeTip(e, path, ev as MouseEvent));
      hit.addEventListener("mousemove", moveEdgeTip);
      hit.addEventListener("mouseleave", hideEdgeTip);
      svg.appendChild(hit);
      if (e.label) {
        const tx = document.createElementNS(SVGNS, "text");
        tx.setAttribute("x", String(cxp));
        tx.setAttribute("y", String(cyp - 3));
        tx.setAttribute("text-anchor", "middle");
        tx.setAttribute("class", "elabel");
        tx.textContent = e.label;
        (tx as unknown as { _edge: Edge })._edge = e;
        svg.appendChild(tx);
      }
    }

    // nodes
    for (const n of SCENE.nodes) world.appendChild(makeNode(n));

    // empty-state note — centered over the viewport (not a floating box), e.g.
    // a 0-symbol file reached at symbol level. Lives outside `world` so pan/zoom
    // never moves it off-screen.
    if (SCENE.emptyNote) {
      const note = document.createElement("div");
      note.className = "rg-empty-center";
      note.textContent = SCENE.emptyNote;
      viewport.appendChild(note);
    }

    // leaf-state banner — shown BELOW the single entry node when the root has no
    // resolved out-edges. The entry node is still rendered and openable above.
    // Lives outside `world` so it stays fixed relative to the viewport while the
    // user pans. Uses an id="rg-leaf-note" class so cleanup finds it reliably.
    if (SCENE.leafNote) {
      const banner = document.createElement("div");
      banner.className = "rg-leaf-note";
      banner.textContent = SCENE.leafNote;
      viewport.appendChild(banner);
    }

    styleEdges(S.selected);
    if (refit) fit();
    else applyView();
    renderCrumbs();
    phApplyTier(); // Red-tier fallback overlay (self-clears off trace / non-red)
  }

  // ── edge styling / signal-focus (hover-only, all levels) ───────────────────
  // Edges are welded to "On hover": hidden at rest at every level (arch +
  // file/symbol). A line shows only when the hovered/selected node is one of its
  // endpoints — connected edges render solid with an arrow; everything else is 0.
  // Trace mode: edges are persistent (not hover-gated) — the resolved path is
  // always solid/arrowed, fork edges thinner+dashed, dim (off-path) edges faint.
  // Off-path nodes stay dimmed except the focused one.
  function stylePhEdges(focusId: string | null): void {
    svg.querySelectorAll<SVGPathElement>(".elink").forEach((p) => {
      const e = (p as unknown as { _edge: Edge })._edge;
      const on = e.klass !== "dim";
      const isFork = e.klass === "fork";
      p.style.strokeOpacity = on ? (isFork ? "0.7" : "1") : "0.26";
      p.style.strokeWidth = isFork ? "2" : on ? "3" : "1.5";
      if (on) p.setAttribute("marker-end", "url(#rg-arrow)");
      else p.removeAttribute("marker-end");
    });
    world.querySelectorAll<HTMLElement>(".node").forEach((nd) => {
      const off = nd.classList.contains("ph-off");
      nd.classList.toggle("dim", off && nd.dataset.id !== focusId);
    });
  }

  function styleEdges(focusId: string | null): void {
    if (S.level === "trace") {
      stylePhEdges(focusId);
      return;
    }
    svg.querySelectorAll<SVGPathElement>(".elink").forEach((p) => {
      const e = (p as unknown as { _edge: Edge })._edge;
      const connected = !!focusId && (e.s === focusId || e.t === focusId);
      if (e.intra) {
        p.style.strokeOpacity = connected ? "1" : "0";
        p.style.strokeWidth = "1.5";
        if (connected) p.setAttribute("marker-end", "url(#rg-arrow)");
        else p.removeAttribute("marker-end");
        return;
      }
      const w = 1 + Math.min(e.w, 40) / 9;
      const op = connected ? 1 : 0;
      p.style.strokeOpacity = String(op);
      p.style.strokeWidth = String(connected ? w + 0.6 : w);
      if (op > 0.25) p.setAttribute("marker-end", "url(#rg-arrow)");
      else p.removeAttribute("marker-end");
    });
    svg.querySelectorAll<SVGTextElement>(".elabel").forEach((t) => {
      const e = (t as unknown as { _edge: Edge })._edge;
      const connected = !!focusId && (e.s === focusId || e.t === focusId);
      t.classList.toggle("show", connected);
    });
    // dim nodes outside the focused neighborhood
    world.querySelectorAll<HTMLElement>(".node").forEach((nd) => {
      if (!focusId) {
        nd.classList.remove("dim");
        return;
      }
      const id = nd.dataset.id;
      // Connectivity must include INTRA edges — at file/symbol level the
      // node↔node links ARE intra (file imports, symbol calls/uses), so the
      // old `!e.intra` filter dimmed connected neighbors. Arch has no intra
      // edges, so this is a no-op there. ids are prefixed consistently per level.
      const linked =
        id === focusId ||
        (SCENE?.edges.some((e) => (e.s === focusId && e.t === id) || (e.t === focusId && e.s === id)) ?? false);
      nd.classList.toggle("dim", !linked);
    });
  }

  function focusNode(id: string | null): void {
    styleEdges(id);
  }

  // ── edge hover tooltip (port of app.js showEdgeTip / move / hide) ──────────
  function readableId(id: string): string {
    if (id.startsWith("no:")) return id.slice(3) + "/";
    if (id.startsWith("n:")) return id.slice(2) + "/";
    if (id.startsWith("c:")) return subdirRoute(id.slice(2));
    if (id.startsWith("f:")) return id.slice(2);
    if (id.startsWith("s:")) return id.slice(2);
    return subdirRoute(id);
  }
  function showEdgeTip(e: Edge, vis: SVGPathElement, ev: MouseEvent): void {
    if (!edgeTip) return;
    const from = readableId(e.s);
    const to = readableId(e.t);
    if (e.intra) {
      edgeTip.innerHTML =
        S.level === "symbol"
          ? `<b>${esc(from)}</b> calls / uses <b>${esc(to)}</b>`
          : `<b>${esc(from)}</b> imports <b>${esc(to)}</b>`;
    } else {
      edgeTip.innerHTML = `<b>${esc(from)}</b> imports <b>${esc(to)}</b><br>${e.w} import statement${e.w > 1 ? "s" : ""} · ${couplingTier(e.w)}`;
    }
    edgeTip.style.opacity = "1";
    moveEdgeTip(ev);
    vis.style.strokeOpacity = "1";
    vis.style.strokeWidth = String((parseFloat(vis.style.strokeWidth) || 2) + 1.2);
    vis.setAttribute("marker-end", "url(#rg-arrow)");
  }
  function moveEdgeTip(ev: MouseEvent): void {
    if (!edgeTip) return;
    const pad = 14;
    let x = ev.clientX + pad;
    let y = ev.clientY + pad;
    const w = edgeTip.offsetWidth || 200;
    const h = edgeTip.offsetHeight || 40;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
    edgeTip.style.left = x + "px";
    edgeTip.style.top = y + "px";
  }
  function hideEdgeTip(): void {
    if (edgeTip) edgeTip.style.opacity = "0";
    styleEdges(S.selected);
  }

  // ── breadcrumb (port of app.js renderCrumbs — climbs arch ‹ file ‹ symbol) ──
  function renderCrumbs(): void {
    if (!crumbsEl) return;
    if (S.level === "trace") {
      // "Architecture › ⟜ Trace · fn()" — clicking Architecture exits trace.
      const ep = S.trace.entrypoints.find((e) => e.id === S.trace.ep);
      const entryNode = S.trace.data?.nodes.find((n) => n.id === S.trace.data?.spine[0]);
      const fn = ep?.fn ?? entryNode?.fn ?? S.trace.ep;
      // No root chosen yet (search-fallback entry) → just "⟜ Trace", no "· ()".
      const cur = fn ? `⟜ Trace · ${esc(fn)}()` : "⟜ Trace";
      crumbsEl.innerHTML =
        `<span class="c" data-i="0">Architecture</span><span class="sep">›</span>` +
        `<span class="c cur">${cur}</span>`;
      const back = crumbsEl.querySelector<HTMLElement>('.c[data-i="0"]');
      if (back) back.onclick = goArch;
      return;
    }
    const parts: Array<{ label: string; go: (() => void) | null; cur?: boolean }> = [
      { label: "Architecture", go: goArch, cur: S.level === "arch" },
    ];
    if (S.level !== "arch" && S.subId) {
      const g = groupOf(S.subId);
      const subId = S.subId;
      parts.push({ label: g.title, go: goArch });
      parts.push({
        label: S.memberTitle ?? subdirRoute(subId),
        // member door: back to the FILTERED file scene (caches warm — no refetch);
        // bucket drill keeps the original re-drill handler.
        go: S.memberFilter
          ? () => {
              S.level = "file";
              S.file = null;
              S.selected = null;
              render(true);
            }
          : () => void drillToFile(subId),
        cur: S.level === "file",
      });
    }
    if (S.level === "symbol" && S.file) parts.push({ label: S.file, go: null, cur: true });
    crumbsEl.innerHTML = parts
      .map((p, i) => (i ? '<span class="sep">›</span>' : "") + `<span class="c${p.cur ? " cur" : ""}" data-i="${i}">${esc(p.label)}</span>`)
      .join("");
    crumbsEl.querySelectorAll<HTMLElement>(".c").forEach((c, i) => {
      const p = parts[i];
      if (p && p.go && !p.cur) c.onclick = p.go;
    });
  }

  // ── pan / zoom (port of app.js) ────────────────────────────────────────────
  function applyView(): void {
    world.style.transform = `translate(${S.view.tx}px,${S.view.ty}px) scale(${S.view.scale})`;
  }

  let fitRetries = 0;
  function fit(): void {
    if (!SCENE) return;
    // On an hx-boost re-mount the stage isn't laid out yet (clientWidth/Height
    // == 0) when boot's first render→fit runs, so the world would be scaled/
    // translated off-screen → blank canvas until a hard refresh. Retry on the
    // next frame until the stage has a real size (bounded so a hidden host can't
    // loop forever).
    if ((stage.clientWidth <= 0 || stage.clientHeight <= 0) && fitRetries < 30) {
      fitRetries += 1;
      requestAnimationFrame(() => fit());
      return;
    }
    fitRetries = 0;
    const pad = 48;
    const padX = 16;
    // fit() sizes to the FULL canvas — the side panels are OVERLAYS, not a
    // smaller viewport — so opening a panel never SHRINKS the graph; fit just
    // re-scales to the canvas and pans. When the left detail panel is open we
    // then LEFT-ALIGN the graph just past it (tx below) so its left edge isn't
    // hidden; the right may tuck under the floating chat, which is acceptable.
    const panelW = panelEl?.classList.contains("open") ? 320 : 0;
    const availW = stage.clientWidth;
    const availH = stage.clientHeight;
    // Trace level frames the ACTUAL content extent (min→max of the rendered
    // rects), not [0, bounds.w]: the spine sits at a fixed x with an empty left
    // margin reserved for the on-demand off-path cluster, and that dead margin
    // would otherwise shove the path right of the visible gap. Other levels keep
    // the shipped bounds-based fit untouched.
    let originX = 0;
    let originY = 0;
    let cw = SCENE.bounds.w;
    let ch = SCENE.bounds.h;
    if (S.level === "trace") {
      const rectsAll = [...SCENE.containers.map((c) => c.rect), ...SCENE.nodes.map((n) => n.rect)];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const r of rectsAll) {
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.w);
        maxY = Math.max(maxY, r.y + r.h);
      }
      if (Number.isFinite(minX)) {
        originX = minX;
        originY = minY;
        cw = maxX - minX;
        ch = maxY - minY;
      }
    }
    const sc = Math.min((availW - padX * 2) / cw, (availH - pad * 2) / ch, 1.25);
    S.view.scale = Math.max(0.2, sc);
    S.view.tx =
      panelW > 0
        ? panelW + padX - originX * S.view.scale // clear the open left panel
        : (availW - cw * S.view.scale) / 2 - originX * S.view.scale; // centered
    S.view.ty = (availH - ch * S.view.scale) / 2 - originY * S.view.scale;
    applyView();
  }

  // Re-center the trace path whenever the side card opens/closes (the available
  // width changes by ~360px), so the spine stays centered in the visible gap.
  function refitTrace(): void {
    if (S.level === "trace") fit();
  }

  // Red-tier fallback: when coverage < 40% the function-level path is
  // suppressed (sceneTrace returns empty) and this note explains the fall back
  // to the file-level dependency view.
  function clearTraceFallback(): void {
    root.querySelector("#rg-ph-fallback")?.remove();
    stage.classList.remove("ph-fallback");
  }
  function phApplyTier(): void {
    if (S.level !== "trace" || S.trace.coverage?.tier !== "red") {
      clearTraceFallback();
      return;
    }
    stage.classList.add("ph-fallback");
    let fb = root.querySelector<HTMLElement>("#rg-ph-fallback");
    if (!fb) {
      fb = document.createElement("div");
      fb.id = "rg-ph-fallback";
      stage.appendChild(fb);
    }
    fb.innerHTML =
      `<span class="fb-ic">⛔</span><div><b>Coverage &lt; 40% · function-level path is off</b>` +
      `<p>This repo's in-repo resolve rate is too low; a function-level path would mislead. ` +
      `Falling back to the file-level dependency graph — open <b>Architecture</b> for the module-level view.</p></div>`;
    fb.style.display = "flex";
  }

  let dragging = false;
  let sx = 0;
  let sy = 0;
  let stx = 0;
  let sty = 0;
  viewport.addEventListener("mousedown", (e) => {
    dragging = true;
    dragMoved = false;
    sx = e.clientX;
    sy = e.clientY;
    stx = S.view.tx;
    sty = S.view.ty;
    viewport.classList.add("panning");
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) dragMoved = true;
    S.view.tx = stx + dx;
    S.view.ty = sty + dy;
    applyView();
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    viewport.classList.remove("panning");
    setTimeout(() => (dragMoved = false), 0);
  });
  viewport.addEventListener("click", (e) => {
    const tgt = e.target as HTMLElement;
    // C4 architecture: a bare-canvas click clears the pinned selection back to calm.
    if (S.level === "arch" && ARCH_MODE === "c4") {
      if ((tgt === viewport || tgt === world || (tgt as Node) === svg) && !dragMoved && c4Sel) c4Deselect();
      return;
    }
    // In trace mode, a click on the dashed call-path container background (not a
    // node) also deselects — so clicking "off the cards" reliably clears the
    // revealed off-path cluster, not just clicks on bare canvas.
    const onContainerBg = S.level === "trace" && (tgt.classList?.contains("gbox") || tgt.classList?.contains("ghead"));
    if (tgt === viewport || tgt === world || (tgt as Node) === svg || onContainerBg) {
      if (!dragMoved && S.selected) {
        const wasOpen = panelEl?.classList.contains("open") ?? false;
        S.selected = null;
        S.trace.offFor = null; // clearing selection in trace mode hides the off-path cluster
        closePanel();
        render(false);
        if (wasOpen) refitTrace(); // card closed → re-center the spine
      }
    }
  });
  stage.addEventListener(
    "wheel",
    (e) => {
      // Let scrollable chrome nested in the stage (the side panel body) scroll
      // natively — only hijack the wheel for zoom when the pointer is on the
      // canvas itself. Without this, the stage-wide preventDefault below steals
      // the wheel and the panel's overflow-y:auto can't scroll.
      const t = e.target as HTMLElement;
      if (t.closest?.("#rg-panel, #rg-search-results, #rg-help-pop, #rg-ex-modal")) return;
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const ns = Math.max(0.2, Math.min(2.5, S.view.scale * f));
      S.view.tx = mx - (mx - S.view.tx) * (ns / S.view.scale);
      S.view.ty = my - (my - S.view.ty) * (ns / S.view.scale);
      S.view.scale = ns;
      applyView();
    },
    { passive: false },
  );
  function zoomBy(f: number): void {
    const ns = Math.max(0.2, Math.min(2.5, S.view.scale * f));
    const cx = stage.clientWidth / 2;
    const cy = stage.clientHeight / 2;
    S.view.tx = cx - (cx - S.view.tx) * (ns / S.view.scale);
    S.view.ty = cy - (cy - S.view.ty) * (ns / S.view.scale);
    S.view.scale = ns;
    applyView();
  }
  // C4 (arch) — Esc closes the side panel + clears selection back to calm.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.level === "arch" && ARCH_MODE === "c4" && c4Sel) c4Deselect();
  });
  root.querySelector<HTMLElement>("#rg-zoom-in")?.addEventListener("click", () => zoomBy(1.18));
  root.querySelector<HTMLElement>("#rg-zoom-out")?.addEventListener("click", () => zoomBy(1 / 1.18));
  root.querySelector<HTMLElement>("#rg-zoom-fit")?.addEventListener("click", () => fit());

  // ── help popover ───────────────────────────────────────────────────────────
  const helpBtn = root.querySelector<HTMLElement>("#rg-help-btn");
  const helpPop = root.querySelector<HTMLElement>("#rg-help-pop");
  helpBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = helpPop?.classList.toggle("open") ?? false;
    helpBtn.classList.toggle("on", open);
  });
  document.addEventListener("click", (e) => {
    const target = e.target as Node;
    if (helpPop && !helpPop.contains(target) && target !== helpBtn) {
      helpPop.classList.remove("open");
      helpBtn?.classList.remove("on");
    }
  });

  // ── search (port of app.js doSearch/pick + live /search endpoint) ──────────
  interface SearchHit {
    kind: "file" | "symbol" | "subdir";
    name: string;
    symbolKind?: string;
    subdir: string;
    file?: string;
    line?: number;
    path?: string;
  }
  const searchInput = root.querySelector<HTMLInputElement>("#rg-search-input");
  const searchResults = root.querySelector<HTMLElement>("#rg-search-results");
  let curResults: SearchHit[] = [];
  let hlIdx = 0;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  function hlMatch(name: string, q: string): string {
    const i = name.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(name);
    return esc(name.slice(0, i)) + "<mark style='background:#f3e0a8;color:inherit'>" + esc(name.slice(i, i + q.length)) + "</mark>" + esc(name.slice(i + q.length));
  }
  function pathLabel(h: SearchHit): string {
    if (h.kind === "subdir") return "";
    if (h.path) return h.path;
    return subdirRoute(h.subdir) + (h.file ?? "");
  }

  async function doSearch(q: string): Promise<void> {
    q = q.trim();
    if (!searchResults) return;
    if (!q) {
      searchResults.classList.remove("open");
      return;
    }
    let hits: SearchHit[] = [];
    let suggestions: string[] = [];
    try {
      const res = await fetch(withRepo(`/api/repo-graph/search?q=${encodeURIComponent(q)}&limit=8`));
      if (res.ok) {
        const body = (await res.json()) as { data: { hits: SearchHit[]; suggestions?: Array<{ name: string }> } };
        hits = body.data.hits ?? [];
        suggestions = (body.data.suggestions ?? []).map((s) => s.name);
      }
    } catch {
      /* leave empty */
    }
    curResults = hits;
    hlIdx = 0;
    if (hits.length) {
      searchResults.innerHTML = hits
        .map((h, i) => {
          const kind = h.kind === "symbol" ? h.symbolKind ?? "symbol" : h.kind;
          return `<div class="res${i === 0 ? " hl" : ""}" data-i="${i}"><span class="k">${esc(kind)}</span><span class="nm">${hlMatch(h.name, q)}</span><span class="pa">${esc(pathLabel(h))}</span></div>`;
        })
        .join("");
    } else if (suggestions.length) {
      searchResults.innerHTML =
        `<div class="res" style="cursor:default"><span class="nm" style="color:var(--ink3);font-weight:400">no matches · did you mean…</span></div>` +
        suggestions.map((s) => `<div class="res res-sug" data-sug="${esc(s)}"><span class="k">hint</span><span class="nm">${esc(s)}</span></div>`).join("");
    } else {
      searchResults.innerHTML = `<div class="res" style="cursor:default"><span class="nm" style="color:var(--ink3);font-weight:400">no matches</span></div>`;
    }
    searchResults.classList.add("open");
    searchResults.querySelectorAll<HTMLElement>(".res[data-i]").forEach((el) => {
      el.onclick = () => {
        const r = curResults[Number(el.dataset.i)];
        if (r) void pick(r);
      };
    });
    searchResults.querySelectorAll<HTMLElement>(".res-sug[data-sug]").forEach((el) => {
      el.onclick = () => {
        if (searchInput) {
          searchInput.value = el.dataset.sug ?? "";
          void doSearch(searchInput.value);
        }
      };
    });
  }

  async function pick(h: SearchHit): Promise<void> {
    searchResults?.classList.remove("open");
    if (searchInput) searchInput.value = "";
    const subId = h.subdir || h.name;
    if (h.kind === "subdir") {
      await drillToFile(subId);
      return;
    }
    await ensureFiles(subId);
    // drillToSymbol keys on the full PATH. Prefer the hit's path;
    // fall back to resolving a basename within the subdir if the hit lacks one.
    const filePath = h.path ?? filesFor(subId).find((f) => f.name === (h.file ?? h.name))?.path ?? "";
    await drillToSymbol(subId, filePath, h.kind === "symbol" ? h.name : undefined);
  }

  function paintHl(): void {
    searchResults?.querySelectorAll<HTMLElement>(".res[data-i]").forEach((el, i) => el.classList.toggle("hl", i === hlIdx));
  }
  searchInput?.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void doSearch(searchInput.value), 150);
  });
  searchInput?.addEventListener("keydown", (e) => {
    if (!searchResults?.classList.contains("open")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      hlIdx = Math.min(hlIdx + 1, curResults.length - 1);
      paintHl();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      hlIdx = Math.max(hlIdx - 1, 0);
      paintHl();
    } else if (e.key === "Enter") {
      const r = curResults[hlIdx];
      if (r) void pick(r);
    } else if (e.key === "Escape") {
      searchResults.classList.remove("open");
      searchInput.blur();
    }
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest("#rg-search-input, #rg-search-results")) searchResults?.classList.remove("open");
  });

  // explain modal: backdrop click + Escape close
  exOverlay?.addEventListener("click", (e) => {
    if (e.target === exOverlay) closeExplain();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeExplain();
  });

  // ── repo picker — port of app.js renderRepoMenu/switchRepo ────────────
  interface RepoSummary {
    id: string;
    name: string;
    path: string;
    files: number;
    symbols: number;
    edges: number;
    lastIndexed: string;
    state: "ready" | "indexing" | "none";
  }
  const repoPick = root.querySelector<HTMLElement>("#rg-repo-pick");
  const repoMenu = root.querySelector<HTMLElement>("#rg-repo-menu");
  const repoEmpty = root.querySelector<HTMLElement>("#rg-repo-empty");
  const hintEl = root.querySelector<HTMLElement>("#rg-hint");
  let repoList: RepoSummary[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  // Which repo's forget × is "armed" (showing the inline confirm row).
  let forgetArmed: string | null = null;

  async function loadRepos(): Promise<void> {
    try {
      const res = await fetch("/api/repo-graph/repos");
      if (!res.ok) return;
      const body = (await res.json()) as { data: { repos: RepoSummary[] } };
      repoList = body.data.repos ?? [];
    } catch {
      /* keep prior list */
    }
  }

  function renderRepoMenu(): void {
    if (!repoMenu) return;
    // Guardrail: block forget while ANY index is in progress (don't delete a
    // repo out from under a build). Uniform — no siltpoke-self special-casing.
    const anyIndexing = repoList.some((r) => r.state === "indexing");
    repoMenu.innerHTML =
      `<div class="rm-head">Indexed repositories</div>` +
      repoList
        .map((r) => {
          // Armed row → inline confirm prompt (uniform copy, every repo).
          if (forgetArmed === r.id) {
            return (
              `<div class="repo-row confirm">` +
              `<div class="rconfirm">Forget <b>${esc(r.name)}</b>? You can re-index it anytime.</div>` +
              `<button class="rc-yes" data-fyes="${esc(r.id)}">Forget</button>` +
              `<button class="rc-no" data-fno="1">Cancel</button>` +
              `</div>`
            );
          }
          const cur = r.id === repoHash;
          const stat =
            r.state === "ready"
              ? `${r.files} files<br><span class="rs2">${r.edges} edges</span>`
              : r.state === "indexing"
                ? "indexing…"
                : "not indexed";
          return (
            `<div class="repo-row ${r.state === "none" ? "disabled" : ""}" data-id="${esc(r.id)}">` +
            `<span class="rdot ${r.state}"></span>` +
            // rname-txt span: a bare text node inside the flex .rname can't
            // ellipsize — the wrapper makes truncation possible and carries the
            // full name as a hover title.
            `<div class="rinfo"><div class="rname"><span class="rname-txt" title="${esc(r.name)}">${esc(r.name)}</span>${cur ? '<span class="rcur">current</span>' : ""}</div><div class="rpath">${esc(r.path)} · ${esc(r.lastIndexed)}</div></div>` +
            `<div class="rstat ${r.state === "indexing" ? "warn" : ""}">${stat}</div>` +
            `<button class="rforget${anyIndexing ? " rforget-off" : ""}" data-forget="${esc(r.id)}" title="${anyIndexing ? "Can't forget while indexing" : "Forget this repo"}" aria-label="Forget ${esc(r.name)}"${anyIndexing ? " disabled" : ""}>×</button>` +
            `</div>`
          );
        })
        .join("") +
      // "+ Index a repo" — opens a daemon-served folder browser (the
      // browser can't get an abs path from a native picker). The panel content
      // (browser or the text-input fallback) is rendered by JS on open.
      `<div class="rm-add">` +
      `<button class="rm-add-btn" id="rg-idx-add"><span class="rm-add-plus">+</span> Index a repo</button>` +
      `<div class="rm-add-panel" id="rg-idx-panel" hidden></div>` +
      `</div></div>`;
    repoMenu.querySelectorAll<HTMLElement>(".repo-row[data-id]").forEach((row) => {
      const r = repoList.find((x) => x.id === row.dataset.id);
      if (!r || r.state === "none") {
        if (r) row.onclick = () => showRepoEmpty(r);
        return;
      }
      row.onclick = () => {
        closeRepoMenu();
        switchRepo(r);
      };
    });
    // Forget (×) → arm the inline confirm row. stopPropagation so it doesn't
    // also switch into the repo. Disabled rows (anyIndexing) carry no handler.
    repoMenu.querySelectorAll<HTMLElement>(".rforget:not(.rforget-off)[data-forget]").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        forgetArmed = b.dataset.forget ?? null;
        renderRepoMenu();
      };
    });
    // Confirm row: Forget → DELETE, Cancel → back to the normal row.
    repoMenu.querySelectorAll<HTMLElement>(".rc-yes[data-fyes]").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const id = b.dataset.fyes;
        forgetArmed = null;
        if (id) void forgetRepo(id, id === repoHash);
      };
    });
    repoMenu.querySelectorAll<HTMLElement>(".rc-no").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        forgetArmed = null;
        renderRepoMenu();
      };
    });
    // "+ Index a repo" wiring — toggle the panel; on open, load the folder
    // browser at $HOME. The panel renders itself (browser / text fallback).
    const addBtn = repoMenu.querySelector<HTMLElement>("#rg-idx-add");
    const panel = repoMenu.querySelector<HTMLElement>("#rg-idx-panel");
    if (addBtn && panel)
      addBtn.onclick = (e) => {
        e.stopPropagation();
        panel.hidden = !panel.hidden;
        if (!panel.hidden) void navigateFs(undefined);
      };
  }

  function openRepoMenu(): void {
    forgetArmed = null;
    void loadRepos().then(() => {
      renderRepoMenu();
      repoMenu?.classList.add("open");
      repoPick?.classList.add("open");
    });
  }
  function closeRepoMenu(): void {
    repoMenu?.classList.remove("open");
    repoPick?.classList.remove("open");
  }
  repoPick?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (repoMenu?.classList.contains("open")) closeRepoMenu();
    else openRepoMenu();
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest("#rg-repo-pick, #rg-repo-menu")) closeRepoMenu();
  });

  // Group-agnostic switch: a full reload re-runs the SSR projection for the
  // target repo's own groups rather than mutating in place.
  function switchRepo(r: RepoSummary): void {
    if (r.id === repoHash) return;
    if (r.state === "ready") {
      window.location.href = `/repo-graph?repo=${encodeURIComponent(r.id)}`;
      return;
    }
    if (r.state === "indexing") {
      showRepoEmpty(r);
      startPolling(r.id);
    } else {
      showRepoEmpty(r);
    }
  }

  function showRepoEmpty(r: RepoSummary): void {
    if (!repoEmpty) return;
    closeRepoMenu();
    closePanel();
    if (hintEl) hintEl.style.display = "none";
    world.style.display = "none";
    if (r.state === "indexing") {
      repoEmpty.innerHTML =
        `<div class="spin"></div><h3>Indexing ${esc(r.name)}…</h3>` +
        `<p>Building the structural index — tree-sitter parse → graph + fingerprints. The graph appears here when it's ready.</p>` +
        `<div class="re-cmd">${r.files} files</div>`;
    } else {
      repoEmpty.innerHTML =
        `<h3>${esc(r.name)} isn't indexed yet</h3>` +
        `<p>Run the indexer to generate a code map for this project.</p>` +
        `<div class="re-cmd">/siltpoke-index ${esc(r.path)}</div>`;
    }
    repoEmpty.classList.add("show");
  }

  // Poll /repos while a selected repo indexes; reload when the structural indexer finishes.
  function startPolling(id: string): void {
    if (pollTimer) clearInterval(pollTimer);
    let tries = 0;
    pollTimer = setInterval(async () => {
      tries += 1;
      if (tries > 40) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        return;
      }
      await loadRepos();
      if (repoList.find((x) => x.id === id)?.state === "ready") {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        window.location.href = `/repo-graph?repo=${encodeURIComponent(id)}`;
      }
    }, 3000);
  }

  // ── In-dashboard "Index a repo" trigger + live SSE progress ──────
  let indexingActive = false;
  let currentIndexHash: string | null = null;

  function reasonText(reason: string): string {
    switch (reason) {
      case "empty":
        return "Enter a path.";
      case "not_absolute":
        return "Use an absolute path (e.g. /Users/you/project).";
      case "not_found":
        return "That path doesn't exist.";
      case "not_a_directory":
        return "That's a file, not a directory.";
      case "outside_allow_root":
        return "Outside the allowed root — add it to index.allowRoots in config.";
      case "unreadable":
        return "Can't read that path.";
      case "index_in_progress":
        return "An index is already running.";
      case "unauthorized":
        return "Not authorized (no daemon secret).";
      default:
        return "Indexing failed.";
    }
  }

  // "Indexing <name>…" center state — "scanning…" until the first progress tick.
  function showIndexProgress(name: string, done: number | null, total: number | null): void {
    if (!repoEmpty) return;
    closeRepoMenu();
    closePanel();
    if (hintEl) hintEl.style.display = "none";
    world.style.display = "none";
    const line = total == null ? "scanning…" : `${done}/${total} files`;
    repoEmpty.innerHTML =
      `<div class="spin"></div><h3>Indexing ${esc(name)}…</h3>` +
      `<p class="rg-idx-prog">${esc(line)}</p>` +
      `<button class="rg-idx-cancel" id="rg-idx-cancel">Cancel</button>`;
    repoEmpty.classList.add("show");
    const cancel = repoEmpty.querySelector<HTMLElement>("#rg-idx-cancel");
    if (cancel) cancel.onclick = () => void cancelIndex();
  }

  function showIndexError(name: string, message: string): void {
    if (!repoEmpty) return;
    const human =
      message === "cancelled" ? "Indexing cancelled." : message === "timeout" ? "Indexing timed out." : "Indexing failed.";
    repoEmpty.innerHTML = `<h3>${esc(name)}</h3><p>${esc(human)}</p>`;
    repoEmpty.classList.add("show");
  }

  async function cancelIndex(): Promise<void> {
    if (!currentIndexHash) return;
    try {
      await fetch("/api/repo-graph/index/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": indexSecret },
        body: JSON.stringify({ hash: currentIndexHash }),
      });
    } catch {
      /* the SSE error path fires when the build aborts; this is best-effort */
    }
  }

  // POST a path + consume the SSE feed. Pre-stream failures (bad path / 409 /
  // 401) come back as JSON with a non-200 status → surface inline; the 200
  // stream drives the center "indexing" state → navigate on done.
  async function submitIndex(path: string, errSlot: HTMLElement | null): Promise<void> {
    if (errSlot) errSlot.textContent = "";
    if (!path) {
      if (errSlot) errSlot.textContent = reasonText("empty");
      return;
    }
    if (indexingActive) {
      if (errSlot) errSlot.textContent = reasonText("index_in_progress");
      return;
    }
    // Set the guard BEFORE the await so a rapid double-submit can't slip a second
    // POST through the check above; cleared on every early-return error path.
    indexingActive = true;
    let res: Response;
    try {
      res = await fetch("/api/repo-graph/index", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": indexSecret },
        body: JSON.stringify({ path }),
      });
    } catch {
      indexingActive = false;
      if (errSlot) errSlot.textContent = "Request failed.";
      return;
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok || ct.includes("application/json")) {
      indexingActive = false;
      let reason = "failed";
      try {
        reason = ((await res.json()) as { error?: string }).error ?? reason;
      } catch {
        /* */
      }
      if (errSlot) errSlot.textContent = reasonText(reason);
      return;
    }
    if (!res.body) {
      indexingActive = false;
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let name = "repo";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /event:\s*(.+)/.exec(block)?.[1]?.trim();
          const dataRaw = /data:\s*(.+)/.exec(block)?.[1];
          if (!ev || !dataRaw) continue;
          let data: { name?: string; hash?: string; done?: number; total?: number; message?: string } = {};
          try {
            data = JSON.parse(dataRaw);
          } catch {
            /* */
          }
          if (ev === "started") {
            name = data.name ?? name;
            currentIndexHash = data.hash ?? null;
            showIndexProgress(name, null, null);
          } else if (ev === "progress") {
            showIndexProgress(name, data.done ?? 0, data.total ?? 0);
          } else if (ev === "done") {
            indexingActive = false;
            window.location.href = `/repo-graph?repo=${encodeURIComponent(data.hash ?? "")}`;
            return;
          } else if (ev === "error") {
            indexingActive = false;
            currentIndexHash = null;
            showIndexError(name, data.message ?? "failed");
            return;
          }
        }
      }
    } finally {
      indexingActive = false;
    }
  }

  // DELETE a repo's index (shared removeRepoIndex primitive server-side).
  // Forgetting the currently-viewed repo navigates to /repo-graph so the SSR
  // lands on a clean state (the cwd repo, or its empty "pick / index" view) —
  // never a broken graph of a repo that's gone. A non-ok response (409 while
  // indexing / 401 / 400) leaves the list untouched.
  async function forgetRepo(hash: string, isCurrent: boolean): Promise<void> {
    try {
      const res = await fetch(`/api/repo-graph/repos/${encodeURIComponent(hash)}`, {
        method: "DELETE",
        headers: { "X-Siltpoke-Secret": indexSecret },
      });
      if (!res.ok) return;
    } catch {
      return;
    }
    if (isCurrent) {
      window.location.href = "/repo-graph";
      return;
    }
    await loadRepos();
    renderRepoMenu();
  }

  // ── Daemon-served folder browser (the +Index panel) ─────────────
  interface FsEntryC {
    name: string;
    path: string;
    isCodebase: boolean;
  }
  interface FsData {
    dir: string;
    parent: string | null;
    isCodebase: boolean; // markers-only gate for `dir`
    entries: FsEntryC[];
    truncated: number;
  }
  let fsData: FsData | null = null;
  let fsOverride = false; // "index anyway" armed for the current dir
  let fsFilter = "";

  async function fetchFsList(dir?: string): Promise<FsData | null> {
    const q = dir ? `?dir=${encodeURIComponent(dir)}` : "";
    try {
      const res = await fetch(`/api/fs/list${q}`, { headers: { "X-Siltpoke-Secret": indexSecret } });
      if (!res.ok) return null;
      return ((await res.json()) as { data: FsData }).data;
    } catch {
      return null;
    }
  }

  // Navigate the browser to `dir` (or $HOME when undefined). Resets the override
  // + filter for the new folder. The daemon is the only source of abs paths.
  async function navigateFs(dir?: string): Promise<void> {
    const data = await fetchFsList(dir);
    if (!data) return;
    fsData = data;
    fsOverride = false;
    fsFilter = "";
    renderBrowserPanel();
  }

  function renderBrowserPanel(): void {
    const panel = repoMenu?.querySelector<HTMLElement>("#rg-idx-panel");
    const d = fsData;
    if (!panel || !d) return;
    const shown = fsFilter ? d.entries.filter((e) => e.name.toLowerCase().includes(fsFilter.toLowerCase())) : d.entries;
    const gateOk = d.isCodebase || fsOverride;
    const showFilter = d.truncated > 0 || d.entries.length > 8 || fsFilter.length > 0;
    panel.innerHTML =
      `<div class="fb-bar"><button class="fb-up" id="rg-fb-up"${d.parent ? "" : " disabled"} title="Up">↑</button>` +
      `<span class="fb-crumb" title="${esc(d.dir)}">${esc(d.dir)}</span></div>` +
      (showFilter ? `<input class="fb-filter" id="rg-fb-filter" placeholder="filter folders…" value="${esc(fsFilter)}" autocomplete="off" spellcheck="false" />` : "") +
      `<div class="fb-list">` +
      (shown.length
        ? shown
            .map(
              (e) =>
                `<button class="fb-entry" data-fbpath="${esc(e.path)}"><span class="fb-ic">📁</span><span class="fb-nm">${esc(e.name)}</span>${e.isCodebase ? '<span class="fb-badge">code</span>' : ""}</button>`,
            )
            .join("")
        : `<div class="fb-empty">no subfolders${fsFilter ? " match" : ""}</div>`) +
      (d.truncated > 0 ? `<div class="fb-more">+${d.truncated} more — filter to narrow</div>` : "") +
      `</div>` +
      `<div class="fb-foot">` +
      (gateOk
        ? `<button class="rm-add-go" id="rg-fb-index">Index this folder</button>`
        : `<div class="fb-block">This doesn't look like a code repository. <button class="fb-anyway" id="rg-fb-anyway">index anyway</button></div>`) +
      `<button class="fb-alt" id="rg-fb-text">enter a path instead</button>` +
      `<div class="rm-add-err" id="rg-idx-err"></div></div>`;

    panel.querySelectorAll<HTMLElement>(".fb-entry[data-fbpath]").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        void navigateFs(b.dataset.fbpath);
      };
    });
    const up = panel.querySelector<HTMLElement>("#rg-fb-up");
    if (up && d.parent) up.onclick = (e) => { e.stopPropagation(); void navigateFs(d.parent ?? undefined); };
    const filt = panel.querySelector<HTMLInputElement>("#rg-fb-filter");
    filt?.addEventListener("click", (e) => e.stopPropagation());
    filt?.addEventListener("input", () => {
      fsFilter = filt.value;
      renderBrowserPanel();
      const f = panel.querySelector<HTMLInputElement>("#rg-fb-filter");
      f?.focus();
      f?.setSelectionRange(f.value.length, f.value.length);
    });
    const idx = panel.querySelector<HTMLElement>("#rg-fb-index");
    if (idx) idx.onclick = (e) => { e.stopPropagation(); void submitIndex(d.dir, panel.querySelector<HTMLElement>("#rg-idx-err")); };
    const anyway = panel.querySelector<HTMLElement>("#rg-fb-anyway");
    if (anyway) anyway.onclick = (e) => { e.stopPropagation(); fsOverride = true; renderBrowserPanel(); };
    const toText = panel.querySelector<HTMLElement>("#rg-fb-text");
    if (toText) toText.onclick = (e) => { e.stopPropagation(); renderTextPanel(); };
  }

  // Advanced fallback: the manual path text-input, behind "enter a path
  // instead". Feeds the same submitIndex sink as the browser.
  function renderTextPanel(): void {
    const panel = repoMenu?.querySelector<HTMLElement>("#rg-idx-panel");
    if (!panel) return;
    panel.innerHTML =
      `<div class="fb-textwrap"><input class="rm-add-inp" id="rg-idx-inp" type="text" placeholder="/absolute/path/to/repo" autocomplete="off" spellcheck="false" />` +
      `<button class="rm-add-go" id="rg-idx-go">Index</button></div>` +
      `<button class="fb-alt" id="rg-fb-browse">browse instead</button>` +
      `<div class="rm-add-err" id="rg-idx-err"></div>`;
    const inp = panel.querySelector<HTMLInputElement>("#rg-idx-inp");
    const go = panel.querySelector<HTMLElement>("#rg-idx-go");
    const err = panel.querySelector<HTMLElement>("#rg-idx-err");
    inp?.addEventListener("click", (e) => e.stopPropagation());
    inp?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submitIndex(inp.value.trim(), err);
      }
    });
    if (go && inp) go.onclick = (e) => { e.stopPropagation(); void submitIndex(inp.value.trim(), err); };
    panel.querySelector<HTMLElement>("#rg-fb-browse")?.addEventListener("click", (e) => {
      e.stopPropagation();
      void navigateFs(undefined);
    });
    inp?.focus();
  }

  // Reload during a build of the CURRENTLY-VIEWED repo → re-attach: show
  // indexing + poll until ready. Never restarts (no auto-POST) and never shows
  // done early (poll navigates only on state==="ready").
  async function maybeReattachIndexing(): Promise<void> {
    await loadRepos();
    const ix = repoList.find((r) => r.id === repoHash && r.state === "indexing");
    if (ix) {
      currentIndexHash = ix.id;
      showIndexProgress(ix.name, null, null);
      startPolling(ix.id);
    }
  }
  void maybeReattachIndexing();

  // ── Trace toolbar (enter · entrypoint picker · exit via crumb) ───
  function phSyncBar(): void {
    const bar = root.querySelector<HTMLElement>("#rg-phbar");
    if (!bar) return;
    if (S.level !== "trace") {
      bar.innerHTML = `<button class="ph-enter" id="rg-ph-enter"><span class="pi">⟜</span>Trace a path</button>`;
      root.classList.remove("ph-active-bar");
      const b = bar.querySelector<HTMLElement>("#rg-ph-enter");
      if (b) b.onclick = () => void phEnterDefault();
      return;
    }
    root.classList.add("ph-active-bar");
    const ep = S.trace.entrypoints.find((e) => e.id === S.trace.ep);
    // For user-chosen roots (no matching preset), derive a human label from
    // the entry node's parsed fn name rather than showing the raw node id.
    const entryNodeFn = S.trace.data?.nodes.find((n) => n.id === S.trace.data?.spine[0])?.fn;
    // No root yet (search-fallback entry) → prompt instead of an empty label.
    const label = ep?.label ?? (entryNodeFn ? `${entryNodeFn}()` : S.trace.ep || "choose a function…");
    const cov = S.trace.coverage;
    // The chip sits in the RIGHT cluster adjacent to the entry button.
    // ph-bar layout in trace mode: [.ph-spacer (flex:1)] [chip-wrap] [pick-wrap]
    // The shared .ph-spacer (same class as the pagehead spacer) pushes chip+pick to
    // the trailing edge; the pick wrapper's old ph-pwrap-right (margin-left:auto) class
    // is retired (its name said "pick wrapper right", not "spacer").
    // .ph-cwrap provides position:relative for the popover anchor; align:"right" extends
    // the popover leftward from the chip's right edge — correct for a chip at the
    // toolbar's right edge (avoids off-screen clipping).
    // .ph-cpop skeleton removed — popover is anchor-popover (build-on-open/remove-on-close).
    const covHtml = cov
      ? `<div class="ph-cwrap"><button class="ph-covinfo ${covCls(cov.tier)}" id="rg-ph-cov" aria-expanded="false" title="Click to see why">` +
        `<span class="cb-dot"></span>confidence <b>${cov.pct}%</b><span class="cb-go">${confidenceTierWord(cov.tier)}</span><span class="cv">▾</span>` +
        `</button></div>`
      : "";
    bar.innerHTML =
      `<div class="ph-spacer" aria-hidden="true"></div>` +
      covHtml +
      `<div class="ph-pwrap"><button class="ph-pick" id="rg-ph-pick">` +
      `<span class="pi">▶</span><span class="pl">entry</span><b>${esc(label)}</b><span class="cv">▾</span>` +
      `</button><div class="ph-menu ph-menu-right" id="rg-ph-menu"></div></div>`;
    const pick = bar.querySelector<HTMLElement>("#rg-ph-pick");
    if (pick)
      pick.onclick = (e) => {
        e.stopPropagation();
        const m = root.querySelector<HTMLElement>("#rg-ph-menu");
        if (!m) return;
        closeEpMenu();
        const open = m.classList.toggle("open");
        pick.classList.toggle("open", open);
        if (open) renderEpMenu();
      };
    // Wire covBtn → anchor-popover.
    // .ph-cwrap provides position:relative (RepoGraph.tsx CSS). align:"right" — chip is
    // now at the right cluster; popover extends leftward from chip's right edge, correct
    // geometry (no off-screen clip). Flipped from "left" to match the chip's new position.
    const covBtn = bar.querySelector<HTMLElement>("#rg-ph-cov");
    if (covBtn && cov)
      covBtn.onclick = (e) => {
        e.stopPropagation();
        // fileCount: same-page single source, honest fallback when absent (#rg-st-files)
        const rawFiles = document.getElementById("rg-st-files")?.textContent ?? "";
        const parsedFiles = parseInt(rawFiles.replace(/,/g, ""), 10);
        const fileCount = Number.isNaN(parsedFiles) ? undefined : parsedFiles;
        openAnchorPopover({
          trigger: covBtn,
          contentHtml: buildConfidencePopoverHtml({ ...cov, fileCount }),
          ariaLabel: confidencePopoverTitle(cov.tier),
          width: 320,
          align: "right",
        });
      };
  }

  function covCls(tier: string): string {
    return tier === "green" ? "ok" : tier === "yellow" ? "warn" : "bad";
  }
  // covWord() and renderCovPop() DELETED — replaced by:
  //   confidenceTierWord() in repo-graph-popovers.ts (chip label)
  //   buildConfidencePopoverHtml() in repo-graph-popovers.ts (popover)
  //   openAnchorPopover() from anchor-popover.ts (primitive)
  // Retired 2026-06-12.

  // Legend chip (bottom-left of the stage) → key for line styles, node fills,
  // badges. Verbatim from the mockup. Created on enter, removed on exit.
  function phLegend(): void {
    let el = root.querySelector<HTMLElement>("#rg-ph-legend");
    if (!el) {
      el = document.createElement("div");
      el.id = "rg-ph-legend";
      stage.appendChild(el);
    }
    el.innerHTML =
      `<button class="lg-btn" id="rg-ph-legbtn"><span>?</span> Legend · what these mean</button>` +
      `<div class="lg-pop" id="rg-ph-legpop">` +
      `<div class="lg-h">Edges</div>` +
      `<div class="lg-row"><svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="#c9871f" stroke-width="3"/></svg><span><b>Solid ochre</b> · a resolved (confirmed) call — the path follows it</span></div>` +
      `<div class="lg-row"><svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="#c0531a" stroke-width="2.5" stroke-dasharray="6 5"/></svg><span><b>Dashed</b> · an unresolved next step (named, but not indexed)</span></div>` +
      `<div class="lg-row"><svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="#9b2d1f" stroke-width="2.5" stroke-dasharray="1.5 5"/></svg><span><b>Red dotted</b> · there's a next step, but static analysis can't tell who</span></div>` +
      `<div class="lg-h">Nodes</div>` +
      `<div class="lg-row"><span class="lg-sw white"></span><span><b>White</b> · a function on the path</span></div>` +
      `<div class="lg-row"><span class="lg-sw red"></span><span><b>Red dotted</b> · an unresolvable next step (static can't link it — no guessing)</span></div>` +
      `<div class="lg-row"><span class="lg-sw dim"></span><span><b>Dimmed</b> · off-path: reachable nearby but not on this route — context only</span></div>` +
      `<div class="lg-h">Badges</div>` +
      `<div class="lg-row"><span class="lg-bdg">▶ entry</span><span>Start of the path · you are here</span></div>` +
      `<div class="lg-row"><span class="lg-bdg">⚠</span><span>Path may continue — an unresolved next step the static pass couldn't link</span></div>` +
      `</div>`;
    const btn = el.querySelector<HTMLElement>("#rg-ph-legbtn");
    const lpop = el.querySelector<HTMLElement>("#rg-ph-legpop");
    if (btn && lpop)
      btn.onclick = (e) => {
        e.stopPropagation();
        lpop.classList.toggle("open");
      };
  }

  function removePhLegend(): void {
    root.querySelector("#rg-ph-legend")?.remove();
  }

  // Close all trace overlays (ep menu, legend popover). Used by Esc + level
  // transitions so nothing stays stuck.
  // NOTE: confidence popover (.ph-cpop) retired — anchor-popover handles its own
  // close via Escape (capture phase) and outside-click (mousedown). No manual
  // close needed here.
  function phCloseOverlays(): void {
    closeEpMenu();
    root.querySelector("#rg-ph-legpop")?.classList.remove("open");
  }

  // Timer handle for the in-picker function search debounce.
  let epSearchTimer: ReturnType<typeof setTimeout> | null = null;
  // Keyboard-nav state for the in-picker search (mirrors the toolbar
  // search's curResults/hlIdx). epHits = current function results, epHl = the
  // highlighted index.
  let epHits: SearchHit[] = [];
  let epHl = 0;
  let epSearchGen = 0;
  const epOptId = (i: number): string => `rg-ph-fnopt-${i}`;

  // Invalidate any pending/in-flight picker search and clear its highlight state.
  // Bumping the generation makes a slow fetch's runEpSearch bail before it writes
  // into a detached/rebuilt menu; called on menu close + rebuild.
  function resetEpSearch(): void {
    if (epSearchTimer !== null) {
      clearTimeout(epSearchTimer);
      epSearchTimer = null;
    }
    epHits = [];
    epHl = 0;
    epSearchGen += 1;
  }

  // Build the function node-id from a SearchHit that is kind=symbol+function.
  // Delegates to the shared `funcNodeId` so the search pick and the tree pick of
  // one function produce a byte-identical id (same sink).
  function fnNodeId(h: SearchHit): string {
    return funcNodeId(pathLabel(h), h.name);
  }

  // Paint the keyboard highlight (.hl + aria-selected) onto the picker-search
  // results and point the input's aria-activedescendant at the active option.
  function paintEpHl(inp: HTMLInputElement, res: HTMLElement): void {
    const opts = res.querySelectorAll<HTMLElement>(".ph-fn-result");
    opts.forEach((el, i) => {
      const on = i === epHl;
      el.classList.toggle("hl", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
      if (on) el.scrollIntoView({ block: "nearest" });
    });
    inp.setAttribute("aria-activedescendant", opts.length ? epOptId(epHl) : "");
  }

  // Root the trace at the highlighted picker-search result (keyboard Enter or click).
  function selectEpHit(h: SearchHit): void {
    closeEpMenu();
    void phTraceFromNode(fnNodeId(h));
  }

  // ── Retained "Traced functions" list (per-repo localStorage) ──
  interface TracedEntry {
    nodeId: string;
    fn: string;
  }
  const TRACED_CAP = 12;
  const tracedKey = (): string => `siltpoke:traced:${repoHash}`;
  function loadTraced(): TracedEntry[] {
    if (!repoHash) return [];
    try {
      const raw = localStorage.getItem(tracedKey());
      const list = raw ? (JSON.parse(raw) as TracedEntry[]) : [];
      return Array.isArray(list)
        ? list.filter((e) => e && typeof e.nodeId === "string" && typeof e.fn === "string")
        : [];
    } catch {
      return [];
    }
  }
  function saveTraced(list: TracedEntry[]): void {
    if (!repoHash) return;
    try {
      localStorage.setItem(tracedKey(), JSON.stringify(list.slice(0, TRACED_CAP)));
    } catch {
      /* storage full/disabled — degrade silently (the list just won't persist) */
    }
  }
  // Dedup-by-recency: re-tracing a fn moves it to the top, never duplicates; LRU cap.
  function addTraced(nodeId: string, fn: string): void {
    const list = loadTraced().filter((e) => e.nodeId !== nodeId);
    list.unshift({ nodeId, fn });
    saveTraced(list);
  }
  function removeTraced(nodeId: string): void {
    saveTraced(loadTraced().filter((e) => e.nodeId !== nodeId));
  }
  // Retain the current root after a trace — function roots only (presets are
  // auto-detected, not user-chosen, so they are not retained).
  function retainCurrent(): void {
    const ep = S.trace.ep;
    if (!ep.startsWith("function:")) return;
    const d = S.trace.data;
    if (!d) return;
    const fn = d.nodes.find((n) => n.id === d.spine[0])?.fn ?? ep.split(":").pop() ?? ep;
    addTraced(ep, fn);
  }

  // Render the self-contained "trace from a function…" search section inside
  // the ep menu. Called once when the menu HTML is first written; attaches its
  // own input + results listeners without touching the main toolbar search.
  function attachEpSearch(menu: HTMLElement): void {
    const inp = menu.querySelector<HTMLInputElement>("#rg-ph-fn-inp");
    const res = menu.querySelector<HTMLElement>("#rg-ph-fn-res");
    if (!inp || !res) return;

    // a11y — input is a combobox controlling a listbox of results.
    inp.setAttribute("role", "combobox");
    inp.setAttribute("aria-autocomplete", "list");
    inp.setAttribute("aria-controls", "rg-ph-fn-res");
    inp.setAttribute("aria-expanded", "false");
    res.setAttribute("role", "listbox");

    inp.addEventListener("input", () => {
      if (epSearchTimer !== null) clearTimeout(epSearchTimer);
      const q = inp.value.trim();
      if (!q) {
        res.innerHTML = "";
        res.classList.remove("open");
        resetEpSearch();
        inp.setAttribute("aria-expanded", "false");
        inp.removeAttribute("aria-activedescendant");
        return;
      }
      epSearchTimer = setTimeout(() => void runEpSearch(q, res), 150);
    });

    // Keyboard nav, mirroring the toolbar search (doSearch keydown).
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        res.innerHTML = "";
        res.classList.remove("open");
        resetEpSearch();
        inp.setAttribute("aria-expanded", "false");
        inp.removeAttribute("aria-activedescendant");
        return;
      }
      if (!res.classList.contains("open") || epHits.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        epHl = Math.min(epHl + 1, epHits.length - 1);
        paintEpHl(inp, res);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        epHl = Math.max(epHl - 1, 0);
        paintEpHl(inp, res);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const h = epHits[epHl];
        if (h) selectEpHit(h);
      }
    });

    // Stop outside-click handler from closing the menu while typing.
    inp.addEventListener("click", (e) => e.stopPropagation());
  }

  async function runEpSearch(q: string, res: HTMLElement): Promise<void> {
    const inp = root.querySelector<HTMLInputElement>("#rg-ph-fn-inp");
    const gen = epSearchGen;
    let fnHits: SearchHit[] = [];
    try {
      const r = await fetch(withRepo(`/api/repo-graph/search?q=${encodeURIComponent(q)}&limit=12`));
      if (r.ok) {
        const body = (await r.json()) as { data: { hits: SearchHit[] } };
        fnHits = (body.data.hits ?? []).filter((h) => h.kind === "symbol" && h.symbolKind === "function");
      }
    } catch {
      /* leave empty */
    }
    // A newer search/close/rebuild superseded this in-flight fetch — drop it so it
    // can't write into a detached menu or leave stale results actionable.
    if (gen !== epSearchGen) return;
    epHits = fnHits;
    epHl = 0;
    if (fnHits.length === 0) {
      res.innerHTML = `<div class="ph-fn-empty">no function matches</div>`;
      inp?.removeAttribute("aria-activedescendant");
    } else {
      // Reuse the preset entrypoint-row component (.ph-ep: dot + bold name
      // over a dimmed mono path) so presets, retained traces, and search results
      // read as one consistent list. role=option + ids so aria-activedescendant +
      // keyboard nav work; the first result is highlighted by default.
      res.innerHTML = fnHits
        .map((h, i) => {
          const on = i === 0;
          return (
            `<button class="ph-ep ph-fn-result${on ? " hl" : ""}" id="${epOptId(i)}" role="option" aria-selected="${on ? "true" : "false"}" data-fnid="${esc(fnNodeId(h))}">` +
            `<span class="ep-dot"></span>` +
            `<span class="ep-m"><b>${esc(h.name)}</b><span class="ep-meta">${esc(pathLabel(h))}</span></span>` +
            `</button>`
          );
        })
        .join("");
      res.querySelectorAll<HTMLElement>(".ph-fn-result").forEach((btn, i) => {
        btn.onclick = () => {
          const h = epHits[i];
          if (h) selectEpHit(h);
        };
        // Keep mouse hover + keyboard highlight in sync.
        btn.addEventListener("mouseenter", () => {
          epHl = i;
          if (inp) paintEpHl(inp, res);
        });
      });
      inp?.setAttribute("aria-activedescendant", epOptId(0));
    }
    res.classList.add("open");
    // The popup is visible whether or not there are matches (the "no function
    // matches" message still shows), so the combobox is expanded either way.
    inp?.setAttribute("aria-expanded", "true");
  }

  // The browse-to-a-function tree region (subdir → file → function), additive
  // below the search box. Renders from CACHE ONLY (filesFor / symbolsFor) — the
  // click handlers do the lazy ensureFiles / ensureSymbols then re-render, so
  // nothing fetches until a node is expanded. A file's "N fns" badge comes from
  // the subdir's /files fetch (the `functions` field), so a "0 fns" file needs no /symbols
  // fetch at all — it isn't expandable.
  // The tree's inner rows only (the scrollable content). Split out so a
  // expand/collapse can re-render JUST the rows inside the existing `.ph-tree`
  // scroll container — which preserves scrollTop — instead of rebuilding the whole
  // menu (which recreates the container and jumps it back to the top).
  function treeRowsHtml(): string {
    const subs = treeSubdirs(proj.subdirs ?? []);
    return subs
      .map((s) => {
        const subOpen = S.trace.treeSubs.has(s.id);
        let html =
          `<button class="ph-tree-row ph-tree-sub${subOpen ? " open" : ""}" data-tree-sub="${esc(s.id)}">` +
          `<span class="ph-tw">${subOpen ? "▾" : "▸"}</span><span class="ph-tlabel">${esc(s.label)}</span></button>`;
        if (!subOpen) return html;
        html += treeFiles(filesFor(s.id))
          .map((f) => {
            const key = `${s.id}/${f.path}`;
            const fileOpen = S.trace.treeFiles.has(key);
            const hasFns = f.functions > 0;
            const caret = hasFns ? (fileOpen ? "▾" : "▸") : "·";
            let fh =
              `<button class="ph-tree-row ph-tree-file${fileOpen ? " open" : ""}${hasFns ? "" : " empty"}" data-tree-file="${esc(key)}"${hasFns ? "" : ' data-empty="1"'}>` +
              `<span class="ph-tw">${caret}</span><span class="ph-tlabel">${esc(f.name)}</span>` +
              `<span class="ph-fns${hasFns ? "" : " zero"}">${f.functions} fns</span></button>`;
            if (fileOpen && hasFns) {
              fh += treeFunctions(symbolsFor(s.id, f.path), f.path)
                .map(
                  (l) =>
                    `<button class="ph-tree-row ph-tree-fn" data-tree-fn="${esc(l.rawNodeId)}" title="Trace from ${esc(l.name)}()">` +
                    `<span class="ph-tw"></span><span class="ph-tlabel">${esc(l.name)}()</span></button>`,
                )
                .join("");
            }
            return fh;
          })
          .join("");
        return html;
      })
      .join("");
  }

  function renderTreeRegion(): string {
    if ((proj.subdirs ?? []).length === 0) return "";
    return (
      `<div class="ph-fn-div"></div>` +
      `<div class="ph-mh ph-fn-sub">Or browse to a function…</div>` +
      `<div class="ph-tree">${treeRowsHtml()}</div>`
    );
  }

  // Re-render ONLY the tree rows inside the existing `.ph-tree` scroll container,
  // preserving its scroll position — used by expand/collapse so a click deep in a
  // long list (e.g. web's 143 files) doesn't bounce the view back to the top.
  function renderTree(): void {
    const treeEl = root.querySelector<HTMLElement>("#rg-ph-menu .ph-tree");
    if (!treeEl) return;
    const savedScroll = treeEl.scrollTop;
    treeEl.innerHTML = treeRowsHtml();
    treeEl.scrollTop = savedScroll;
    wireTree();
  }

  // Wire the tree's expand/collapse + leaf-pick handlers. Shared by the full menu
  // render (renderEpMenu) and the tree-only re-render (renderTree).
  function wireTree(): void {
    const menu = root.querySelector<HTMLElement>("#rg-ph-menu");
    if (!menu) return;
    menu.querySelectorAll<HTMLElement>("[data-tree-sub]").forEach((b) => {
      b.onclick = async (e) => {
        // Expand/collapse is intra-menu navigation — must NOT bubble to the
        // document outside-click handler (which would close the picker), and
        // re-renders ONLY the tree (renderTree) so scroll position is kept.
        e.stopPropagation();
        const id = b.dataset.treeSub ?? "";
        if (S.trace.treeSubs.has(id)) S.trace.treeSubs.delete(id);
        else {
          S.trace.treeSubs.add(id);
          await ensureFiles(id);
        }
        renderTree();
      };
    });
    menu.querySelectorAll<HTMLElement>("[data-tree-file]").forEach((b) => {
      if (b.dataset.empty) return; // 0-fns file: badge only, not expandable
      b.onclick = async (e) => {
        e.stopPropagation();
        const key = b.dataset.treeFile ?? "";
        const slash = key.indexOf("/");
        if (slash < 0) return;
        const subId = key.slice(0, slash);
        const path = key.slice(slash + 1);
        if (S.trace.treeFiles.has(key)) S.trace.treeFiles.delete(key);
        else {
          S.trace.treeFiles.add(key);
          await ensureSymbols(subId, path);
        }
        renderTree();
      };
    });
    menu.querySelectorAll<HTMLElement>("[data-tree-fn]").forEach((b) => {
      b.onclick = () => {
        // A function-leaf pick IS the final selection → close + trace (same sink
        // as the search box).
        closeEpMenu();
        void phTraceFromNode(b.dataset.treeFn ?? "");
      };
    });
  }

  function renderEpMenu(): void {
    const menu = root.querySelector<HTMLElement>("#rg-ph-menu");
    if (!menu) return;
    // The menu DOM is rebuilt here (innerHTML) — invalidate any prior/in-flight
    // search so its results can't write into the now-detached nodes.
    resetEpSearch();
    const hasPresets = S.trace.entrypoints.length > 0;
    const stepStr = (n: number): string => `${n} step${n === 1 ? "" : "s"}`;
    const curEp = S.trace.ep;
    // The retained "Traced functions" section (per-repo localStorage).
    // It SUBSUMES the old single current-root slot — the active root is one of
    // these rows, marked "current". Presets stay a separate, distinct section
    // (auto-detected vs user-chosen). Each row has a × to forget it.
    const traced = loadTraced();
    const tracedHtml = traced.length
      ? `<div class="ph-mh ph-traced-h">Traced functions</div>` +
        traced
          .map((t) => {
            const sel = t.nodeId === curEp;
            const tc = traceCache.get(t.nodeId);
            const meta = tc ? stepStr(tc.spine.length) : "traced";
            return (
              `<div class="ph-traced-row${sel ? " sel" : ""}">` +
              `<button class="ph-ep" data-ep="${esc(t.nodeId)}"><span class="ep-dot"></span>` +
              `<span class="ep-m"><b>${esc(t.fn)}()</b><span class="ep-meta">${esc(meta)}</span></span>` +
              `${sel ? '<span class="ep-on">current</span>' : ""}</button>` +
              `<button class="ph-ferase" data-forget="${esc(t.nodeId)}" title="Forget this trace" aria-label="Forget ${esc(t.fn)}()">×</button>` +
              `</div>`
            );
          })
          .join("")
      : "";

    if (hasPresets) {
      // Presets-first layout: presets · traced-functions · persistent search.
      menu.innerHTML =
        `<div class="ph-mh">Where to start · entrypoint</div>` +
        S.trace.entrypoints
          .map((e) => {
            const sel = e.id === S.trace.ep;
            const tc = traceCache.get(e.id);
            const steps = tc ? stepStr(tc.spine.length) : "…";
            return (
              `<button class="ph-ep${sel ? " sel" : ""}" data-ep="${esc(e.id)}"><span class="ep-dot"></span>` +
              `<span class="ep-m"><b>${esc(e.label)}</b><span class="ep-meta">${esc(e.fn)}() · ${steps}</span></span>` +
              `${sel ? '<span class="ep-on">active</span>' : ""}</button>`
            );
          })
          .join("") +
        tracedHtml +
        `<div class="ph-fn-div"></div>` +
        `<div class="ph-mh ph-fn-sub">Or trace from a function…</div>` +
        `<div class="ph-fn-search"><input id="rg-ph-fn-inp" class="ph-fn-inp" type="text" placeholder="function name…" autocomplete="off" spellcheck="false" /></div>` +
        `<div class="ph-fn-res" id="rg-ph-fn-res"></div>` +
        renderTreeRegion() +
        `<div class="ph-mf">Pick an entrypoint → highlight its path, dim the rest. It won't decide for you.</div>`;
      void prefetchTraceCounts();
    } else {
      // No-preset layout: traced functions (if any) + the search.
      menu.innerHTML =
        `<div class="ph-mh">Trace from a function…</div>` +
        tracedHtml +
        `<div class="ph-fn-search"><input id="rg-ph-fn-inp" class="ph-fn-inp" type="text" placeholder="function name…" autocomplete="off" spellcheck="false" /></div>` +
        `<div class="ph-fn-res" id="rg-ph-fn-res"></div>` +
        renderTreeRegion() +
        `<div class="ph-mf">Type a function name to search this repo's call graph.</div>`;
    }

    // Wire [data-ep] in BOTH layouts — presets AND the retained traced-function
    // rows both carry data-ep, so the handler must cover both sections.
    menu.querySelectorAll<HTMLElement>("[data-ep]").forEach((b) => {
      b.onclick = () => {
        closeEpMenu();
        void phSetEp(b.dataset.ep ?? "cli");
      };
    });
    // × forgets a retained trace. stopPropagation so it doesn't also re-root
    // the row. Removing the CURRENTLY-VIEWED one drops the record + its "current"
    // marker but leaves S.trace.data (the graph) intact — re-render only.
    menu.querySelectorAll<HTMLElement>("[data-forget]").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        if (!b.dataset.forget) return;
        removeTraced(b.dataset.forget);
        renderEpMenu();
      };
    });
    wireTree();
    attachEpSearch(menu);
  }

  function closeEpMenu(): void {
    resetEpSearch();
    root.querySelector<HTMLElement>("#rg-ph-menu")?.classList.remove("open");
    root.querySelector<HTMLElement>("#rg-ph-pick")?.classList.remove("open");
  }

  // Fetch the other entrypoints' traces (cached) so the picker can show real
  // "N steps" counts; re-render the menu if it's open when they arrive.
  async function prefetchTraceCounts(): Promise<void> {
    let changed = false;
    for (const e of S.trace.entrypoints) {
      if (!traceCache.has(e.id)) {
        const d = await ensureTrace(e.id);
        if (d) changed = true;
      }
    }
    if (changed && root.querySelector("#rg-ph-menu")?.classList.contains("open")) renderEpMenu();
  }

  // The toolbar "Trace a path" button must always land somewhere live.
  // It used to hardcode phEnter("cli"), which dead-ended on a no-preset repo
  // — "cli" doesn't resolve, so the stage showed an empty
  // "no call path" trace. Pick a sensible default root instead. Priority:
  //   1. most-recent retained user trace (honor their last manual intent)
  //   2. first detected preset entrypoint
  //   3. neither resolves → open the picker focused on function-search, never a
  //      dead trace (there is always a way in).
  async function phEnterDefault(): Promise<void> {
    await ensureEntrypoints();
    const candidates: string[] = [];
    const recentTraced = loadTraced()[0]?.nodeId;
    if (recentTraced) candidates.push(recentTraced);
    const firstPreset = S.trace.entrypoints[0]?.id;
    if (firstPreset && firstPreset !== recentTraced) candidates.push(firstPreset);
    for (const ep of candidates) {
      const data = await ensureTrace(ep);
      if (data && data.spine.length > 0) {
        await phEnter(ep);
        return;
      }
    }
    phOpenSearch();
  }

  // Fallback: enter trace level with no committed root and surface the
  // picker's function-search, focused. The stage shows a friendly "search to
  // start" note (sceneTrace), not a broken trace.
  function phOpenSearch(): void {
    S.trace.ep = "";
    S.trace.data = null;
    S.level = "trace";
    S.subId = null;
    S.file = null;
    S.selected = null;
    S.trace.expanded = new Set();
    S.trace.offFor = null;
    closePanel();
    phSyncBar();
    render(true);
    phLegend();
    const pick = root.querySelector<HTMLElement>("#rg-ph-pick");
    const menu = root.querySelector<HTMLElement>("#rg-ph-menu");
    if (pick && menu) {
      pick.classList.add("open");
      menu.classList.add("open");
      renderEpMenu();
      menu.querySelector<HTMLInputElement>("#rg-ph-fn-inp")?.focus();
    }
  }

  async function phEnter(ep: string): Promise<void> {
    await ensureEntrypoints();
    S.trace.ep = ep || S.trace.ep || "cli";
    const data = await ensureTrace(S.trace.ep);
    S.trace.data = data;
    S.level = "trace";
    S.subId = null;
    S.file = null;
    S.selected = null;
    S.trace.expanded = new Set();
    S.trace.offFor = null;
    closePanel();
    phSyncBar();
    // Open the entry card FIRST, then fit — so fit()'s panel-aware availW
    // excludes the ~360px card and the spine centers in the gap between the
    // sidebar and the card (not the full stage). The auto-selected entry shows
    // ITS off-path cluster too (consistent with click-selecting any spine node)
    // so the initial frame already matches the post-"fit" layout, not offset left.
    const entryId = data?.spine[0];
    if (entryId) {
      S.selected = entryId;
      S.trace.offFor = entryId;
      openTracePanel(entryId);
    }
    render(true);
    phLegend();
    void prefetchTraceCounts();
  }

  async function phSetEp(ep: string): Promise<void> {
    S.trace.ep = ep;
    const data = await ensureTrace(ep);
    S.trace.data = data;
    retainCurrent();
    S.trace.expanded = new Set();
    S.trace.offFor = null;
    S.selected = null;
    // Open the new entry's card before fitting (panel-aware centering, as in phEnter).
    const entryId = data?.spine[0];
    if (entryId) {
      S.selected = entryId;
      S.trace.offFor = entryId; // show the entry's off-path cluster on select (matches click-select)
      openTracePanel(entryId);
    } else {
      closePanel();
    }
    render(true);
    phSyncBar();
  }

  // Enter trace rooted at an arbitrary function node chosen from the
  // symbol panel. Mirrors phEnter but does NOT call ensureEntrypoints() — the
  // raw node id is passed directly to ensureTrace (backend resolves it, already
  // proven). Level transitions and state teardown are identical to phEnter.
  async function phTraceFromNode(rawNodeId: string): Promise<void> {
    S.trace.ep = rawNodeId;
    const data = await ensureTrace(rawNodeId);
    S.trace.data = data;
    retainCurrent();
    S.level = "trace";
    S.subId = null;
    S.file = null;
    S.selected = null;
    S.trace.expanded = new Set();
    S.trace.offFor = null;
    closePanel();
    phSyncBar();
    const entryId = data?.spine[0];
    if (entryId) {
      S.selected = entryId;
      S.trace.offFor = entryId; // show the entry's off-path cluster on select (matches click-select)
      openTracePanel(entryId);
    }
    render(true);
    phLegend();
    void prefetchTraceCounts();
  }

  // Outside-click closes the trace toolbar overlays (ep menu, legend popover).
  // NOTE: confidence chip click → anchor-popover; it self-closes on outside mousedown.
  // The old #rg-ph-cpop / #rg-ph-cov click guards are REMOVED (dead code, 2026-06-12).
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest("#rg-ph-pick, #rg-ph-menu")) closeEpMenu();
    if (!t.closest("#rg-ph-legend")) root.querySelector("#rg-ph-legpop")?.classList.remove("open");
  });

  // Keyboard in trace mode. ↑/↓ walk the path (card open); Esc closes the
  // open overlay, else the card — never leaves anything stuck.
  document.addEventListener("keydown", (e) => {
    if (S.level !== "trace") return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "Escape") {
      // #rg-ph-cpop.open removed — anchor-popover handles its own Escape (capture phase).
      // anyOpen now checks ep-menu + legend only.
      const anyOpen = !!root.querySelector("#rg-ph-menu.open, #rg-ph-legpop.open");
      phCloseOverlays();
      if (!anyOpen && panelEl?.classList.contains("open")) {
        S.selected = null;
        S.trace.offFor = null;
        closePanel();
        render(false);
        refitTrace();
      }
      return;
    }
    if (!panelEl?.classList.contains("open")) return;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      phStep(-1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      phStep(1);
    }
  });

  // ── boot ────────────────────────────────────────────────────────────────
  phSyncBar();
  render(true);
  window.addEventListener("resize", () => {
    if (SCENE) applyView();
  });
}

export function registerRepoGraph(Alpine: AlpineGlobal): void {
  Alpine.data("repoGraph", () => ({
    init(this: { $root: HTMLElement }) {
      bootRepoGraph(this.$root);
    },
  }));
}

function selfRegister(): void {
  if (typeof globalThis === "undefined") return;
  if (globalThis.Alpine) {
    // hx-boost: Alpine already running; the x-data root was morphed in before
    // this module registered the factory. Replace each stale node with a fresh
    // clone (drops Alpine's _x_dataStack) and initTree it against the now-
    // registered factory.
    registerRepoGraph(globalThis.Alpine);
    if (typeof document !== "undefined") {
      document.querySelectorAll('[x-data="repoGraph"]').forEach((el) => {
        const node = el as HTMLElement;
        if ((node as unknown as { _x_dataStack?: unknown })._x_dataStack && node.parentNode) {
          const fresh = node.cloneNode(true) as HTMLElement;
          node.parentNode.replaceChild(fresh, node);
          globalThis.Alpine?.initTree?.(fresh);
        } else {
          globalThis.Alpine?.initTree?.(node);
        }
      });
    }
    return;
  }
  if (typeof document !== "undefined") {
    document.addEventListener(
      "alpine:init",
      () => {
        if (globalThis.Alpine) registerRepoGraph(globalThis.Alpine);
      },
      { once: true },
    );
  }
}
selfRegister();

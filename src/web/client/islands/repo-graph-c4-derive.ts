// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * /repo-graph Architecture View — Layer 1 "honest subset" C4 derivation.
 *
 * Builds a C4Model (the same shape the renderer consumes) from the
 * structural `ArchitectureProjection` — no LLM, no fabrication, free + instant.
 * This is the "ungenerated state" of the full C4: shown the moment a repo opens,
 * before (or instead of) the paid LLM-derived generate (Layer 2).
 *
 * Mapping: boundary = repo name · bands = projection groups ·
 * one `cont` container per subdir · edges = import counts (neutral label). No
 * verbs, no ext/person, no tech tags, no Key pieces — those are honest only with
 * the grounded LLM pass. Every node/edge is structural fact (cited); this layer renders
 * them solid with no tier styling.
 *
 * Coordinates: the renderer consumes authored x/y/w/h, so the derived model must
 * GENERATE them (`layoutC4Bands`, shared with the Layer-2 generated model).
 */
import {
  GROUP_ACCENT,
  type C4Accent,
  type C4Band,
  type C4Boundary,
  type C4Edge,
  type C4Model,
  type C4Node,
} from "./repo-graph-c4-model";
// ── projection shape (mirrors src/repo-graph/project-architecture.ts) ──────────
interface ProjGroup {
  id: string;
  title: string;
  short: string;
  accent: string;
}
interface ProjSubdir {
  id: string;
  group: string;
  /** Full container path (e.g. "backend/apps/ledger/"). Drives the degraded
   * first-segment band grouping; optional so pre-`path` fixtures degrade safely. */
  path?: string;
  files: number;
  funcCount?: number;
  recurringBasenames?: Array<{ name: string; count: number }>;
  purpose: string;
  inbound: number;
  outbound: number;
}
interface ProjEdge {
  source: string;
  target: string;
  weight: number;
}
export interface DerivableProjection {
  repo: { name: string; groupingMode?: "semantic" | "fallback" };
  groups: ProjGroup[];
  subdirs: ProjSubdir[];
  edges: ProjEdge[];
}

/** Cycle the 4 authored accent names so any group count keeps the warm palette.
 * Node dot color + band tint both key off this name → they stay consistent. */
const ACCENT_CYCLE: readonly C4Accent[] = ["sky", "terra", "moss", "amber"];

/** Band tint (bg + label color) per accent — copied from the authored BANDS so
 * the derived bands read identically to siltpoke's hand-authored ones. */
const BAND_TINT: Record<C4Accent, { color: string; lc: string }> = {
  sky: { color: "rgba(127,176,200,.10)", lc: "#5f8499" },
  terra: { color: "rgba(217,107,107,.09)", lc: "#b15555" },
  moss: { color: "rgba(122,154,94,.11)", lc: "#5f7a48" },
  amber: { color: "rgba(232,168,92,.10)", lc: "#b07d2e" },
};

// ── layout constants (mirror authored proportions) ─────────────────────────────
const CANVAS_PAD = 28;
const BOUNDARY_PAD = 16; // inside boundary, around the band stack
const BAND_PAD = 14; // inside a band, around its boxes
const BAND_HEAD = 26; // band label strip
const BAND_GAP = 14; // between stacked bands
const BOX_W = 176;
const BOX_H = 92;
const BOX_GAP = 12;
const PER_ROW = 5; // containers per row before wrapping

/** A band + the node ids that live in it, pre-layout (no coords yet). */
export interface BandSeed {
  id: string;
  label: string;
  accent: C4Accent;
  note: string;
  memberIds: string[];
  /** Label is a dir→layer taxonomy guess (renders a "by name" marker). */
  heuristic?: boolean;
}

/**
 * Degraded-mode band grouping: bucket containers by their FIRST PATH SEGMENT,
 * preserving first-appearance order. The segment is read as an OPAQUE STRING
 * (`path.split("/")[0]`) and compared by equality — it is NEVER matched against
 * a known-roots list or mapped to a layer name. A repo with multiple top-level
 * namespaces (`backend/…`, `frontend/…`) yields one band each; a genuinely-flat
 * single-root repo (all `src/…`) yields ONE band with every container (the
 * deterministic output when all first segments are equal — no special-case).
 * The band LABEL is the segment verbatim (the real directory name = data),
 * supplied by the caller. Pure; zero framework/layer-name words.
 */
export function bandsByFirstSegment(
  subdirs: ReadonlyArray<{ id: string; path: string }>,
): Array<{ seg: string; memberIds: string[] }> {
  const bySeg = new Map<string, string[]>();
  const order: string[] = [];
  for (const sd of subdirs) {
    const seg = sd.path.split("/")[0] || sd.path;
    let members = bySeg.get(seg);
    if (members === undefined) {
      members = [];
      bySeg.set(seg, members);
      order.push(seg);
    }
    members.push(sd.id);
  }
  return order.map((seg) => ({ seg, memberIds: bySeg.get(seg)! }));
}

/**
 * Generate x/y/w/h for a stacked-horizontal-band C4 layout. Shared by the
 * honest subset (Layer 1) and the LLM-derived model (Layer 2). Bands stack
 * top→bottom; containers flow left→right within a band, wrapping at PER_ROW.
 * Returns positioned bands + boundary + scene bounds; mutates `nodes` coords.
 */
export function layoutC4Bands(
  seeds: BandSeed[],
  nodes: Record<string, C4Node>,
  boundaryLabel: string,
): { bands: C4Band[]; boundary: C4Boundary; bounds: { w: number; h: number } } {
  // Width = widest band (capped at PER_ROW columns), so all bands + boundary align.
  const maxCols = Math.max(
    1,
    ...seeds.map((s) => Math.min(s.memberIds.length, PER_ROW)),
  );
  const innerW = maxCols * (BOX_W + BOX_GAP) - BOX_GAP;
  const bandW = innerW + 2 * BAND_PAD;

  const boundaryX = CANVAS_PAD;
  const boundaryY = CANVAS_PAD;
  const bandX = boundaryX + BOUNDARY_PAD;
  let cursorY = boundaryY + BOUNDARY_PAD;

  const bands: C4Band[] = [];
  for (const seed of seeds) {
    const count = seed.memberIds.length;
    const rows = Math.max(1, Math.ceil(count / PER_ROW));
    const bandH = BAND_HEAD + rows * (BOX_H + BOX_GAP) - BOX_GAP + BAND_PAD;
    const tint = BAND_TINT[seed.accent];
    bands.push({
      x: bandX,
      y: cursorY,
      w: bandW,
      h: bandH,
      label: seed.label,
      color: tint.color,
      lc: tint.lc,
      note: seed.note,
      ...(seed.heuristic ? { heuristic: true } : {}),
    });

    seed.memberIds.forEach((id, i) => {
      const node = nodes[id];
      if (!node) return;
      const col = i % PER_ROW;
      const row = Math.floor(i / PER_ROW);
      node.x = bandX + BAND_PAD + col * (BOX_W + BOX_GAP);
      node.y = cursorY + BAND_HEAD + row * (BOX_H + BOX_GAP);
      node.w = BOX_W;
      node.h = BOX_H;
    });

    cursorY += bandH + BAND_GAP;
  }

  const boundaryH = cursorY - BAND_GAP + BOUNDARY_PAD - boundaryY;
  const boundary: C4Boundary = {
    x: boundaryX,
    y: boundaryY,
    w: bandW + 2 * BOUNDARY_PAD,
    h: boundaryH,
    label: boundaryLabel,
  };
  const bounds = {
    w: boundary.x + boundary.w + CANVAS_PAD,
    h: boundary.y + boundary.h + CANVAS_PAD,
  };
  return { bands, boundary, bounds };
}

/**
 * Derive the honest-subset C4 model from a structural projection. Pure +
 * deterministic; the scene bounds it implies are returned via `__bounds`
 * (the island reads it to frame the diagram, replacing the hardcoded 1500×1170).
 */
export function deriveC4FromProjection(
  proj: DerivableProjection,
): C4Model & { __bounds: { w: number; h: number } } {
  // Accent per group id, cycled so the palette holds for any group count.
  const accentByGroup = new Map<string, C4Accent>();
  proj.groups.forEach((g, i) => {
    accentByGroup.set(g.id, ACCENT_CYCLE[i % ACCENT_CYCLE.length]!);
  });

  // Containers: one cont node per subdir (no tech/comp/ext — honest subset).
  const N: Record<string, C4Node> = {};
  for (const sd of proj.subdirs) {
    const accent = accentByGroup.get(sd.group) ?? "sky";
    N[sd.id] = {
      kind: "cont",
      title: sd.id,
      accent,
      desc: sd.purpose || undefined,
      drillTo: sd.id,
      stats: {
        fileCount: sd.files,
        funcCount: sd.funcCount ?? 0,
        recurringBasenames: sd.recurringBasenames ?? [],
      },
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    };
  }

  // Bands. Degraded mode (no CLAUDE.md §Architecture) groups containers by their
  // FIRST PATH SEGMENT — one band per top-level namespace, labelled by
  // the literal segment (data, never a layer-name guess). A semantic-overlay repo
  // (groupingMode !== "fallback") keeps its author-given supergroups untouched.
  // The first-segment path requires every subdir to carry `path`; a path-less
  // projection (older fixtures) degrades safely to the supergroup grouping.
  const fallbackMode = proj.repo.groupingMode === "fallback";
  const useFirstSeg =
    fallbackMode &&
    proj.subdirs.length > 0 &&
    proj.subdirs.every((sd) => typeof sd.path === "string" && sd.path.length > 0);

  let seeds: BandSeed[];
  if (useFirstSeg) {
    const withPath = proj.subdirs.map((sd) => ({ id: sd.id, path: sd.path! }));
    seeds = bandsByFirstSegment(withPath).map(({ seg, memberIds }, i) => ({
      id: seg,
      label: seg, // verbatim first segment — the real directory name (data)
      accent: ACCENT_CYCLE[i % ACCENT_CYCLE.length]!,
      note: "",
      memberIds,
    }));
  } else {
    // semantic overlay (or path-less fallback): one band per supergroup.
    const membersByGroup = new Map<string, string[]>();
    for (const sd of proj.subdirs) {
      const arr = membersByGroup.get(sd.group) ?? [];
      arr.push(sd.id);
      membersByGroup.set(sd.group, arr);
    }
    seeds = proj.groups
      .filter((g) => (membersByGroup.get(g.id)?.length ?? 0) > 0)
      .map((g) => ({
        id: g.id,
        label: g.short.toUpperCase(),
        accent: accentByGroup.get(g.id) ?? "sky",
        note: g.title,
        memberIds: membersByGroup.get(g.id) ?? [],
      }));
  }

  const { bands, boundary, bounds } = layoutC4Bands(seeds, N, proj.repo.name);

  // Edges: import edges, neutral count label. Filter dangling endpoints so the
  // renderer's N[s]/N[t] lookups never miss (defensive — keeps the draw safe).
  const E: C4Edge[] = proj.edges
    .filter((e) => N[e.source] && N[e.target])
    .map((e) => [e.source, e.target, `imports ×${e.weight}`] as C4Edge);

  return {
    N,
    E,
    BANDS: bands,
    BOUNDARY: boundary,
    GROUP_ACCENT,
    __bounds: bounds,
  };
}

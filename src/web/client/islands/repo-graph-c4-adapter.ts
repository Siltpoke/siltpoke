// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * ArchModelDoc → C4Model adapter.
 *
 * The backend persists a coordinate-free, tier-annotated `ArchModelDoc`.
 * The renderer consumes a C4Model with `x/y/w/h`. This adapter (client-side, at
 * render) maps the semantic doc → a C4Model: cont nodes laid out by the shared
 * `layoutC4Bands` (same as the honest subset), ext/person placed outside the
 * boundary, edges carried verbatim. It also emits a `TierMap` so the renderer can
 * draw cited claims solid + inferred claims dashed (the anti-slop guardrail).
 *
 * `tier` is read from the doc (set by the grounding pass); a missing tier is
 * treated as `inferred` — never silently promoted to cited.
 */
import { layoutC4Bands, type BandSeed } from "./repo-graph-c4-derive";
import { GROUP_ACCENT, type C4Accent, type C4Edge, type C4Model, type C4Node } from "./repo-graph-c4-model";
import type { ArchModelDoc } from "../../../explain/arch-model-schema";

// `topology-blind`: an omnipresent-shaped domain-core band the import
// gradient can't adjudicate. Only BANDS carry it (nodes/edges never do). The
// backend emits it; the renderer doesn't yet give it a distinct treatment
// (neither solid-cited nor dashed-inferred) or a side-panel note — a renderer
// that only special-cases "cited" treats it like inferred (dashed), which is
// safe (it never reads as a confident `cited`).
export type Tier = "cited" | "inferred" | "topology-blind";

/** Per-claim tier lookups the renderer reads for solid-vs-dashed styling.
 * Bands are keyed by LABEL (the rendered C4Band carries no id); nodes by id;
 * edges by `source>target`. */
export interface TierMap {
  bands: Record<string, Tier>;
  edges: Record<string, Tier>;
  nodes: Record<string, Tier>;
  groundedPct: number;
}

const ACCENT_CYCLE: readonly C4Accent[] = ["sky", "terra", "moss", "amber"];
const EXT_W = 200;
const EXT_H = 92;
const EXT_GAP = 16;

export function edgeTierKey(source: string, target: string): string {
  return `${source}>${target}`;
}

/**
 * Adapt a generated ArchModelDoc to a C4Model (+ tier map). Pure + deterministic.
 */
export function archDocToC4Model(
  doc: ArchModelDoc,
  groundedPct: number,
): { model: C4Model & { __bounds: { w: number; h: number } }; tiers: TierMap } {
  const accentByBand = new Map<string, C4Accent>();
  doc.bands.forEach((b, i) => {
    accentByBand.set(b.id, ACCENT_CYCLE[i % ACCENT_CYCLE.length]!);
  });

  const bandOfNode = new Map<string, string>();
  for (const b of doc.bands) for (const m of b.members) bandOfNode.set(m, b.id);

  // cont nodes → N (coords filled by layout); ext/person placed after.
  const N: Record<string, C4Node> = {};
  for (const n of doc.nodes) {
    if (n.kind !== "cont") continue;
    const accent = accentByBand.get(bandOfNode.get(n.id) ?? "") ?? "sky";
    N[n.id] = {
      kind: "cont",
      title: n.title.value,
      desc: n.desc?.value || undefined,
      drillTo: n.drillTo,
      // The evidence body rides along — dropping it here was the root cause
      // of bucket-total badge twinning.
      memberFiles: n.members?.length ? [...n.members] : undefined,
      accent,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    };
  }

  // Drop a band with no CONTAINER members (e.g. an LLM "External" band whose only
  // members are ext nodes — those are laid out outside the bands, so the band
  // would render as an empty box). N holds only cont nodes at this point.
  const seeds: BandSeed[] = doc.bands
    .map((b) => ({
      id: b.id,
      label: b.label.value,
      accent: accentByBand.get(b.id) ?? "sky",
      note: "",
      memberIds: b.members.filter((m) => N[m]),
    }))
    .filter((s) => s.memberIds.length > 0);
  const { bands, boundary, bounds } = layoutC4Bands(seeds, N, doc.boundary);

  // person + ext: stacked in a column to the RIGHT of the boundary (outside it).
  const outside = doc.nodes.filter((n) => n.kind === "ext" || n.kind === "person");
  const extX = boundary.x + boundary.w + 40;
  outside.forEach((n, i) => {
    N[n.id] = {
      kind: n.kind,
      title: n.title.value,
      desc: n.desc?.value || undefined,
      x: extX,
      y: boundary.y + 20 + i * (EXT_H + EXT_GAP),
      w: EXT_W,
      h: EXT_H,
    };
  });

  const E: C4Edge[] = doc.edges
    .filter((e) => N[e.source] && N[e.target])
    .map((e) => [e.source, e.target, e.verb.value] as C4Edge);

  const tiers: TierMap = { bands: {}, edges: {}, nodes: {}, groundedPct };
  for (const b of doc.bands) tiers.bands[b.label.value] = b.label.tier ?? "inferred";
  for (const e of doc.edges) tiers.edges[edgeTierKey(e.source, e.target)] = e.verb.tier ?? "inferred";
  for (const n of doc.nodes) tiers.nodes[n.id] = n.title.tier ?? "inferred";

  const w = outside.length ? Math.max(bounds.w, extX + EXT_W + 28) : bounds.w;
  const h = Math.max(bounds.h, boundary.y + 20 + outside.length * (EXT_H + EXT_GAP) + 28);
  return {
    model: { N, E, BANDS: bands, BOUNDARY: boundary, GROUP_ACCENT, __bounds: { w, h } },
    tiers,
  };
}

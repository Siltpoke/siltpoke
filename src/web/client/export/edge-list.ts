// Every edge the export draws, numbered, with its evidence — the one list the
// image's key, the appendix table and the HTML file's panels all read, so the
// numbers cross-reference and "every edge is listed" is true by construction.
// The trust map records edges between groups; an edge the image draws without a
// trust record (e.g. between two outside systems) is listed too, as "no evidence",
// which is also why it is drawn dashed.
import type { TrustMap } from "../../../repo-graph/trust-map";
import type { C4Model } from "../islands/repo-graph-c4-model";

type TrustEdge = TrustMap["edges"][number];
export type ListedEdge = Omit<TrustEdge, "evidence"> & {
  evidence: TrustEdge["evidence"] | { kind: "none"; reason: "no-record" };
  /** The number drawn on the edge (1..N); absent for a trust edge the image does not draw. */
  n?: number;
};

const NO_RECORD = { kind: "none", reason: "no-record" } as const;

/**
 * The number of each `model.E` entry (null where an endpoint is missing, so it is not
 * drawn). Reading order: by the source box top to bottom, then left to right, then the
 * target the same way — so the numbers follow the layout's bands, not the file order.
 */
export function edgeNumbers(model: C4Model): Array<number | null> {
  const drawn = model.E.map((e, i) => ({ e, i })).filter(({ e }) => model.N[e[0]] && model.N[e[1]]);
  const key = ({ e, i }: { e: C4Model["E"][number]; i: number }): number[] => {
    const a = model.N[e[0]];
    const b = model.N[e[1]];
    return [a.y, a.x, b.y, b.x, i];
  };
  drawn.sort((p, q) => {
    const kp = key(p);
    const kq = key(q);
    for (let k = 0; k < kp.length; k++) if (kp[k] !== kq[k]) return kp[k] - kq[k];
    return 0;
  });
  const out: Array<number | null> = model.E.map(() => null);
  drawn.forEach(({ i }, rank) => {
    out[i] = rank + 1;
  });
  return out;
}

/** One row per drawn edge, in number order; then any trust edge the image does not draw.
 * `nums` lets a caller that already numbered the edges (build-svg) pass them in. */
export function listedEdges(model: C4Model, trust: TrustMap, nums: Array<number | null> = edgeNumbers(model)): ListedEdge[] {
  const byKey = new Map(trust.edges.map((e) => [`${e.source}>${e.target}`, e]));
  const rows: ListedEdge[] = [];
  const pairs = new Set<string>();
  for (const [i, [s, t, verb]] of model.E.entries()) {
    const n = nums[i];
    if (n === null) continue; // not drawn
    const rec = byKey.get(`${s}>${t}`);
    pairs.add(`${s}>${t}`);
    // The row names the verb the image draws; a trust record (keyed by the pair) lends it its evidence.
    rows.push({ n, source: s, target: t, verb, solid: rec?.solid ?? false, evidence: rec?.evidence ?? NO_RECORD });
  }
  rows.sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  for (const e of trust.edges) if (!pairs.has(`${e.source}>${e.target}`)) rows.push(e);
  return rows;
}

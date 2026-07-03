// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Arch View LLM-derive layer-label grounding predicate.
 *
 * The load-bearing piece: the LLM PROPOSES a vertical band order; code FALSIFIES
 * it against the real dependency gradient. A band whose proposed position
 * contradicts the gradient (beyond tolerance) has its layer LABEL demoted to
 * "inferred" — but its position is NOT changed (re-sorting would be code
 * authoring its own layering, a different fabrication) and the containers inside
 * keep their own fact-tier grounding. This file only decides each band label's
 * tier; the caller applies it.
 *
 * Gradient = net(inbound − outbound) per subdir on the SCC-CONDENSED graph
 * (cycles collapsed first, so a back-edge can't define a phantom layer). A
 * source-like subdir (depends on many) has net < 0 → belongs high (top); a
 * sink (depended-on by many) has net > 0 → belongs low (bottom).
 */
import type { Tier } from "./arch-model-schema";

export interface BandLike {
  id: string;
  /** Vertical order top→bottom as the LLM proposed it (0 = top). */
  order: number;
  /** Container ids (subdir ids / `comp:<subdir>/<name>` / composite cohesive like
   * `agent-state`). NEVER parsed as strings — each is mapped to its keyspace subdir
   * id(s) via the `resolveSubdir` closure (over the container's member file paths). */
  members: string[];
}
export interface SubdirEdge {
  source: string;
  target: string;
  weight: number;
}

// Omnipresent-SHAPE qualifier (NOT a core-vs-sink separator — measurement
// showed pure topology can't separate those). A subdir is omnipresent-
// shaped iff it is heavily depended-upon and depends on almost nothing:
//   I = out/(in+out) ≤ THETA_I  AND  in-degree ≥ THETA_IN
// over RAW (not SCC-condensed) subdir edge weights.
// θ is only a shape floor; the gradient-vs-LLM CONFLICT does the real
// discrimination (a real infra sink is omnipresent-shaped too, but the LLM agrees
// it belongs at the bottom → no conflict → never flagged). Values from a measured
// distribution: a hub-shaped `lib` (I=0.015, in=132) qualifies; a `db` (I=0.083) and
// slack's low-I sinks (in≤11) do not. θ_in is an absolute floor → repo-size
// sensitive (secondary defense; conflict-guard is primary).
const THETA_I = 0.05;
const THETA_IN = 20;

/** Subdir ids that are omnipresent-SHAPED, from raw in/out degree over edges. */
function omnipresentSubdirs(edges: SubdirEdge[]): Set<string> {
  const inW = new Map<string, number>();
  const outW = new Map<string, number>();
  for (const e of edges) {
    outW.set(e.source, (outW.get(e.source) ?? 0) + e.weight);
    inW.set(e.target, (inW.get(e.target) ?? 0) + e.weight);
  }
  const omni = new Set<string>();
  for (const id of new Set([...inW.keys(), ...outW.keys()])) {
    const inb = inW.get(id) ?? 0;
    const outb = outW.get(id) ?? 0;
    if (inb + outb === 0) continue;
    const I = outb / (inb + outb);
    if (I <= THETA_I && inb >= THETA_IN) omni.add(id);
  }
  return omni;
}

/** Tarjan SCC → component index per node id. Recursive — fine at the real scale
 * (dozens of subdirs); a 500+-subdir repo could in theory overflow the stack. */
function tarjanScc(nodes: string[], adj: Map<string, string[]>): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const comp = new Map<string, number>();
  let counter = 0;
  let compId = 0;

  const strongconnect = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.set(w, compId);
      } while (w !== v);
      compId++;
    }
  };

  for (const n of nodes) if (!index.has(n)) strongconnect(n);
  return comp;
}

/** Net (inbound − outbound) per subdir over CROSS-SCC edges only. */
function netBySubdir(nodes: string[], edges: SubdirEdge[]): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    if (adj.has(e.source)) adj.get(e.source)!.push(e.target);
  }
  const scc = tarjanScc(nodes, adj);
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const e of edges) {
    const sc = scc.get(e.source);
    const tc = scc.get(e.target);
    if (sc === undefined || tc === undefined || sc === tc) continue; // intra-SCC: no layer signal
    outbound.set(e.source, (outbound.get(e.source) ?? 0) + e.weight);
    inbound.set(e.target, (inbound.get(e.target) ?? 0) + e.weight);
  }
  const net = new Map<string, number>();
  for (const n of nodes) net.set(n, (inbound.get(n) ?? 0) - (outbound.get(n) ?? 0));
  return net;
}

/** Local inversion in the expected-rank sequence (indexed by proposed order). */
function isLocalInversion(i: number, seq: number[]): boolean {
  const n = seq.length;
  if (n < 2) return false;
  if (i === 0) return seq[0]! > seq[1]!; // top band should hold the smallest expRank
  if (i === n - 1) return seq[n - 1]! < seq[n - 2]!; // bottom should hold the largest
  const a = seq[i - 1]!;
  const b = seq[i]!;
  const c = seq[i + 1]!;
  return (b > a && b > c) || (b < a && b < c); // strict local peak / valley
}

/**
 * Decide each band's layer-label tier. Returns bandId → "cited" | "inferred".
 * Demotion = "inferred" only; the caller never re-sorts.
 */
export function groundBands(
  bands: BandLike[],
  edges: SubdirEdge[],
  resolveSubdir: (containerId: string) => string[],
): Map<string, Tier> {
  const out = new Map<string, Tier>();
  if (bands.length <= 1) {
    for (const b of bands) out.set(b.id, "cited"); // no ordering claim to falsify
    return out;
  }

  // Every band member (a container id) is mapped to the keyspace subdir id(s) it
  // spans via `resolveSubdir` (over the container's member file paths — never the
  // id string). This is the ONE fold: comp: splits, composite cohesive ids
  // (`agent-state`), and file-as-bucket members all resolve the same way, so none
  // orphans against the edge keyspace. An empty resolution (members-less / ext) is
  // an honest zero contribution, not a silent orphan.
  const nodes = [...new Set(bands.flatMap((b) => b.members.flatMap(resolveSubdir)))];
  const net = netBySubdir(nodes, edges);
  // A band is omnipresent-shaped iff it resolves to ≥1 subdir AND EVERY
  // resolved subdir is omnipresent-shaped (ALL-members rule — conservative, high
  // precision: a band with even one genuinely-layered member stays gradient-graded,
  // so a real infra sink can't drag a mixed band into abstention). The net-degree
  // gradient is still computed on the FULL node set (NOT excluding these) — the
  // conflict can only be seen on the full graph, where an omnipresent core lands at
  // the bottom and contradicts the LLM's high placement. (No exclusion here —
  // naive exclusion would zero its net → false `cited`.)
  const omni = omnipresentSubdirs(edges);
  const omnipresentBand = (b: BandLike): boolean => {
    const subs = [...new Set(b.members.flatMap(resolveSubdir))];
    return subs.length > 0 && subs.every((sd) => omni.has(sd));
  };
  const bandNet = new Map<string, number>();
  for (const b of bands) {
    // Sum over DISTINCT subdirs in the band — a band holding several containers of
    // one subdir counts that subdir's net ONCE (else folding multiplies it by the
    // container count, distorting the band's gradient position).
    const subdirs = new Set(b.members.flatMap(resolveSubdir));
    bandNet.set(b.id, [...subdirs].reduce((s, sd) => s + (net.get(sd) ?? 0), 0));
  }

  // No gradient (e.g. one giant SCC, or no cross-subdir edges) → the ordering is
  // uncorroborated; a strong proposed order over an essentially-unordered graph
  // is the LLM's read, not a fact → every band label is inferred (honest).
  const hasGradient = new Set(bandNet.values()).size >= 2;
  if (!hasGradient) {
    for (const b of bands) out.set(b.id, "inferred");
    return out;
  }

  const expectedOrder = [...bands].sort((a, b) => bandNet.get(a.id)! - bandNet.get(b.id)!);
  const proposedOrder = [...bands].sort((a, b) => a.order - b.order);
  const expRank = new Map(expectedOrder.map((b, i) => [b.id, i]));
  const propRank = new Map(proposedOrder.map((b, i) => [b.id, i]));
  // TOL grows with band count (floor(n*0.25), min 1). Note: with exactly 2 bands
  // tol=1 and a full swap gives delta=1, which is NOT > tol — so a 2-band order
  // is ALWAYS cited (a 2-band layering is too minimal a claim to falsify).
  const tol = Math.max(1, Math.floor(bands.length * 0.25));
  const expSeq = proposedOrder.map((b) => expRank.get(b.id)!);

  proposedOrder.forEach((b, i) => {
    const delta = Math.abs(expRank.get(b.id)! - propRank.get(b.id)!);
    // The EXISTING conflict predicate (reused, not forked): LLM rank contradicts
    // the net-degree gradient beyond tolerance + is a local inversion.
    const demote = delta > tol && isLocalInversion(i, expSeq);
    // A conflict on an omnipresent-shaped band is NOT "the LLM
    // got the layer wrong" (topology can't adjudicate it) → `topology-blind`, an
    // honest abstention, instead of `inferred`. A conflict on a normal band stays
    // `inferred` (gradient trustworthy there). No conflict → `cited` as before
    // (a real infra sink the LLM also places low never enters here → no-regress).
    out.set(b.id, demote ? (omnipresentBand(b) ? "topology-blind" : "inferred") : "cited");
  });
  return out;
}

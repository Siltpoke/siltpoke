// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Repo-level coverage gate.
 *
 * A read-only, index-time trust signal for the function-level trace. A naive raw
 * metric (resolved / ALL call sites) read ~30% RED on siltpoke — but that's the
 * ~70% external/stdlib floor (un-linkable by ANY static resolver, tsserver
 * included), NOT a quality problem. So the gate is measured against the
 * IN-REPO-ELIGIBLE denominator instead:
 *
 *   eligible   = call sites whose target name is DEFINED somewhere in the repo
 *                (a resolver could link it). External / stdlib names and dynamic
 *                dispatch are excluded — they're not failures, just unlinkable.
 *   confident  = eligible calls pinned to EXACTLY one definition (klass
 *                "resolved"). Ambiguous calls (klass "inferred", >1 candidate)
 *                are eligible but NOT confident — the precision penalty.
 *   pct        = confident / eligible.
 *
 * So pct folds recall (did we link the resolvable call) and precision (did we
 * pin it unambiguously). A repo that links every in-repo call unambiguously is
 * green even when most call VOLUME is external. Counting is call-site weighted
 * (edge.weight = call-site count).
 *
 * Gate:
 *   green  ≥ 60   → draw the function-level path normally
 *   yellow ≥ 40   → draw only confirmed edges
 *   red    < 40   → suppress the function path, fall back to file-level
 *
 * Calibration verdict (C2, AC-11, 2026-06-03 — keep thresholds, don't change):
 * RED is rare BY DESIGN on healthy TS repos, not by luck. red (<40%) means
 * >60% of in-repo calls are name-AMBIGUOUS (the same name defined in multiple
 * places). That ambiguity is the NAME resolver's ceiling — method-name
 * collisions (render/run/handle/get across many classes) with no type info to
 * disambiguate — i.e. an "ambiguity floor" that is exactly the same CLASS of
 * resolver limit as the external floor the M1 denominator already excludes one
 * level up. Both are resolver limits, NOT repo-health signals. The gate guards
 * TRACE-UX trustworthiness (would the drawn spine mislead?), not repo quality:
 * a repo whose calls are mostly ambiguous WOULD draw a misleading path, so the
 * file-level fallback is the honest move when red fires. red is therefore
 * correctly reserved for a genuinely pathological, un-disambiguatable codebase.
 *
 * Measured across several live repos: coverage ranged 52-77% (green to
 * yellow, none red). The lowest 52% trace was
 * still a LEGIBLE real spine (AC-12 ✅) — so the 60/40 cutoffs did NOT wrongly
 * suppress a working trace, and nothing landed red → no healthy repo was wrongly
 * file-fallback'd. That is direct validation of the thresholds, not a guess.
 *
 * Re-measure trigger (NOT before): if a tsserver precision pass ever lands (the
 * deferred type-aware resolver seam), the ambiguity floor shrinks — many
 * currently-"inferred" calls become "resolved" — so pct rises across the board
 * and the 60/40 tiers would want a fresh re-measure on the same 4 repos. Until
 * that lands, the name-based ceiling makes these cutoffs correct.
 */
import { makeNameBasedResolver, type CallResolver } from "./call-resolver";
import type { Coverage, CoverageTier, QueryIndex, RepoGraph } from "./types";

export type { Coverage, CoverageTier } from "./types";

function tierOf(pct: number): CoverageTier {
  if (pct >= 60) return "green";
  if (pct >= 40) return "yellow";
  return "red";
}

export function computeCoverage(
  graph: RepoGraph,
  queryIndex: QueryIndex,
  resolver: CallResolver = makeNameBasedResolver(graph, queryIndex),
): Coverage {
  let eligible = 0;
  let confident = 0;
  for (const edge of graph.edges) {
    if (edge.type !== "calls") continue;
    // Eligible only if the callee name is defined in the repo — external /
    // stdlib / dynamic targets are unlinkable by any resolver, so excluding them
    // keeps the gate measuring OUR resolution, not the external floor.
    const definedInRepo = (queryIndex.name_to_node_ids[edge.target]?.length ?? 0) > 0;
    if (!definedInRepo) continue;
    const weight = edge.weight > 0 ? edge.weight : 1;
    eligible += weight;
    const { klass } = resolver.resolve({
      calleeName: edge.target,
      callKind: edge.call_kind ?? "dynamic",
    });
    if (klass === "resolved") confident += weight; // exactly one target = confident
  }
  const pct = eligible === 0 ? 0 : Math.round((confident / eligible) * 100);
  return { resolvedCallsites: confident, totalCallsites: eligible, pct, tier: tierOf(pct) };
}

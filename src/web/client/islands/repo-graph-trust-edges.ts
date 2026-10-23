// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * On-screen Generated-view edge trust (AC32) — the client half of the trust
 * map (`src/repo-graph/trust-map.ts`, type-only import here: this module has
 * no I/O of its own besides the one fetch below). Pure state + pure decision
 * functions, so `edgeDashed`/`trustNote` are testable without touching a DOM.
 *
 * `TrustState` starts `"loading"` so first paint is never blocked on the
 * fetch: `edgeDashed` falls back to the legacy per-edge AI tier ("inferred" =
 * dashed) while loading or if the fetch failed, and only switches to the
 * trust map's own `solid` bit once it lands (`"ready"`). This mirrors the
 * `no-map` 404 the daemon route (`repo-graph-trust.ts`) can return — that,
 * a non-2xx, a malformed body, and a thrown fetch all collapse to the SAME
 * `"failed"` state; the caller never needs to tell them apart.
 */
import type { TrustMap } from "../../../repo-graph/trust-map";
import { edgeTierKey, type TierMap } from "./repo-graph-c4-adapter";

export type TrustState = { status: "loading" } | { status: "ready"; map: TrustMap } | { status: "failed" };

/**
 * Generated view only (callers gate on `archSource === "generated"` before
 * calling this — Authored/Subset keep the legacy tier rule unconditionally).
 *
 * `ready` → the edge's own `solid` bit; an edge missing from the map (the
 * model changed between fetch and render, or the trust route and the C4
 * adapter disagree on an id) reads as dashed, never solid — an absence is
 * never read as evidence. `loading`/`failed` → the legacy `legacyInferred`
 * rule the caller already computed from `archTiers`, so the swap-on-arrival
 * is the ONLY behavior change; nothing regresses before the fetch resolves.
 */
function edgeDashed(state: TrustState, s: string, t: string, legacyInferred: boolean): boolean {
  if (state.status !== "ready") return legacyInferred;
  const found = state.map.edges.find((e) => e.source === s && e.target === t);
  return found ? !found.solid : true;
}

/** Whether a C4 edge draws dashed: Generated follows the trust map (`edgeDashed`),
 * Authored/Subset keep the legacy per-edge tier rule. */
export function c4EdgeDashed(source: string, tiers: TierMap | null, state: TrustState, s: string, t: string): boolean {
  const inferred = tiers?.edges[edgeTierKey(s, t)] === "inferred";
  return source === "generated" ? edgeDashed(state, s, t, inferred) : inferred;
}

/** One-line notice for the arch status/notice line — non-null only when the
 * trust fetch failed, so the dashed-edge rule silently falling back to the
 * legacy tier isn't mistaken for "the trust map said so" (spec §6). */
export function trustNote(state: TrustState): string | null {
  return state.status === "failed"
    ? "Edge check unavailable — dashed here means the citation was not corroborated"
    : null;
}

/** Fetch the active Generated view's trust map. Never throws — a non-ok
 * response, a `success:false` body, or a network/parse failure all read as
 * `{status:"failed"}`, which `edgeDashed`/`trustNote` treat identically to
 * "never fetched". `fetchImpl` defaults to the global `fetch`; tests inject a
 * stub that returns a FRESH `Response` per call (a shared one is consumable
 * once and reads empty on the second call). */
async function fetchTrust(url: string, fetchImpl?: typeof fetch): Promise<TrustState> {
  const f = fetchImpl ?? fetch;
  try {
    const res = await f(url);
    if (!res.ok) return { status: "failed" };
    const body = (await res.json()) as { success: boolean; data?: TrustMap; error: string | null };
    if (!body.success || !body.data) return { status: "failed" };
    return { status: "ready", map: body.data };
  } catch {
    return { status: "failed" };
  }
}

/** Restyle already-drawn Generated-view edges in place — no DOM teardown, so
 * a stale caller-held node reference / an in-flight selection survives the
 * fetch landing mid-interaction (a full render() there regressed
 * tests/web/client/islands/repo-graph-member-door.test.ts). */
export function restyleGeneratedEdges(
  edges: ReadonlyArray<{ s: string; t: string; path: SVGPathElement; lab: HTMLElement }>,
  legacyInferred: (s: string, t: string) => boolean,
  state: TrustState,
): void {
  for (const e of edges) {
    const dashed = edgeDashed(state, e.s, e.t, legacyInferred(e.s, e.t));
    if (dashed) e.path.setAttribute("stroke-dasharray", "4 3");
    else e.path.removeAttribute("stroke-dasharray");
    e.lab.classList.toggle("inferred", dashed); // label italic follows the dash (AC32)
  }
}

let latestLoad = 0;
/** `fetchTrust`, but resolves `null` when a NEWER load started while this one
 * was in flight — a slower, older response resolving last must not clobber a
 * newer state (generate→toggle, Generated→Authored→Generated, regenerate). */
export async function loadLatestTrust(url: string, fetchImpl?: typeof fetch): Promise<TrustState | null> {
  const mine = ++latestLoad;
  const state = await fetchTrust(url, fetchImpl);
  return mine === latestLoad ? state : null;
}

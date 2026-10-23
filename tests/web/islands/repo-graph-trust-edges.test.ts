/**
 * Unit — repo-graph-trust-edges (AC32): the three pure functions that make the
 * on-screen Generated view's edge dashes follow the trust map, plus the fetch
 * that produces the state they read.
 *
 * Every state × solid/dashed/missing-edge combination is covered directly —
 * `c4EdgeDashed` (Generated branch) is the one function a mutation on the "ready" branch, the
 * legacy-fallback branch, or the missing-edge default would silently wrong-foot.
 *
 * `fetchTrust`: each case builds its OWN Response via a payload factory — a
 * shared module-level Response is consumable once and reads empty on the
 * second test (memory: shared-response-in-fetch-mock-reads-empty).
 */
import { describe, expect, test } from "bun:test";
import { c4EdgeDashed, loadLatestTrust as fetchTrust, trustNote, type TrustState } from "../../../src/web/client/islands/repo-graph-trust-edges";
import type { TierMap } from "../../../src/web/client/islands/repo-graph-c4-adapter";
import type { TrustMap } from "../../../src/repo-graph/trust-map";

type TrustEdge = TrustMap["edges"][number];

function edge(over: Partial<TrustEdge> = {}): TrustEdge {
  return {
    source: "a",
    target: "b",
    verb: "uses",
    solid: true,
    evidence: { kind: "import", count: 1 },
    ...over,
  };
}

function trustMap(edges: TrustEdge[]): TrustMap {
  return {
    schema: 1,
    source: "generated",
    stamp: { mapDate: "2026-09-26T00:00:00Z", commit: "abc1234", commitsAhead: 0, headRelation: "same" },
    containers: [],
    edges,
    totals: null,
    notShown: [],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Legacy per-edge tier for the a→b edge: "inferred" ⇔ legacyInferred. */
function tiers(legacyInferred: boolean): TierMap {
  return { bands: {}, nodes: {}, groundedPct: 0, edges: { "a>b": legacyInferred ? "inferred" : "cited" } };
}

/** The Generated view's dash decision for the a→b edge. */
function edgeDashed(state: TrustState, _s: "a", _t: "b", legacyInferred: boolean): boolean {
  return c4EdgeDashed("generated", tiers(legacyInferred), state, "a", "b");
}

describe("edgeDashed", () => {
  test("loading → legacy tier rule, ignores any map", () => {
    const state: TrustState = { status: "loading" };
    expect(edgeDashed(state, "a", "b", true)).toBe(true);
    expect(edgeDashed(state, "a", "b", false)).toBe(false);
  });

  test("failed → legacy tier rule, same as loading", () => {
    const state: TrustState = { status: "failed" };
    expect(edgeDashed(state, "a", "b", true)).toBe(true);
    expect(edgeDashed(state, "a", "b", false)).toBe(false);
  });

  test("ready + solid edge → not dashed, regardless of the legacy tier", () => {
    const state: TrustState = { status: "ready", map: trustMap([edge({ solid: true })]) };
    expect(edgeDashed(state, "a", "b", true)).toBe(false);
    expect(edgeDashed(state, "a", "b", false)).toBe(false);
  });

  test("ready + dashed (solid:false) edge → dashed, regardless of the legacy tier", () => {
    const state: TrustState = {
      status: "ready",
      map: trustMap([edge({ solid: false, evidence: { kind: "none", reason: "no-import-no-citation" } })]),
    };
    expect(edgeDashed(state, "a", "b", true)).toBe(true);
    expect(edgeDashed(state, "a", "b", false)).toBe(true);
  });

  test("ready + edge missing from the map → dashed (never over-trust an absence)", () => {
    const state: TrustState = { status: "ready", map: trustMap([]) };
    expect(edgeDashed(state, "a", "b", false)).toBe(true);
  });
});

describe("c4EdgeDashed — Authored/Subset keep the legacy tier", () => {
  test("a trust-solid edge still dashes on authored when its tier is inferred", () => {
    const state: TrustState = { status: "ready", map: trustMap([edge({ solid: true })]) };
    expect(c4EdgeDashed("authored", tiers(true), state, "a", "b")).toBe(true);
    expect(c4EdgeDashed("subset", tiers(false), state, "a", "b")).toBe(false);
  });

  test("no tier map → not dashed outside Generated", () => {
    expect(c4EdgeDashed("authored", null, { status: "loading" }, "a", "b")).toBe(false);
  });
});

describe("trustNote", () => {
  test("failed → the one-line notice", () => {
    expect(trustNote({ status: "failed" })).toBe(
      "Edge check unavailable — dashed here means the citation was not corroborated",
    );
  });

  test("loading → null (nothing to say yet)", () => {
    expect(trustNote({ status: "loading" })).toBeNull();
  });

  test("ready → null (nothing to say once it succeeded)", () => {
    expect(trustNote({ status: "ready", map: trustMap([]) })).toBeNull();
  });
});

describe("fetchTrust", () => {
  test("200 + success payload → ready with the map", async () => {
    const map = trustMap([edge()]);
    const stub = (async () => jsonResponse({ success: true, data: map, error: null })) as unknown as typeof fetch;
    const state = await fetchTrust("/api/repo-graph/arch/trust?source=generated", stub);
    expect(state).toEqual({ status: "ready", map });
  });

  test("500 → failed", async () => {
    const stub = (async () => jsonResponse({ success: false, error: "no_map" }, 500)) as unknown as typeof fetch;
    const state = await fetchTrust("/api/repo-graph/arch/trust?source=generated", stub);
    expect(state).toEqual({ status: "failed" });
  });

  test("404 (no_map) → failed", async () => {
    const stub = (async () => jsonResponse({ success: false, error: "no_map" }, 404)) as unknown as typeof fetch;
    const state = await fetchTrust("/api/repo-graph/arch/trust?source=generated", stub);
    expect(state).toEqual({ status: "failed" });
  });

  test("200 but success:false body → failed (never trust a malformed 200)", async () => {
    const stub = (async () => jsonResponse({ success: false, data: null, error: "bad" })) as unknown as typeof fetch;
    const state = await fetchTrust("/api/repo-graph/arch/trust?source=generated", stub);
    expect(state).toEqual({ status: "failed" });
  });

  test("fetch throws → failed, no unhandled rejection", async () => {
    const stub = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const state = await fetchTrust("/api/repo-graph/arch/trust?source=generated", stub);
    expect(state).toEqual({ status: "failed" });
  });

  test("malformed (non-JSON) body → failed", async () => {
    const stub = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const state = await fetchTrust("/api/repo-graph/arch/trust?source=generated", stub);
    expect(state).toEqual({ status: "failed" });
  });
});

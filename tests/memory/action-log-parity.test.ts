/**
 * action-log-parity — mechanical coupling test between the server and client
 * synthesis functions.
 *
 * The server (src/memory/fact-events.ts: synthesizeLegacy + deriveSummary) and
 * the client (src/web/client/islands/memory-book-helpers.ts:
 * synthesizeClientEvents + deriveClientSummary) are intentional duplicates — the
 * server module can't be bundled into the Alpine client bundle cleanly. This test
 * runs a shared set of fixtures through BOTH sides and asserts the resulting
 * event-action sequences and derived summary fields match, so any future
 * divergence (e.g. when supersede handling is added) is caught before it
 * reaches production.
 *
 * Field-name mapping (server Fact → client MemoryEventClient):
 *   fact.created_at        → m.ts
 *   fact.status            → m.status
 *   fact.last_confirmed_at → m.last_confirmed_at
 *   fact.events            → m.events
 *
 * Note: deriveSummary uses fact.created_at for createdAt, while
 * deriveClientSummary uses m.ts — both fields hold the same value in these
 * fixtures, so the createdAt assertion also validates the mapping.
 */
import { describe, expect, it } from "bun:test";
import { deriveSummary, synthesizeLegacy } from "../../src/memory/fact-events";
import type { Fact } from "../../src/memory/memory";
import {
  deriveClientSummary,
  synthesizeClientEvents,
  type MemoryEventClient,
} from "../../src/web/client/islands/memory-book-helpers";

// ─── shared fixture builder helpers ─────────────────────────────────────────

/** Minimal Fact shape — only the fields consumed by synthesizeLegacy / deriveSummary. */
function makeFact(overrides: Partial<Fact> & Pick<Fact, "id" | "status" | "created_at">): Fact {
  return {
    text: "fixture fact",
    source_session_id: null,
    confidence: 0.9,
    last_seen_at: overrides.created_at,
    supersedes: null,
    superseded_by: null,
    pinned: false,
    recall_count: 0,
    retired_reason: null,
    stability: "durable",
    learned_from: null,
    last_confirmed_at: null,
    expires_at: null,
    save_reason: null,
    invalid_at: null,
    events: [],
    ...overrides,
  };
}

/** Client-side equivalent of makeFact — fields mapped per the comment above. */
function makeClient(
  overrides: Partial<MemoryEventClient> & Pick<MemoryEventClient, "id" | "status" | "ts">,
): MemoryEventClient {
  return {
    type: "semantic",
    text: "fixture fact",
    why: null,
    last_confirmed_at: null,
    recall_count: 0,
    events: [],
    ...overrides,
  };
}

// ─── fixtures ────────────────────────────────────────────────────────────────

const CREATED = "2026-01-01T00:00:00Z";
const APPROVED = "2026-01-02T10:00:00Z";
const REAFFIRM_1 = "2026-01-05T00:00:00Z";
const REAFFIRM_2 = "2026-01-10T00:00:00Z";
const RETIRED_AT = "2026-01-15T10:00:00Z";

// Fixture A — empty events, active status.
const FACT_A = makeFact({ id: "a", status: "active", created_at: CREATED, last_confirmed_at: APPROVED });
const CLIENT_A = makeClient({ id: "a", status: "active", ts: CREATED, last_confirmed_at: APPROVED });

// Fixture B — empty events, pending status.
const FACT_B = makeFact({ id: "b", status: "pending", created_at: CREATED });
const CLIENT_B = makeClient({ id: "b", status: "pending", ts: CREATED });

// Fixture C — empty events, retired status.
const FACT_C = makeFact({ id: "c", status: "retired", created_at: CREATED });
const CLIENT_C = makeClient({ id: "c", status: "retired", ts: CREATED });

// Fixture D — stored events: created + approved + 2× reaffirmed + retired.
const STORED_EVENTS_D = [
  { action: "created"    as const, at: CREATED,     reason: null },
  { action: "approved"   as const, at: APPROVED,    reason: null },
  { action: "reaffirmed" as const, at: REAFFIRM_1,  reason: null },
  { action: "reaffirmed" as const, at: REAFFIRM_2,  reason: null },
  { action: "retired"    as const, at: RETIRED_AT,  reason: "user_rejected" },
];
const FACT_D = makeFact({ id: "d", status: "retired", created_at: CREATED, events: STORED_EVENTS_D });
const CLIENT_D = makeClient({ id: "d", status: "retired", ts: CREATED, events: STORED_EVENTS_D });

// Fixture E — non-empty events (created+approved) + retired status, NO retired event.
// Both sides should synthesize a trailing retired event.
const STORED_EVENTS_E = [
  { action: "created"  as const, at: CREATED,  reason: null },
  { action: "approved" as const, at: APPROVED, reason: null },
];
const FACT_E = makeFact({
  id: "e",
  status: "retired",
  created_at: CREATED,
  last_seen_at: APPROVED,
  events: STORED_EVENTS_E,
});
const CLIENT_E = makeClient({ id: "e", status: "retired", ts: CREATED, events: STORED_EVENTS_E });

// Fixture F — empty events, active status, recall_count=5.
// Both sides give reaffirmCount=5 via Math.max(0, 5).
const FACT_F = makeFact({
  id: "f",
  status: "active",
  created_at: CREATED,
  last_confirmed_at: APPROVED,
  recall_count: 5,
});
const CLIENT_F = makeClient({ id: "f", status: "active", ts: CREATED, last_confirmed_at: APPROVED, recall_count: 5 });

// ─── parity assertions ───────────────────────────────────────────────────────

describe("action-log server/client parity", () => {
  describe("synthesizeLegacy vs synthesizeClientEvents — event-action sequences", () => {
    it("Fixture A (empty events, active) → both produce [created, approved]", () => {
      const serverEvs = synthesizeLegacy(FACT_A);
      const clientEvs = synthesizeClientEvents(CLIENT_A);
      expect(serverEvs.map((e) => e.action)).toEqual(clientEvs.map((e) => e.action));
      expect(serverEvs.map((e) => e.action)).toEqual(["created", "approved"]);
    });

    it("Fixture A — created.at and approved.at timestamps match", () => {
      const serverEvs = synthesizeLegacy(FACT_A);
      const clientEvs = synthesizeClientEvents(CLIENT_A);
      expect(serverEvs[0].at).toBe(clientEvs[0].at);
      expect(serverEvs[1].at).toBe(clientEvs[1].at);
    });

    it("Fixture B (empty events, pending) → both produce [created] only", () => {
      const serverEvs = synthesizeLegacy(FACT_B);
      const clientEvs = synthesizeClientEvents(CLIENT_B);
      expect(serverEvs.map((e) => e.action)).toEqual(clientEvs.map((e) => e.action));
      expect(serverEvs.map((e) => e.action)).toEqual(["created"]);
    });

    it("Fixture C (empty events, retired) → both produce [created, retired] (synthetic)", () => {
      const serverEvs = synthesizeLegacy(FACT_C);
      const clientEvs = synthesizeClientEvents(CLIENT_C);
      expect(serverEvs.map((e) => e.action)).toEqual(clientEvs.map((e) => e.action));
      // Retired status + no logged retired event → trailing synthetic retired appended
      expect(serverEvs.map((e) => e.action)).toEqual(["created", "retired"]);
    });

    it("Fixture D (stored events, non-empty) → both return stored events as-is", () => {
      const serverEvs = synthesizeLegacy(FACT_D);
      const clientEvs = synthesizeClientEvents(CLIENT_D);
      expect(serverEvs.map((e) => e.action)).toEqual(clientEvs.map((e) => e.action));
      expect(serverEvs.map((e) => e.action)).toEqual([
        "created", "approved", "reaffirmed", "reaffirmed", "retired",
      ]);
    });
  });

  describe("deriveSummary vs deriveClientSummary — summary field parity", () => {
    it("Fixture A (active, legacy) → reaffirmCount 0, no retired, latestStateChange=approved", () => {
      const serverS = deriveSummary(FACT_A);
      const clientEvs = synthesizeClientEvents(CLIENT_A);
      const clientS = deriveClientSummary(CLIENT_A, clientEvs);

      expect(serverS.reaffirmCount).toBe(clientS.reaffirmCount);
      expect(serverS.reaffirmCount).toBe(0);

      expect(serverS.lastReaffirmAt).toBe(clientS.lastReaffirmAt);
      expect(serverS.lastReaffirmAt).toBeNull();

      expect(serverS.retiredAt).toBe(clientS.retiredAt);
      expect(serverS.retiredAt).toBeNull();

      expect(serverS.latestStateChange?.action).toBe(clientS.latestStateChange?.action);
      expect(serverS.latestStateChange?.action).toBe("approved");

      // createdAt field maps fact.created_at → m.ts — should hold same value.
      expect(serverS.createdAt).toBe(clientS.createdAt);
    });

    it("Fixture B (pending, legacy) → reaffirmCount 0, latestStateChange null", () => {
      const serverS = deriveSummary(FACT_B);
      const clientEvs = synthesizeClientEvents(CLIENT_B);
      const clientS = deriveClientSummary(CLIENT_B, clientEvs);

      expect(serverS.reaffirmCount).toBe(clientS.reaffirmCount);
      expect(serverS.reaffirmCount).toBe(0);
      expect(serverS.latestStateChange).toBe(clientS.latestStateChange);
      expect(serverS.latestStateChange).toBeNull();
      expect(serverS.retiredAt).toBe(clientS.retiredAt);
      expect(serverS.retiredAt).toBeNull();
    });

    it("Fixture C (retired, legacy) → reaffirmCount 0, latestStateChange=retired, retiredAt=CREATED", () => {
      const serverS = deriveSummary(FACT_C);
      const clientEvs = synthesizeClientEvents(CLIENT_C);
      const clientS = deriveClientSummary(CLIENT_C, clientEvs);

      expect(serverS.reaffirmCount).toBe(clientS.reaffirmCount);
      expect(serverS.reaffirmCount).toBe(0);
      // Synthetic retired event appended → retiredAt = the fallback timestamp.
      // FACT_C: invalid_at=null, last_seen_at=CREATED → retiredAt=CREATED.
      // CLIENT_C: falls back to m.ts=CREATED.
      expect(serverS.retiredAt).toBe(CREATED);
      expect(clientS.retiredAt).toBe(CREATED);
      // latestStateChange = the synthetic retired event.
      expect(serverS.latestStateChange?.action).toBe("retired");
      expect(clientS.latestStateChange?.action).toBe("retired");
    });

    it("Fixture E (non-empty events, retired, no retired event) → both synthesize trailing retired", () => {
      const serverEvs = synthesizeLegacy(FACT_E);
      const clientEvs = synthesizeClientEvents(CLIENT_E);
      // Both must append a synthetic retired event since neither stored events have one.
      expect(serverEvs.map((e) => e.action)).toEqual(clientEvs.map((e) => e.action));
      expect(serverEvs.map((e) => e.action)).toEqual(["created", "approved", "retired"]);
      // Summary: retiredAt should be non-null for both.
      const serverS = deriveSummary(FACT_E);
      const clientS = deriveClientSummary(CLIENT_E, clientEvs);
      expect(serverS.retiredAt).not.toBeNull();
      expect(clientS.retiredAt).not.toBeNull();
      expect(serverS.latestStateChange?.action).toBe("retired");
      expect(clientS.latestStateChange?.action).toBe("retired");
    });

    it("Fixture F (empty events, active, recall_count=5) → both give reaffirmCount=5", () => {
      const serverEvs = synthesizeLegacy(FACT_F);
      const clientEvs = synthesizeClientEvents(CLIENT_F);
      // Active + empty → [created, approved]; no reaffirm events.
      expect(serverEvs.map((e) => e.action)).toEqual(clientEvs.map((e) => e.action));
      expect(serverEvs.map((e) => e.action)).toEqual(["created", "approved"]);
      // Math.max(0, recall_count=5) = 5 for both sides.
      const serverS = deriveSummary(FACT_F);
      const clientS = deriveClientSummary(CLIENT_F, clientEvs);
      expect(serverS.reaffirmCount).toBe(clientS.reaffirmCount);
      expect(serverS.reaffirmCount).toBe(5);
    });

    it("Fixture D (stored: created+approved+2×reaffirmed+retired) → reaffirmCount 2, retiredAt, latestStateChange=retired", () => {
      const serverS = deriveSummary(FACT_D);
      const clientEvs = synthesizeClientEvents(CLIENT_D);
      const clientS = deriveClientSummary(CLIENT_D, clientEvs);

      expect(serverS.reaffirmCount).toBe(clientS.reaffirmCount);
      expect(serverS.reaffirmCount).toBe(2);

      expect(serverS.lastReaffirmAt).toBe(clientS.lastReaffirmAt);
      expect(serverS.lastReaffirmAt).toBe(REAFFIRM_2);

      expect(serverS.retiredAt).toBe(clientS.retiredAt);
      expect(serverS.retiredAt).toBe(RETIRED_AT);

      expect(serverS.latestStateChange?.action).toBe(clientS.latestStateChange?.action);
      expect(serverS.latestStateChange?.action).toBe("retired");

      expect(serverS.latestStateChange?.at).toBe(clientS.latestStateChange?.at);
      expect(serverS.latestStateChange?.at).toBe(RETIRED_AT);
    });
  });
});

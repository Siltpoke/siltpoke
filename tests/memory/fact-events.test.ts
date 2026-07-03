import { describe, expect, it } from "bun:test";
import { deriveSummary, synthesizeLegacy } from "../../src/memory/fact-events";
import type { Fact } from "../../src/memory/memory";

describe("synthesizeLegacy", () => {
  it("empty events + active status → created + approved", () => {
    const fact: Fact = {
      id: "f-1",
      text: "user prefers tabs",
      source_session_id: null,
      confidence: 0.9,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-01T00:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 0,
      retired_reason: null,
      stability: "durable",
      learned_from: null,
      last_confirmed_at: "2026-01-02T10:00:00Z",
      expires_at: null,
      save_reason: null,
      invalid_at: null,
      events: [],
    };

    const evs = synthesizeLegacy(fact);
    expect(evs.map((e) => e.action)).toEqual(["created", "approved"]);
    expect(evs[0].at).toBe("2026-01-01T00:00:00Z");
    expect(evs[1].at).toBe("2026-01-02T10:00:00Z");
  });

  it("empty events + active status, no last_confirmed_at → uses created_at for approved", () => {
    const fact: Fact = {
      id: "f-1",
      text: "test",
      source_session_id: null,
      confidence: 0.5,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-01T00:00:00Z",
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
    };

    const evs = synthesizeLegacy(fact);
    expect(evs.map((e) => e.action)).toEqual(["created", "approved"]);
    expect(evs[0].at).toBe("2026-01-01T00:00:00Z");
    expect(evs[1].at).toBe("2026-01-01T00:00:00Z"); // falls back to created_at
  });

  it("empty events + retired status → [created, retired] (M1 synthetic retired appended)", () => {
    const fact: Fact = {
      id: "f-1",
      text: "test",
      source_session_id: null,
      confidence: 0.5,
      status: "retired",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-05T00:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 0,
      retired_reason: "user_rejected",
      stability: "durable",
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
      save_reason: null,
      invalid_at: null,
      events: [],
    };

    const evs = synthesizeLegacy(fact);
    // M1: retired status + empty events → [created] + synthetic [retired]
    expect(evs.map((e) => e.action)).toEqual(["created", "retired"]);
    expect(evs).toHaveLength(2);
    // at uses invalid_at ?? last_seen_at ?? created_at → last_seen_at
    expect(evs[1].at).toBe("2026-01-05T00:00:00Z");
    expect(evs[1].reason).toBe("user_rejected");
  });

  it("M1: non-empty events + retired status, no retired event → trailing retired appended", () => {
    const fact: Fact = {
      id: "f-2",
      text: "test",
      source_session_id: null,
      confidence: 0.5,
      status: "retired",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-10T00:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 0,
      retired_reason: "user_rejected",
      stability: "durable",
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
      save_reason: null,
      invalid_at: null,
      events: [
        { action: "created", at: "2026-01-01T00:00:00Z", reason: null },
        { action: "approved", at: "2026-01-02T00:00:00Z", reason: null },
      ],
    };

    const evs = synthesizeLegacy(fact);
    expect(evs.map((e) => e.action)).toEqual(["created", "approved", "retired"]);
    expect(evs[2].action).toBe("retired");
    // at uses last_seen_at (invalid_at is null)
    expect(evs[2].at).toBe("2026-01-10T00:00:00Z");
    expect(evs[2].reason).toBe("user_rejected");
  });

  it("M1 does NOT apply when retired event is already present in events", () => {
    const fact: Fact = {
      id: "f-3",
      text: "test",
      source_session_id: null,
      confidence: 0.5,
      status: "retired",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-15T00:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 0,
      retired_reason: "user_rejected",
      stability: "durable",
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
      save_reason: null,
      invalid_at: null,
      events: [
        { action: "created", at: "2026-01-01T00:00:00Z", reason: null },
        { action: "retired", at: "2026-01-15T00:00:00Z", reason: "user_rejected" },
      ],
    };

    const evs = synthesizeLegacy(fact);
    // Already has retired event → no extra synthetic event appended
    expect(evs.map((e) => e.action)).toEqual(["created", "retired"]);
    expect(evs).toHaveLength(2);
    expect(evs).toBe(fact.events); // same array reference (passthrough)
  });

  it("non-empty events → passthrough (no synthesis)", () => {
    const fact: Fact = {
      id: "f-1",
      text: "test",
      source_session_id: null,
      confidence: 0.5,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-01T00:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 2,
      retired_reason: null,
      stability: "durable",
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
      save_reason: null,
      invalid_at: null,
      events: [
        { action: "created", at: "2026-01-01T00:00:00Z", reason: null },
        { action: "reaffirmed", at: "2026-01-05T00:00:00Z", reason: null },
        { action: "reaffirmed", at: "2026-01-10T00:00:00Z", reason: null },
      ],
    };

    const evs = synthesizeLegacy(fact);
    expect(evs).toBe(fact.events); // exact same array, not a copy
  });
});

describe("deriveSummary", () => {
  it("counts reaffirmed events and captures latest reaffirm date", () => {
    const fact: Fact = {
      id: "f-1",
      text: "test",
      source_session_id: null,
      confidence: 0.5,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-10T00:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 2,
      retired_reason: null,
      stability: "durable",
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
      save_reason: null,
      invalid_at: null,
      events: [
        { action: "created", at: "2026-01-01T00:00:00Z", reason: null },
        { action: "approved", at: "2026-01-02T00:00:00Z", reason: null },
        { action: "reaffirmed", at: "2026-01-05T00:00:00Z", reason: null },
        { action: "reaffirmed", at: "2026-01-10T00:00:00Z", reason: null },
      ],
    };

    const s = deriveSummary(fact);
    expect(s.reaffirmCount).toBe(2);
    expect(s.lastReaffirmAt).toBe("2026-01-10T00:00:00Z");
    expect(s.createdAt).toBe("2026-01-01T00:00:00Z");
  });

  it("returns null for lastReaffirmAt when no reaffirms present", () => {
    const fact: Fact = {
      id: "f-1",
      text: "test",
      source_session_id: null,
      confidence: 0.5,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-01T00:00:00Z",
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
      events: [
        { action: "created", at: "2026-01-01T00:00:00Z", reason: null },
      ],
    };

    const s = deriveSummary(fact);
    expect(s.reaffirmCount).toBe(0);
    expect(s.lastReaffirmAt).toBeNull();
  });

  it("captures retiredAt from the last retired event", () => {
    const fact: Fact = {
      id: "f-1",
      text: "test",
      source_session_id: null,
      confidence: 0.5,
      status: "retired",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-10T00:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 2,
      retired_reason: "user_rejected",
      stability: "durable",
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
      save_reason: null,
      invalid_at: null,
      events: [
        { action: "created", at: "2026-01-01T00:00:00Z", reason: null },
        { action: "reaffirmed", at: "2026-01-05T00:00:00Z", reason: null },
        { action: "retired", at: "2026-01-15T10:00:00Z", reason: "user_rejected" },
      ],
    };

    const s = deriveSummary(fact);
    expect(s.retiredAt).toBe("2026-01-15T10:00:00Z");
  });

  it("returns null for retiredAt when no retired event present", () => {
    const fact: Fact = {
      id: "f-1",
      text: "test",
      source_session_id: null,
      confidence: 0.5,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-10T00:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 1,
      retired_reason: null,
      stability: "durable",
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
      save_reason: null,
      invalid_at: null,
      events: [
        { action: "created", at: "2026-01-01T00:00:00Z", reason: null },
        { action: "reaffirmed", at: "2026-01-05T00:00:00Z", reason: null },
      ],
    };

    const s = deriveSummary(fact);
    expect(s.retiredAt).toBeNull();
  });

  it("latestStateChange picks the most-recent non-created / non-reaffirmed event", () => {
    const fact: Fact = {
      id: "f-1",
      text: "test",
      source_session_id: null,
      confidence: 0.5,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-20T00:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 2,
      retired_reason: null,
      stability: "durable",
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
      save_reason: null,
      invalid_at: null,
      events: [
        { action: "created", at: "2026-01-01T00:00:00Z", reason: null },
        { action: "approved", at: "2026-01-02T00:00:00Z", reason: null },
        { action: "reaffirmed", at: "2026-01-10T00:00:00Z", reason: null },
        { action: "retired", at: "2026-01-15T10:00:00Z", reason: "user_rejected" },
        { action: "reactivated", at: "2026-01-20T00:00:00Z", reason: null },
      ],
    };

    const s = deriveSummary(fact);
    expect(s.latestStateChange).not.toBeNull();
    expect(s.latestStateChange?.action).toBe("reactivated");
    expect(s.latestStateChange?.at).toBe("2026-01-20T00:00:00Z");
  });

  it("latestStateChange is null when only created and reaffirmed events exist", () => {
    const fact: Fact = {
      id: "f-1",
      text: "test",
      source_session_id: null,
      confidence: 0.5,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-05T00:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 1,
      retired_reason: null,
      stability: "durable",
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
      save_reason: null,
      invalid_at: null,
      events: [
        { action: "created", at: "2026-01-01T00:00:00Z", reason: null },
        { action: "reaffirmed", at: "2026-01-05T00:00:00Z", reason: null },
      ],
    };

    const s = deriveSummary(fact);
    expect(s.latestStateChange).toBeNull();
  });

  it("M2: empty events + recall_count=5 (legacy active) → reaffirmCount=5", () => {
    const fact: Fact = {
      id: "f-1",
      text: "legacy fact",
      source_session_id: null,
      confidence: 0.5,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-01T00:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 5,
      retired_reason: null,
      stability: "durable",
      learned_from: null,
      last_confirmed_at: "2026-01-02T00:00:00Z",
      expires_at: null,
      save_reason: null,
      invalid_at: null,
      events: [],
    };

    const s = deriveSummary(fact);
    // No reaffirm events, but recall_count=5 → Math.max(0, 5) = 5
    expect(s.reaffirmCount).toBe(5);
  });

  it("M2: 3 reaffirm events + recall_count=5 → reaffirmCount=5 (max wins)", () => {
    const fact: Fact = {
      id: "f-1",
      text: "test",
      source_session_id: null,
      confidence: 0.5,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-12T00:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 5,
      retired_reason: null,
      stability: "durable",
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
      save_reason: null,
      invalid_at: null,
      events: [
        { action: "created", at: "2026-01-01T00:00:00Z", reason: null },
        { action: "reaffirmed", at: "2026-01-05T00:00:00Z", reason: null },
        { action: "reaffirmed", at: "2026-01-08T00:00:00Z", reason: null },
        { action: "reaffirmed", at: "2026-01-12T00:00:00Z", reason: null },
      ],
    };

    const s = deriveSummary(fact);
    // 3 reaffirm events, recall_count=5 → Math.max(3, 5) = 5
    expect(s.reaffirmCount).toBe(5);
  });

  it("uses synthesizeLegacy for legacy facts with empty events", () => {
    const fact: Fact = {
      id: "f-1",
      text: "legacy fact",
      source_session_id: null,
      confidence: 0.5,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-01T00:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 0,
      retired_reason: null,
      stability: "durable",
      learned_from: null,
      last_confirmed_at: "2026-01-02T00:00:00Z",
      expires_at: null,
      save_reason: null,
      invalid_at: null,
      events: [],
    };

    const s = deriveSummary(fact);
    // synthesizeLegacy should create [created, approved], so reaffirmCount = 0
    expect(s.reaffirmCount).toBe(0);
    expect(s.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(s.retiredAt).toBeNull();
  });
});

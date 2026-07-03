import { describe, expect, it } from "bun:test";
import type { Fact } from "../../src/memory/memory";
import type { Episode } from "../../src/memory/episode";
import type { EventFragment } from "../../src/memory/event-fragment";
import { buildMemoryLog } from "../../src/memory/memory-log";

// Minimal EventFragment fixture — all required fields so tsc stays green.
const baseFragment = (over: Partial<EventFragment>): EventFragment => ({
  id: "ev-0001",
  text: "shipped the memory-book slot",
  created_at: "2026-06-15T00:00:00.000Z",
  occurred_at: "2026-06-14T00:00:00.000Z",
  expires_at: "2026-07-15T00:00:00.000Z",
  sources: [{ kind: "commit", ref: "abc1234def" }],
  entities: [],
  confidence: 0.7,
  learned_from_stream: "commit",
  ...over,
});

// Minimal Episode fixture — all required fields so tsc stays green.
const baseEpisode = (over: Partial<Episode>): Episode => ({
  id: "ep-0001",
  day_key: "2026-07-01",
  member_fragment_ids: ["ev-1", "ev-2"],
  time_span: { start: "2026-07-01T09:00:00.000Z", end: "2026-07-01T18:00:00.000Z" },
  narrative: "Shipped episodic-fragment capture and started synthesis.",
  entity_labels: [],
  version: 1,
  created_at: "2026-07-01T19:00:00.000Z",
  updated_at: "2026-07-01T19:00:00.000Z",
  expires_at: "2027-07-01T19:00:00.000Z",
  ...over,
});

// Minimal Fact fixture — includes all required Fact fields so tsc stays green.
// Tests only override the fields they care about.
const baseFact = (over: Partial<Fact>): Fact => ({
  id: "f", text: "t", source_session_id: null, confidence: 0.8, status: "active",
  created_at: "2026-06-10T00:00:00.000Z", last_seen_at: "2026-06-10T00:00:00.000Z",
  supersedes: null, save_reason: null,
  superseded_by: null, pinned: false, recall_count: 0, retired_reason: null,
  stability: "durable", learned_from: null, last_confirmed_at: null, expires_at: null,
  invalid_at: null,
  events: [],
  ...over,
});

describe("buildMemoryLog", () => {
  it("maps facts to semantic events with save_reason as why", () => {
    const log = buildMemoryLog({
      facts: [baseFact({ id: "f1", text: "uses Bun", save_reason: "recurs", status: "active" })],
      critiques: [], learnedRules: [],
    });
    expect(log[0]).toMatchObject({ type: "semantic", text: "uses Bun", why: "recurs", status: "active" });
  });

  it("excludes rubric-noise critiques from episodic events", () => {
    const log = buildMemoryLog({
      facts: [],
      critiques: [{ id: "c1", ts: "2026-06-11T00:00:00.000Z", body: "Rubric flagged concerns the model didn't surface: x" }],
      learnedRules: [],
    });
    expect(log.filter((e) => e.type === "episodic")).toHaveLength(0);
  });

  it("sorts all events newest-first by ts", () => {
    const log = buildMemoryLog({
      facts: [baseFact({ id: "old", created_at: "2026-06-01T00:00:00.000Z" }),
              baseFact({ id: "new", created_at: "2026-06-20T00:00:00.000Z" })],
      critiques: [], learnedRules: [],
    });
    expect(log.map((e) => e.id)).toEqual(["new", "old"]);
  });

  it("maps retire_proposed and retired facts to status 'retired' bucket", () => {
    const log = buildMemoryLog({ facts: [baseFact({ id: "r", status: "retired" })], critiques: [], learnedRules: [] });
    expect(log[0]!.status).toBe("retired");
  });

  it("carries fact recall_count onto the semantic event (and zeroes non-fact events)", () => {
    const log = buildMemoryLog({
      facts: [baseFact({ id: "f1", recall_count: 4 })],
      critiques: [{ id: "c1", ts: "2026-06-11T00:00:00.000Z", body: "real critique" }],
      learnedRules: [{ id: "lr1", created_at: "2026-06-12T00:00:00.000Z", text: "a rule" }],
    });
    expect(log.find((e) => e.id === "f1")!.recall_count).toBe(4);
    expect(log.find((e) => e.id === "c1")!.recall_count).toBe(0);
    expect(log.find((e) => e.id === "lr1")!.recall_count).toBe(0);
  });

  it("carries fact last_confirmed_at onto the semantic event (null for non-fact events)", () => {
    const log = buildMemoryLog({
      facts: [baseFact({ id: "f1", last_confirmed_at: "2026-06-22T09:00:00.000Z" })],
      critiques: [{ id: "c1", ts: "2026-06-11T00:00:00.000Z", body: "real critique" }],
      learnedRules: [{ id: "lr1", created_at: "2026-06-12T00:00:00.000Z", text: "a rule" }],
    });
    expect(log.find((e) => e.id === "f1")!.last_confirmed_at).toBe("2026-06-22T09:00:00.000Z");
    expect(log.find((e) => e.id === "c1")!.last_confirmed_at).toBeNull();
    expect(log.find((e) => e.id === "lr1")!.last_confirmed_at).toBeNull();
  });

  it("maps fact.learned_from.stream to event.stream ('commit' and 'user' get distinct values; null fact gets null)", () => {
    const log = buildMemoryLog({
      facts: [
        baseFact({ id: "c1", learned_from: { stream: "commit", session_id: null } }),
        baseFact({ id: "u1", learned_from: { stream: "user", session_id: null } }),
        baseFact({ id: "seed", learned_from: null }),
      ],
      critiques: [{ id: "ep1", ts: "2026-06-11T00:00:00.000Z", body: "real critique" }],
      learnedRules: [{ id: "lr1", created_at: "2026-06-12T00:00:00.000Z", text: "a rule" }],
    });
    expect(log.find((e) => e.id === "c1")!.stream).toBe("commit");
    expect(log.find((e) => e.id === "u1")!.stream).toBe("user");
    expect(log.find((e) => e.id === "seed")!.stream).toBeNull();
    // non-fact events always get null
    expect(log.find((e) => e.id === "ep1")!.stream).toBeNull();
    expect(log.find((e) => e.id === "lr1")!.stream).toBeNull();
  });

  // Task 6 — load-bearing wiring: Fact.entities must survive the buildMemoryLog
  // projection so the /memory island's byEntityGroups() has something to group.
  it("maps fact.entities onto event.entities (null for untagged facts and non-fact events)", () => {
    const log = buildMemoryLog({
      facts: [
        baseFact({ id: "tagged", entities: [{ name: "Daniel" }] }),
        baseFact({ id: "untagged" }),
      ],
      critiques: [{ id: "ep1", ts: "2026-06-11T00:00:00.000Z", body: "real critique" }],
      learnedRules: [],
    });
    expect(log.find((e) => e.id === "tagged")?.entities).toEqual([{ name: "Daniel" }]);
    expect(log.find((e) => e.id === "untagged")?.entities).toBeNull();
    // Non-fact (episodic/procedural) events don't carry entities at all —
    // mirrors the existing `kind` field convention (undefined, not null).
    expect(log.find((e) => e.id === "ep1")?.entities).toBeUndefined();
  });

  // Event fragments surface in the episodic slot ALONGSIDE critiques.
  it("maps an event fragment to a type:'episodic' row with ts === occurred_at (not created_at)", () => {
    const log = buildMemoryLog({
      facts: [],
      critiques: [],
      learnedRules: [],
      eventFragments: [
        baseFragment({
          id: "ev-a1",
          text: "added strict tsconfig",
          occurred_at: "2026-06-14T00:00:00.000Z",
          created_at: "2026-06-20T00:00:00.000Z",
          learned_from_stream: "commit",
          entities: [{ name: "tsconfig" }],
        }),
      ],
    });
    const row = log.find((e) => e.id === "ev-a1");
    expect(row).toBeDefined();
    expect(row!.type).toBe("episodic");
    expect(row!.text).toBe("added strict tsconfig");
    // Temporal provenance: the event's real occurrence time, NOT the record time.
    expect(row!.ts).toBe("2026-06-14T00:00:00.000Z");
    expect(row!.status).toBe("active");
    expect(row!.stream).toBe("commit");
    expect(row!.entities).toEqual([{ name: "tsconfig" }]);
    expect(row!.why).toContain("commit");
  });

  it("interleaves event fragments with critiques + facts newest-first by ts (occurred_at as sort key)", () => {
    const log = buildMemoryLog({
      facts: [baseFact({ id: "f-old", created_at: "2026-06-01T00:00:00.000Z" })],
      critiques: [{ id: "c-mid", ts: "2026-06-10T00:00:00.000Z", body: "real critique" }],
      learnedRules: [],
      eventFragments: [
        baseFragment({ id: "ev-new", occurred_at: "2026-06-20T00:00:00.000Z" }),
      ],
    });
    expect(log.map((e) => e.id)).toEqual(["ev-new", "c-mid", "f-old"]);
  });

  it("event fragments coexist with critiques under episodic (both appear)", () => {
    const log = buildMemoryLog({
      facts: [],
      critiques: [{ id: "c1", ts: "2026-06-11T00:00:00.000Z", body: "real critique" }],
      learnedRules: [],
      eventFragments: [baseFragment({ id: "ev1", occurred_at: "2026-06-12T00:00:00.000Z" })],
    });
    const episodic = log.filter((e) => e.type === "episodic").map((e) => e.id);
    expect(episodic).toContain("c1");
    expect(episodic).toContain("ev1");
  });

  it("omitted eventFragments → only critique episodic rows (back-compat)", () => {
    const log = buildMemoryLog({
      facts: [],
      critiques: [{ id: "c1", ts: "2026-06-11T00:00:00.000Z", body: "real critique" }],
      learnedRules: [],
    });
    expect(log.filter((e) => e.type === "episodic").map((e) => e.id)).toEqual(["c1"]);
  });

  // Episodes surface as episodic rows, distinct from event-fragment rows.
  it("maps an episode to a type:'episodic' row with narrative as body + a distinct episodeWhy label", () => {
    const log = buildMemoryLog({
      facts: [],
      critiques: [],
      learnedRules: [],
      episodes: [
        baseEpisode({
          id: "ep-a1",
          day_key: "2026-07-01",
          member_fragment_ids: ["ev-1", "ev-2", "ev-3"],
          narrative: "Shipped episodic-fragment capture end to end.",
          entity_labels: ["episode-synthesis"],
        }),
      ],
    });
    const row = log.find((e) => e.id === "ep-a1");
    expect(row).toBeDefined();
    expect(row!.type).toBe("episodic");
    expect(row!.text).toBe("Shipped episodic-fragment capture end to end.");
    expect(row!.why).toBe("episode · 3 events on 2026-07-01");
    expect(row!.why).toContain("episode");
    expect(row!.entities).toEqual([{ name: "episode-synthesis" }]);
  });

  it("episode row's why is distinct from an event-fragment row's why", () => {
    const log = buildMemoryLog({
      facts: [],
      critiques: [],
      learnedRules: [],
      eventFragments: [baseFragment({ id: "ev-solo", occurred_at: "2026-06-30T00:00:00.000Z" })],
      episodes: [baseEpisode({ id: "ep-a1" })],
    });
    const eventWhy = log.find((e) => e.id === "ev-solo")!.why;
    const episodeWhy = log.find((e) => e.id === "ep-a1")!.why;
    expect(eventWhy).not.toEqual(episodeWhy);
    expect(episodeWhy).toContain("episode");
    expect(eventWhy).not.toContain("episode");
  });

  it("episode ts = time_span.end; a mixed set (episode + event fragment + critique) sorts newest-first", () => {
    const log = buildMemoryLog({
      facts: [],
      critiques: [{ id: "c-mid", ts: "2026-06-15T00:00:00.000Z", body: "real critique" }],
      learnedRules: [],
      eventFragments: [baseFragment({ id: "ev-old", occurred_at: "2026-06-01T00:00:00.000Z" })],
      episodes: [
        baseEpisode({
          id: "ep-newest",
          time_span: { start: "2026-07-01T09:00:00.000Z", end: "2026-07-01T23:00:00.000Z" },
        }),
      ],
    });
    const episodeRow = log.find((e) => e.id === "ep-newest");
    expect(episodeRow!.ts).toBe("2026-07-01T23:00:00.000Z");
    expect(log.map((e) => e.id)).toEqual(["ep-newest", "c-mid", "ev-old"]);
  });

  it("0 episodes → no episode rows, event fragments + critiques still render (coexistence)", () => {
    const log = buildMemoryLog({
      facts: [],
      critiques: [{ id: "c1", ts: "2026-06-11T00:00:00.000Z", body: "real critique" }],
      learnedRules: [],
      eventFragments: [baseFragment({ id: "ev1", occurred_at: "2026-06-12T00:00:00.000Z" })],
      episodes: [],
    });
    const episodic = log.filter((e) => e.type === "episodic").map((e) => e.id);
    expect(episodic.sort()).toEqual(["c1", "ev1"].sort());
    expect(episodic.some((id) => id.startsWith("ep-"))).toBe(false);
  });

  it("omitted episodes → back-compat, no crash, only event-fragment/critique episodic rows", () => {
    const log = buildMemoryLog({
      facts: [],
      critiques: [{ id: "c1", ts: "2026-06-11T00:00:00.000Z", body: "real critique" }],
      learnedRules: [],
      eventFragments: [baseFragment({ id: "ev1", occurred_at: "2026-06-12T00:00:00.000Z" })],
    });
    const episodic = log.filter((e) => e.type === "episodic").map((e) => e.id);
    expect(episodic).toContain("c1");
    expect(episodic).toContain("ev1");
    expect(episodic).not.toContain("ep-");
  });
});

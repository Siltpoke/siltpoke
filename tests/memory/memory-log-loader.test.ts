import { test, expect } from "bun:test";
import { loadMemoryEvents } from "../../src/memory/memory-log-loader";

test("procedural event Why prefers rule.source over category", async () => {
  const events = await loadMemoryEvents("/unused", {
    readMemory: async () => ({
      // minimal CoreMemory with one learned rule carrying source
      learned_rules: [{ id: "lr-1", rule: "R", category: "cat-x", created_at: new Date().toISOString(), applied_count: 0, effectiveness: "good", source: "from dismissing critique c-9: real reason" }],
      facts: [],
    } as any),
    loadCritiques: async () => [],
  });
  const proc = events.find((e) => e.type === "procedural");
  expect(proc?.why).toBe("from dismissing critique c-9: real reason");
});

test("surfaces non-expired event fragments as episodic rows (ts = occurred_at); excludes expired", async () => {
  const now = new Date("2026-06-20T00:00:00.000Z");
  const events = await loadMemoryEvents("/unused", {
    now,
    readMemory: async () => ({
      facts: [],
      learned_rules: [],
      event_fragments: [
        {
          id: "ev-active",
          text: "shipped the episodic slot",
          created_at: "2026-06-15T00:00:00.000Z",
          occurred_at: "2026-06-14T00:00:00.000Z",
          expires_at: "2026-07-15T00:00:00.000Z", // future → active
          sources: [{ kind: "commit", ref: "abc1234def" }],
          entities: [],
          confidence: 0.7,
          learned_from_stream: "commit",
        },
        {
          id: "ev-expired",
          text: "an old event",
          created_at: "2026-05-01T00:00:00.000Z",
          occurred_at: "2026-04-30T00:00:00.000Z",
          expires_at: "2026-05-31T00:00:00.000Z", // past → filtered out
          sources: [{ kind: "commit", ref: "def5678abc" }],
          entities: [],
          confidence: 0.7,
          learned_from_stream: "commit",
        },
      ],
    } as any),
    loadCritiques: async () => [],
  });

  const active = events.find((e) => e.id === "ev-active");
  expect(active).toBeDefined();
  expect(active?.type).toBe("episodic");
  expect(active?.ts).toBe("2026-06-14T00:00:00.000Z"); // occurred_at, not created_at
  expect(events.find((e) => e.id === "ev-expired")).toBeUndefined();
});

// Synthesized episodes surface as episodic rows via loadMemoryEvents.
test("surfaces non-expired episodes as episodic rows (ts = time_span.end); excludes expired", async () => {
  const now = new Date("2026-07-01T12:00:00.000Z");
  const events = await loadMemoryEvents("/unused", {
    now,
    readMemory: async () => ({
      facts: [],
      learned_rules: [],
      episodes: [
        {
          id: "ep-active",
          day_key: "2026-07-01",
          member_fragment_ids: ["ev-1", "ev-2"],
          time_span: { start: "2026-07-01T09:00:00.000Z", end: "2026-07-01T10:00:00.000Z" },
          narrative: "Shipped episode synthesis surfacing.",
          entity_labels: [],
          version: 1,
          created_at: "2026-07-01T11:00:00.000Z",
          updated_at: "2026-07-01T11:00:00.000Z",
          expires_at: "2027-07-01T11:00:00.000Z", // future → active
        },
        {
          id: "ep-expired",
          day_key: "2026-05-01",
          member_fragment_ids: ["ev-3", "ev-4"],
          time_span: { start: "2026-05-01T09:00:00.000Z", end: "2026-05-01T10:00:00.000Z" },
          narrative: "An old episode.",
          entity_labels: [],
          version: 1,
          created_at: "2026-05-01T11:00:00.000Z",
          updated_at: "2026-05-01T11:00:00.000Z",
          expires_at: "2026-06-01T00:00:00.000Z", // past → filtered out
        },
      ],
    } as any),
    loadCritiques: async () => [],
  });

  const active = events.find((e) => e.id === "ep-active");
  expect(active).toBeDefined();
  expect(active?.type).toBe("episodic");
  expect(active?.ts).toBe("2026-07-01T10:00:00.000Z"); // time_span.end
  expect(active?.why).toContain("episode");
  expect(events.find((e) => e.id === "ep-expired")).toBeUndefined();
});

test("legacy memory doc with no episodes field → no crash, no episode rows", async () => {
  const events = await loadMemoryEvents("/unused", {
    readMemory: async () => ({
      // legacy doc: no `episodes` key at all
      facts: [],
      learned_rules: [],
    } as any),
    loadCritiques: async () => [],
  });
  expect(events.some((e) => e.id.startsWith("ep-"))).toBe(false);
});

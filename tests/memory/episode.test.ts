// dayKey uses HOST-LOCAL time (a local-first pet groups by the user's real
// day). Pin TZ=UTC here so these fixed-date assertions are deterministic on
// any machine; production uses the user's own timezone.
process.env.TZ = "UTC";
import { test, expect, describe } from "bun:test";
import {
  episodeSchema,
  clusterByDay,
  applyEpisodes,
  activeEpisodes,
  resolveMembers,
  dayKey,
  EPISODE_MIN_MEMBERS,
  EPISODE_TTL_DAYS,
  type Episode,
  type EpisodeDraft,
} from "../../src/memory/episode";
import type { EventFragment } from "../../src/memory/event-fragment";
import { emptyMemory, type CoreMemory } from "../../src/memory/memory";

const MS_PER_DAY = 86_400_000;

function fragment(
  id: string,
  entityName: string,
  occurred_at: string,
): EventFragment {
  return {
    id,
    text: `did something with ${entityName}`,
    created_at: "2026-07-01T12:00:00Z",
    occurred_at,
    expires_at: "2026-07-31T00:00:00Z",
    sources: [{ kind: "commit", ref: `sha-${id}` }],
    entities: [{ name: entityName }],
    confidence: 0.7,
    learned_from_stream: "commit",
  };
}

function draft(over: Partial<EpisodeDraft> = {}): EpisodeDraft {
  return {
    day_key: "2026-07-01",
    member_fragment_ids: ["ev-1", "ev-2"],
    time_span: { start: "2026-07-01T09:00:00Z", end: "2026-07-01T18:00:00Z" },
    narrative: "you shipped two things today",
    entity_labels: ["repo-graph"],
    ...over,
  };
}

function episode(over: Partial<Episode> = {}): Episode {
  return {
    id: "ep-1",
    day_key: "2026-07-01",
    member_fragment_ids: ["ev-1", "ev-2"],
    time_span: { start: "2026-07-01T09:00:00Z", end: "2026-07-01T18:00:00Z" },
    narrative: "you shipped two things today",
    entity_labels: [],
    version: 1,
    created_at: "2026-07-01T18:00:00Z",
    updated_at: "2026-07-01T18:00:00Z",
    expires_at: "2027-07-01T18:00:00Z",
    ...over,
  };
}

describe("dayKey", () => {
  test("buckets a UTC timestamp to its calendar date", () => {
    expect(dayKey("2026-07-01T10:00:00Z")).toBe("2026-07-01");
  });

  test("is stable/consistent across different times on the same UTC day", () => {
    expect(dayKey("2026-07-01T00:00:01Z")).toBe(dayKey("2026-07-01T23:59:59Z"));
  });

  test("distinguishes adjacent days across a UTC midnight boundary", () => {
    expect(dayKey("2026-06-30T23:59:59Z")).toBe("2026-06-30");
    expect(dayKey("2026-07-01T00:00:00Z")).toBe("2026-07-01");
  });
});

describe("clusterByDay", () => {
  test("7 distinct-entity fragments across 2 dates form exactly 2 clusters (not 7 singletons)", () => {
    const fragments: EventFragment[] = [
      fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z"),
      fragment("ev-2", "explain-orchestrator", "2026-07-01T11:00:00Z"),
      fragment("ev-3", "episode-synthesis", "2026-07-01T14:00:00Z"),
      fragment("ev-4", "memory-book", "2026-07-01T20:00:00Z"),
      fragment("ev-5", "entity-model", "2026-06-30T09:00:00Z"),
      fragment("ev-6", "event-fragment", "2026-06-30T13:00:00Z"),
      fragment("ev-7", "personality-drift", "2026-06-30T22:00:00Z"),
    ];

    const clusters = clusterByDay(fragments);

    expect(clusters.size).toBe(2);
    expect(clusters.get("2026-07-01")).toHaveLength(4);
    expect(clusters.get("2026-06-30")).toHaveLength(3);
  });

  test("does not filter by EPISODE_MIN_MEMBERS — a singleton day is still present in the map", () => {
    const fragments: EventFragment[] = [fragment("ev-1", "solo", "2026-07-05T09:00:00Z")];
    const clusters = clusterByDay(fragments);
    expect(clusters.get("2026-07-05")).toHaveLength(1);
  });
});

describe("EPISODE_MIN_MEMBERS boundary", () => {
  test("a day with 1 fragment is not clusterable: applyEpisodes drops a <2-member draft", () => {
    const singleton = draft({
      day_key: "2026-07-05",
      member_fragment_ids: ["ev-only"],
    });
    const now = new Date("2026-07-05T20:00:00.000Z");
    const out = applyEpisodes(emptyMemory(), [singleton], now);
    expect(out.episodes).toHaveLength(0);
  });

  test("EPISODE_MIN_MEMBERS constant is exactly 2 (anti-confab floor)", () => {
    expect(EPISODE_MIN_MEMBERS).toBe(2);
  });
});

describe("applyEpisodes", () => {
  const now = new Date("2026-07-01T20:00:00.000Z");

  test("creates a new episode (version 1) with assigned id/timestamps", () => {
    const out = applyEpisodes(emptyMemory(), [draft()], now);
    expect(out.episodes).toHaveLength(1);
    const ep = out.episodes[0]!;
    expect(ep.id).toMatch(/^ep-/);
    expect(ep.version).toBe(1);
    expect(ep.created_at).toBe(now.toISOString());
    expect(ep.updated_at).toBe(now.toISOString());
    expect(new Date(ep.expires_at).getTime()).toBe(
      now.getTime() + EPISODE_TTL_DAYS * MS_PER_DAY,
    );
    expect(ep.member_fragment_ids).toEqual(["ev-1", "ev-2"]);
  });

  test("idempotent: re-applying the same member set does not bump version or touch updated_at", () => {
    const mem: CoreMemory = { ...emptyMemory(), episodes: [episode()] };
    const later = new Date("2026-07-02T09:00:00.000Z");
    const out = applyEpisodes(mem, [draft()], later);

    expect(out.episodes).toHaveLength(1);
    const ep = out.episodes[0]!;
    expect(ep.version).toBe(1);
    expect(ep.updated_at).toBe("2026-07-01T18:00:00Z"); // unchanged from fixture
  });

  test("idempotent even when the member set is reordered (order-independent set equality)", () => {
    const mem: CoreMemory = { ...emptyMemory(), episodes: [episode()] };
    const later = new Date("2026-07-02T09:00:00.000Z");
    const out = applyEpisodes(
      mem,
      [draft({ member_fragment_ids: ["ev-2", "ev-1"] })],
      later,
    );
    expect(out.episodes[0]!.version).toBe(1);
  });

  test("member change bumps version + updated_at, and prior day's episode stays present (never-delete)", () => {
    const prevDayEp = episode({
      id: "ep-prev",
      day_key: "2026-06-30",
      member_fragment_ids: ["ev-a", "ev-b", "ev-c"],
    });
    const mem: CoreMemory = { ...emptyMemory(), episodes: [episode(), prevDayEp] };
    const later = new Date("2026-07-02T09:00:00.000Z");

    const out = applyEpisodes(
      mem,
      [draft({ member_fragment_ids: ["ev-1", "ev-2", "ev-3"], narrative: "a new fragment landed" })],
      later,
    );

    expect(out.episodes).toHaveLength(2);
    const updated = out.episodes.find((e) => e.day_key === "2026-07-01")!;
    expect(updated.version).toBe(2);
    expect(updated.updated_at).toBe(later.toISOString());
    expect(updated.member_fragment_ids).toEqual(["ev-1", "ev-2", "ev-3"]);
    expect(updated.narrative).toBe("a new fragment landed");
    // created_at is NOT touched by an update
    expect(updated.created_at).toBe("2026-07-01T18:00:00Z");

    const prior = out.episodes.find((e) => e.day_key === "2026-06-30")!;
    expect(prior).toEqual(prevDayEp);
  });

  test("does not mutate the input memory", () => {
    const mem = emptyMemory();
    const before = mem.episodes;
    applyEpisodes(mem, [draft()], now);
    expect(mem.episodes).toBe(before);
    expect(mem.episodes).toHaveLength(0);
  });
});

describe("activeEpisodes", () => {
  test("filters an expired episode at read but keeps it in the store object", () => {
    const now = new Date("2026-07-15T00:00:00.000Z");
    const live = episode({ id: "ep-live", expires_at: "2027-07-01T00:00:00Z" });
    const expired = episode({ id: "ep-dead", expires_at: "2026-07-01T00:00:00Z" });
    const mem: CoreMemory = { ...emptyMemory(), episodes: [live, expired] };

    const active = activeEpisodes(mem, now);
    expect(active.map((e) => e.id)).toEqual(["ep-live"]);
    // kept in the store, not deleted:
    expect(mem.episodes.map((e) => e.id)).toEqual(["ep-live", "ep-dead"]);
  });
});

describe("resolveMembers", () => {
  test("resolves member ids against event_fragments", () => {
    const f1 = fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z");
    const f2 = fragment("ev-2", "explain-orchestrator", "2026-07-01T11:00:00Z");
    const mem: CoreMemory = { ...emptyMemory(), event_fragments: [f1, f2] };
    const ep = episode({ member_fragment_ids: ["ev-1", "ev-2"] });

    const resolved = resolveMembers(mem, ep);
    expect(resolved.map((f) => f.id)).toEqual(["ev-1", "ev-2"]);
  });

  test("an episode citing an absent fragment id resolves gracefully — skips it, never throws", () => {
    const f1 = fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z");
    const mem: CoreMemory = { ...emptyMemory(), event_fragments: [f1] };
    const ep = episode({ member_fragment_ids: ["ev-1", "ev-missing"] });

    expect(() => resolveMembers(mem, ep)).not.toThrow();
    const resolved = resolveMembers(mem, ep);
    expect(resolved.map((f) => f.id)).toEqual(["ev-1"]);
  });
});

describe("episodeSchema", () => {
  test("parses a valid episode", () => {
    const parsed = episodeSchema.parse(episode());
    expect(parsed.narrative).toBe("you shipped two things today");
  });

  test("rejects fewer than EPISODE_MIN_MEMBERS member ids", () => {
    const r = episodeSchema.safeParse(episode({ member_fragment_ids: ["ev-1"] }));
    expect(r.success).toBe(false);
  });

  test("rejects a narrative over 280 chars", () => {
    const r = episodeSchema.safeParse(episode({ narrative: "x".repeat(281) }));
    expect(r.success).toBe(false);
  });

  test("entity_labels defaults to []", () => {
    const { entity_labels, ...rest } = episode();
    const parsed = episodeSchema.parse(rest);
    expect(parsed.entity_labels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// smoke-fixup: legacy store missing episodes/event_fragments must not crash
// (surfaced by the $0 paid-smoke replay on a raw legacy store)
// ---------------------------------------------------------------------------

describe("episode ops — legacy store back-compat (never-throws)", () => {
  function legacyMemory(): CoreMemory {
    const m = emptyMemory();
    // biome-ignore lint/performance/noDelete: exercising a pre-schema doc shape
    delete (m as Record<string, unknown>).episodes;
    return m;
  }

  test("applyEpisodes on a memory with no `episodes` field -> creates, no crash", () => {
    const out = applyEpisodes(legacyMemory(), [draft()], new Date("2026-07-01T20:00:00Z"));
    expect(out.episodes).toHaveLength(1);
  });

  test("activeEpisodes on a memory with no `episodes` field -> [] , no crash", () => {
    expect(activeEpisodes(legacyMemory(), new Date("2026-07-01T20:00:00Z"))).toEqual([]);
  });

  test("resolveMembers with no `event_fragments` field -> skips all, no crash", () => {
    const m = emptyMemory();
    // biome-ignore lint/performance/noDelete: exercising a pre-schema doc shape
    delete (m as Record<string, unknown>).event_fragments;
    const ep = { ...draft(), id: "ep-x", version: 1, created_at: "", updated_at: "", expires_at: "" } as Episode;
    expect(resolveMembers(m, ep)).toEqual([]);
  });
});

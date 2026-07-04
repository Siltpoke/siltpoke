// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import {
  assembleEpisodePrompt,
  episodeNarrativeSchema,
  synthesizeEpisodes,
  type SynthesizeFn,
} from "../../src/memory/synthesize-episodes";
import type { Episode } from "../../src/memory/episode";
import type { EventFragment } from "../../src/memory/event-fragment";
import { emptyMemory, type CoreMemory } from "../../src/memory/memory";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fragment(id: string, entityName: string, occurred_at: string): EventFragment {
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

function episode(over: Partial<Episode> = {}): Episode {
  return {
    id: "ep-1",
    day_key: "2026-07-01",
    member_fragment_ids: ["ev-1", "ev-2"],
    time_span: { start: "2026-07-01T09:00:00Z", end: "2026-07-01T18:00:00Z" },
    narrative: "PRIOR NARRATIVE — must never be fed back into synthesis",
    entity_labels: ["repo-graph"],
    version: 1,
    created_at: "2026-07-01T18:00:00Z",
    updated_at: "2026-07-01T18:00:00Z",
    expires_at: "2027-07-01T18:00:00Z",
    ...over,
  };
}

const VALID_NARRATIVE =
  "You shipped the repo-graph indexer and wired the explain orchestrator on top of it.";

function memoryWith(fragments: EventFragment[], episodes: Episode[] = []): CoreMemory {
  return { ...emptyMemory(), event_fragments: fragments, episodes };
}

const NOW = new Date("2026-07-01T23:00:00.000Z");

/** A stub `synthesizeFn` that records every prompt it was called with and
 * returns a fixed raw string (or throws), used across most tests below. */
function spyFn(raw: string | Error): { fn: SynthesizeFn; prompts: string[]; calls: number[] } {
  const prompts: string[] = [];
  const fn: SynthesizeFn = async (prompt: string) => {
    prompts.push(prompt);
    if (raw instanceof Error) throw raw;
    return raw;
  };
  return { fn, prompts, calls: [] };
}

// ---------------------------------------------------------------------------
// assembleEpisodePrompt
// ---------------------------------------------------------------------------

describe("assembleEpisodePrompt", () => {
  test("renders fragment texts, entities, and the day; instructs narrative-only output", () => {
    const cluster = [
      fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z"),
      fragment("ev-2", "explain-orchestrator", "2026-07-01T14:00:00Z"),
    ];
    const prompt = assembleEpisodePrompt(cluster, "2026-07-01", "English");

    expect(prompt).toContain("2026-07-01");
    expect(prompt).toContain("did something with repo-graph");
    expect(prompt).toContain("did something with explain-orchestrator");
    expect(prompt).toContain("repo-graph");
    expect(prompt).toContain("explain-orchestrator");
    expect(prompt).toContain("English");
    expect(prompt.toLowerCase()).toContain("narrative");
    expect(prompt.toLowerCase()).not.toContain("which events belong");
  });
});

// ---------------------------------------------------------------------------
// episodeNarrativeSchema
// ---------------------------------------------------------------------------

describe("episodeNarrativeSchema", () => {
  test("accepts a well-formed payload", () => {
    const r = episodeNarrativeSchema.safeParse({
      narrative: VALID_NARRATIVE,
      entity_labels: ["repo-graph"],
    });
    expect(r.success).toBe(true);
  });

  test("truncates an over-280-char narrative instead of rejecting the whole payload", () => {
    const long = "x".repeat(400);
    const r = episodeNarrativeSchema.safeParse({ narrative: long, entity_labels: [] });
    expect(r.success).toBe(true);
    expect(r.data!.narrative.length).toBe(280);
  });

  test("entity_labels defaults/coerces to [] when wrong-shaped (STRICT schema would drop this whole payload)", () => {
    const r = episodeNarrativeSchema.safeParse({
      narrative: VALID_NARRATIVE,
      entity_labels: "repo-graph", // wrong shape: a string, not string[]
    });
    expect(r.success).toBe(true);
    expect(r.data!.entity_labels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// synthesizeEpisodes
// ---------------------------------------------------------------------------

describe("synthesizeEpisodes — never-throws", () => {
  test("non-JSON synthesizeFn output -> 0 drafts for that cluster, no throw", async () => {
    const mem = memoryWith([
      fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z"),
      fragment("ev-2", "explain-orchestrator", "2026-07-01T14:00:00Z"),
    ]);
    const { fn } = spyFn("not json at all, just prose");

    const drafts = await synthesizeEpisodes(mem, { synthesizeFn: fn, now: NOW, language: "English" });
    expect(drafts).toEqual([]);
  });

  test("synthesizeFn rejects -> degrades to [], no throw", async () => {
    const mem = memoryWith([
      fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z"),
      fragment("ev-2", "explain-orchestrator", "2026-07-01T14:00:00Z"),
    ]);
    const { fn } = spyFn(new Error("brain spawn failed"));

    let drafts: unknown;
    let threw = false;
    try {
      drafts = await synthesizeEpisodes(mem, { synthesizeFn: fn, now: NOW, language: "English" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(drafts).toEqual([]);
  });

  test("valid JSON but wrong outer shape (not an object) -> 0 drafts, no throw", async () => {
    const mem = memoryWith([
      fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z"),
      fragment("ev-2", "explain-orchestrator", "2026-07-01T14:00:00Z"),
    ]);
    const { fn } = spyFn(JSON.stringify(["not", "an", "object"]));

    const drafts = await synthesizeEpisodes(mem, { synthesizeFn: fn, now: NOW, language: "English" });
    expect(drafts).toEqual([]);
  });
});

describe("synthesizeEpisodes — lenient coerce (regression)", () => {
  test("extra fields + out-of-shape entity_labels still yield a usable narrative draft", async () => {
    const mem = memoryWith([
      fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z"),
      fragment("ev-2", "explain-orchestrator", "2026-07-01T14:00:00Z"),
    ]);
    const dirtyPayload = JSON.stringify({
      narrative: VALID_NARRATIVE,
      entity_labels: { not: "an-array" }, // wrong shape
      unexpected_top_level_field: "haiku improvised this",
      confidence: "high", // not even in the schema
    });
    const { fn } = spyFn(dirtyPayload);

    const drafts = await synthesizeEpisodes(mem, { synthesizeFn: fn, now: NOW, language: "English" });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.narrative).toBe(VALID_NARRATIVE);
    expect(drafts[0]!.entity_labels).toEqual([]);
  });
});

describe("synthesizeEpisodes — membership is code-selected", () => {
  test("member_fragment_ids come from the input cluster, never from the LLM's output", async () => {
    const mem = memoryWith([
      fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z"),
      fragment("ev-2", "explain-orchestrator", "2026-07-01T14:00:00Z"),
    ]);
    // The LLM hallucinates a membership-shaped field; the schema has no slot
    // for it, so it must be silently ignored by the orchestrator.
    const payload = JSON.stringify({
      narrative: VALID_NARRATIVE,
      entity_labels: [],
      member_fragment_ids: ["ev-999-hallucinated"],
    });
    const { fn } = spyFn(payload);

    const drafts = await synthesizeEpisodes(mem, { synthesizeFn: fn, now: NOW, language: "English" });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.member_fragment_ids.sort()).toEqual(["ev-1", "ev-2"]);
  });
});

describe("synthesizeEpisodes — time_span computed from members", () => {
  test("time_span.start/end are min/max member occurred_at, not the LLM's output nor flattened", async () => {
    const mem = memoryWith([
      fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z"),
      fragment("ev-2", "explain-orchestrator", "2026-07-01T20:00:00Z"),
      fragment("ev-3", "memory-book", "2026-07-01T14:00:00Z"),
    ]);
    // The LLM hallucinates an irrelevant time_span-shaped field — must be ignored.
    const payload = JSON.stringify({
      narrative: VALID_NARRATIVE,
      entity_labels: [],
      time_span: { start: "1999-01-01T00:00:00Z", end: "1999-01-01T00:00:00Z" },
    });
    const { fn } = spyFn(payload);

    const drafts = await synthesizeEpisodes(mem, { synthesizeFn: fn, now: NOW, language: "English" });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.time_span).toEqual({
      start: "2026-07-01T09:00:00Z",
      end: "2026-07-01T20:00:00Z",
    });
  });
});

describe("synthesizeEpisodes — anti-confab", () => {
  test("never passes an existing episode's narrative into the synthesizeFn prompt", async () => {
    const existing = episode({
      day_key: "2026-07-01",
      member_fragment_ids: ["ev-1"], // deliberately DIFFERENT from the new cluster -> "changed", triggers re-narration
    });
    const mem = memoryWith(
      [
        fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z"),
        fragment("ev-2", "explain-orchestrator", "2026-07-01T14:00:00Z"),
      ],
      [existing],
    );
    const { fn, prompts } = spyFn(
      JSON.stringify({ narrative: VALID_NARRATIVE, entity_labels: [] }),
    );

    await synthesizeEpisodes(mem, { synthesizeFn: fn, now: NOW, language: "English" });

    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      expect(p).not.toContain(existing.narrative);
    }
  });
});

describe("synthesizeEpisodes — skip-if-unchanged", () => {
  test("existing episode with the SAME member set -> zero synthesizeFn calls", async () => {
    const existing = episode({
      day_key: "2026-07-01",
      member_fragment_ids: ["ev-1", "ev-2"], // exactly matches the current day-bucket
    });
    const mem = memoryWith(
      [
        fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z"),
        fragment("ev-2", "explain-orchestrator", "2026-07-01T14:00:00Z"),
      ],
      [existing],
    );
    let callCount = 0;
    const fn: SynthesizeFn = async () => {
      callCount++;
      return JSON.stringify({ narrative: VALID_NARRATIVE, entity_labels: [] });
    };

    const drafts = await synthesizeEpisodes(mem, { synthesizeFn: fn, now: NOW, language: "English" });
    expect(callCount).toBe(0);
    expect(drafts).toEqual([]);
  });

  test("member set unchanged even when reordered -> still skipped (order-independent)", async () => {
    const existing = episode({
      day_key: "2026-07-01",
      member_fragment_ids: ["ev-2", "ev-1"], // same set, different order
    });
    const mem = memoryWith(
      [
        fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z"),
        fragment("ev-2", "explain-orchestrator", "2026-07-01T14:00:00Z"),
      ],
      [existing],
    );
    let callCount = 0;
    const fn: SynthesizeFn = async () => {
      callCount++;
      return JSON.stringify({ narrative: VALID_NARRATIVE, entity_labels: [] });
    };

    await synthesizeEpisodes(mem, { synthesizeFn: fn, now: NOW, language: "English" });
    expect(callCount).toBe(0);
  });
});

describe("synthesizeEpisodes — min-members floor", () => {
  test("a day-bucket with 1 fragment -> no draft, no synthesizeFn call", async () => {
    const mem = memoryWith([fragment("ev-1", "solo", "2026-07-05T09:00:00Z")]);
    let callCount = 0;
    const fn: SynthesizeFn = async () => {
      callCount++;
      return JSON.stringify({ narrative: VALID_NARRATIVE, entity_labels: [] });
    };

    const drafts = await synthesizeEpisodes(mem, { synthesizeFn: fn, now: NOW, language: "English" });
    expect(drafts).toEqual([]);
    expect(callCount).toBe(0);
  });

  test("an empty fragment store -> no drafts, no calls", async () => {
    const mem = memoryWith([]);
    let callCount = 0;
    const fn: SynthesizeFn = async () => {
      callCount++;
      return JSON.stringify({ narrative: VALID_NARRATIVE, entity_labels: [] });
    };

    const drafts = await synthesizeEpisodes(mem, { synthesizeFn: fn, now: NOW, language: "English" });
    expect(drafts).toEqual([]);
    expect(callCount).toBe(0);
  });
});

describe("synthesizeEpisodes — two new day-buckets", () => {
  test("both new -> 2 drafts, synthesizeFn called twice with the right per-day fragments", async () => {
    const mem = memoryWith([
      fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z"),
      fragment("ev-2", "explain-orchestrator", "2026-07-01T14:00:00Z"),
      fragment("ev-3", "entity-model", "2026-06-30T09:00:00Z"),
      fragment("ev-4", "event-fragment", "2026-06-30T13:00:00Z"),
    ]);
    const { fn, prompts } = spyFn(
      JSON.stringify({ narrative: VALID_NARRATIVE, entity_labels: [] }),
    );

    const drafts = await synthesizeEpisodes(mem, { synthesizeFn: fn, now: NOW, language: "English" });

    expect(drafts).toHaveLength(2);
    expect(prompts).toHaveLength(2);

    const byDay = new Map(drafts.map((d) => [d.day_key, d]));
    expect(byDay.get("2026-07-01")!.member_fragment_ids.sort()).toEqual(["ev-1", "ev-2"]);
    expect(byDay.get("2026-06-30")!.member_fragment_ids.sort()).toEqual(["ev-3", "ev-4"]);

    // Each prompt is scoped to its own day's fragments — no cross-day bleed.
    const promptForJul1 = prompts.find((p) => p.includes("2026-07-01"))!;
    const promptForJun30 = prompts.find((p) => p.includes("2026-06-30"))!;
    expect(promptForJul1).toContain("repo-graph");
    expect(promptForJul1).not.toContain("entity-model");
    expect(promptForJun30).toContain("entity-model");
    expect(promptForJun30).not.toContain("repo-graph");
  });
});

// ---------------------------------------------------------------------------
// fenced-JSON envelope + per-cluster isolation (review findings)
// ---------------------------------------------------------------------------

describe("synthesizeEpisodes — markdown-fenced JSON envelope (regression)", () => {
  test("a ```json-fenced payload (real Haiku shape) still yields a draft — bare JSON.parse would drop it", async () => {
    const mem = memoryWith([
      fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z"),
      fragment("ev-2", "explain", "2026-07-01T18:00:00Z"),
    ]);
    // The exact shape a bare `JSON.parse` chokes on — the fix strips the fence first.
    const fenced = "```json\n" + JSON.stringify({ narrative: VALID_NARRATIVE }) + "\n```";
    const { fn } = spyFn(fenced);

    const drafts = await synthesizeEpisodes(mem, { synthesizeFn: fn, now: NOW, language: "English" });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.narrative).toBe(VALID_NARRATIVE);
  });
});

describe("synthesizeEpisodes — per-cluster isolation (validator assertion gap)", () => {
  test("one malformed cluster + one valid cluster in the same run -> valid one survives, no throw", async () => {
    const mem = memoryWith([
      fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z"),
      fragment("ev-2", "explain", "2026-07-01T18:00:00Z"),
      fragment("ev-3", "entity-model", "2026-06-30T09:00:00Z"),
      fragment("ev-4", "chat", "2026-06-30T18:00:00Z"),
    ]);
    // Malformed for the 06-30 day, valid JSON for the 07-01 day — keyed off the day in the prompt.
    const prompts: string[] = [];
    const fn: SynthesizeFn = async (prompt: string) => {
      prompts.push(prompt);
      if (prompt.includes("2026-06-30")) return "this is not json at all";
      return JSON.stringify({ narrative: VALID_NARRATIVE });
    };

    const drafts = await synthesizeEpisodes(mem, { synthesizeFn: fn, now: NOW, language: "English" });

    expect(prompts).toHaveLength(2); // both clusters attempted
    expect(drafts).toHaveLength(1); // only the valid one produced a draft
    expect(drafts[0]!.day_key).toBe("2026-07-01");
  });
});

// ---------------------------------------------------------------------------
// smoke-fixup: legacy store with no `episodes` field must not crash (never-throws)
// ---------------------------------------------------------------------------

describe("synthesizeEpisodes — legacy store back-compat", () => {
  test("a memory doc missing the `episodes` field entirely -> no throw, still synthesizes", async () => {
    // Real legacy stores have no `episodes` key (schema backfills [] only on a
    // schema-load; a raw doc may lack it). The smoke $0 replay hit this crash.
    const legacy = memoryWith([
      fragment("ev-1", "repo-graph", "2026-07-01T09:00:00Z"),
      fragment("ev-2", "explain", "2026-07-01T18:00:00Z"),
    ]);
    // biome-ignore lint/performance/noDelete: exercising a legacy doc shape
    delete (legacy as { episodes?: unknown }).episodes;
    const { fn } = spyFn(JSON.stringify({ narrative: VALID_NARRATIVE }));

    const drafts = await synthesizeEpisodes(legacy, { synthesizeFn: fn, now: NOW, language: "English" });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.day_key).toBe("2026-07-01");
  });
});

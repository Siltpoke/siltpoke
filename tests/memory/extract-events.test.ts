// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, it, test } from "bun:test";
import type { BrainCallRawResult, CallBrainOptions } from "../../src/brain/brain";
import {
  assembleEventPrompt,
  EVENT_EXTRACT_MAX,
  eventCandidateSchema,
  extractEventFragments,
} from "../../src/memory/extract-events";
import type { BrainFn, SummarizerContext } from "../../src/memory/summarizer";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const emptyContext: SummarizerContext = {
  activeFacts: [],
  recentCritiques: [],
  recentChat: [],
  recentDismissals: [],
  sessionsNeedingSummary: [],
};

const richContext: SummarizerContext = {
  activeFacts: [],
  recentCritiques: ["critique_for_claude: repeated god-file smell"],
  recentChat: ["[user] I finally shipped the repo-graph explain feature"],
  recentDismissals: [],
  sessionsNeedingSummary: [],
  codingActivity: {
    commits: [
      {
        sha: "abc1234",
        subject: "feat: episodic fragment capture",
        files: ["src/memory/event-fragment.ts"],
        additions: 110,
        deletions: 2,
        date: "2026-06-30T00:00:00Z",
      },
    ],
    criticSummary: { byCategory: { "god-file": 3 }, total: 3 },
  },
};

function makeBrainFn(raw: unknown): BrainFn {
  return async (_opts: CallBrainOptions): Promise<BrainCallRawResult> => ({
    output: raw,
    usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 10,
      output_tokens: 20,
      total_cost_usd: null,
    },
  });
}

const validEvent = {
  text: "Developer shipped the episodic fragment capture feature.",
  occurred_at: "2026-06-30T00:00:00Z",
  sources: [{ kind: "commit", ref: "abc1234" }],
  entities: [{ name: "episodic capture", type: "project" }],
  confidence: 0.8,
  stream: "commit",
};

// ---------------------------------------------------------------------------
// eventCandidateSchema
// ---------------------------------------------------------------------------

describe("eventCandidateSchema", () => {
  it("accepts a fully-specified event", () => {
    expect(eventCandidateSchema.safeParse(validEvent).success).toBe(true);
  });

  it("accepts an event with entities + confidence omitted", () => {
    const { entities, confidence, ...rest } = validEvent;
    void entities;
    void confidence;
    expect(eventCandidateSchema.safeParse(rest).success).toBe(true);
  });

  it("rejects text > 280 chars", () => {
    expect(
      eventCandidateSchema.safeParse({ ...validEvent, text: "x".repeat(281) }).success,
    ).toBe(false);
  });

  it("rejects an event with empty sources (min 1)", () => {
    expect(
      eventCandidateSchema.safeParse({ ...validEvent, sources: [] }).success,
    ).toBe(false);
  });

  it("rejects an unknown stream value", () => {
    expect(
      eventCandidateSchema.safeParse({ ...validEvent, stream: "dismissal" }).success,
    ).toBe(false);
  });

  // Live-smoke regression: the real Haiku emits free-form entity `type` values
  // ("module", "ui-surface", "system") outside the EntityType enum. These must NOT
  // fail the whole candidate (that dropped 100% of real events in smoke) — the
  // out-of-enum type is coerced to null, the entity name is preserved.
  it("keeps a candidate whose entity type is out-of-enum (coerces type to null)", () => {
    const parsed = eventCandidateSchema.safeParse({
      ...validEvent,
      entities: [{ name: "episodic-event-extractor", type: "module" }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.entities?.[0]).toEqual({
      name: "episodic-event-extractor",
      type: null,
    });
  });

  it("preserves a valid in-enum entity type", () => {
    const parsed = eventCandidateSchema.safeParse({
      ...validEvent,
      entities: [{ name: "siltpoke", type: "project" }],
    });
    expect(parsed.success && parsed.data.entities?.[0]?.type).toBe("project");
  });
});

// ---------------------------------------------------------------------------
// assembleEventPrompt
// ---------------------------------------------------------------------------

describe("assembleEventPrompt", () => {
  it("includes the JSON emit instruction for events", () => {
    expect(assembleEventPrompt(emptyContext)).toContain('{ "events": [...] }');
  });

  it("instructs the model NOT to restate profile/preference facts", () => {
    const p = assembleEventPrompt(emptyContext).toLowerCase();
    expect(p).toContain("do not restate");
    expect(p).toContain("profile");
  });

  it("includes coding activity (commit subject) and chat signals", () => {
    const p = assembleEventPrompt(richContext);
    expect(p).toContain("feat: episodic fragment capture");
    expect(p).toContain("I finally shipped the repo-graph explain feature");
  });

  it("includes recent critiques", () => {
    expect(assembleEventPrompt(richContext)).toContain("repeated god-file smell");
  });
});

// ---------------------------------------------------------------------------
// extractEventFragments
// ---------------------------------------------------------------------------

describe("extractEventFragments", () => {
  it("parses valid events from a stub brainFn", async () => {
    const drafts = await extractEventFragments(richContext, {
      brainFn: makeBrainFn({ events: [validEvent] }),
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.text).toBe(validEvent.text);
    expect(drafts[0]?.learned_from_stream).toBe("commit");
    expect(drafts[0]?.sources[0]?.ref).toBe("abc1234");
  });

  it("defaults entities + confidence when omitted", async () => {
    const { entities, confidence, ...rest } = validEvent;
    void entities;
    void confidence;
    const drafts = await extractEventFragments(richContext, {
      brainFn: makeBrainFn({ events: [rest] }),
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.entities).toEqual([]);
    expect(drafts[0]?.confidence).toBe(0.7);
  });

  it("returns [] (does not throw) on malformed OUTER shape", async () => {
    await expect(
      extractEventFragments(emptyContext, { brainFn: makeBrainFn({ foo: 1 }) }),
    ).resolves.toEqual([]);
    await expect(
      extractEventFragments(emptyContext, { brainFn: makeBrainFn("not json") }),
    ).resolves.toEqual([]);
  });

  it("returns [] (does not reject) when brainFn throws", async () => {
    const throwingBrainFn: BrainFn = async () => {
      throw new Error("spawn fail");
    };
    await expect(
      extractEventFragments(richContext, { brainFn: throwingBrainFn }),
    ).resolves.toEqual([]);
  });

  it("drops one bad item (missing sources), keeps valid ones", async () => {
    const { sources, ...noSources } = validEvent;
    void sources;
    const drafts = await extractEventFragments(richContext, {
      brainFn: makeBrainFn({ events: [noSources, validEvent] }),
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.text).toBe(validEvent.text);
  });

  it("drops an event with empty sources (min 1 enforced)", async () => {
    const drafts = await extractEventFragments(richContext, {
      brainFn: makeBrainFn({ events: [{ ...validEvent, sources: [] }] }),
    });
    expect(drafts).toHaveLength(0);
  });

  it(`truncates past EVENT_EXTRACT_MAX (${EVENT_EXTRACT_MAX})`, async () => {
    const many = Array.from({ length: EVENT_EXTRACT_MAX + 5 }, (_, i) => ({
      ...validEvent,
      text: `Developer did thing number ${i}.`,
    }));
    const drafts = await extractEventFragments(richContext, {
      brainFn: makeBrainFn({ events: many }),
    });
    expect(drafts).toHaveLength(EVENT_EXTRACT_MAX);
  });
});

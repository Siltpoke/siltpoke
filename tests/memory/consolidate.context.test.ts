/**
 * Task 4 — wire codingActivity into buildSummarizerContext.
 * Tests that buildSummarizerContext populates codingActivity from injectable loaders.
 */

import { describe, it, expect } from "bun:test";
import { buildSummarizerContext, isRubricNoiseCritique } from "../../src/memory/consolidate";
import type { CoreMemory } from "../../src/memory/memory";

function makeMemory(overrides?: Partial<CoreMemory>): CoreMemory {
  const baseNow = new Date("2026-04-01T00:00:00.000Z").toISOString();
  return {
    schemaVersion: 2,
    long_term_summary: "",
    learned_rules: [],
    personality_drift: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0 },
    last_consolidated_at: baseNow,
    consolidation_due_at: baseNow,
    user_profile: {
      communication_style: "neutral",
      goals: [],
      constraints: [],
      prefs: {},
    },
    chat_sessions: [],
    facts: [],
    event_fragments: [],
    episodes: [],
    ...overrides,
  };
}

describe("buildSummarizerContext — codingActivity (Task 4)", () => {
  it("populates codingActivity.commits + criticSummary from injected loaders", async () => {
    const mem = makeMemory();
    const ctx = await buildSummarizerContext("/fake/home", mem, new Date(0), {
      projectRoot: "/repo",
      loadRecentCommits: async (_root, _since) => [
        {
          sha: "abc123",
          subject: "feat: add score board",
          files: ["src/score/board.yaml"],
          additions: 5,
          deletions: 1,
          date: "2026-06-28T00:00:00Z",
        },
      ],
      loadAllCritiqueEntries: async (_homeBase) => [
        { id: "c1", ts: "2026-06-28T00:00:00Z", body: "god-file at src/a.ts:1 — File is 900 lines" },
      ],
      loadRecentCritiques: async () => [],
      loadRecentDismissals: async () => [],
      loadRecentChatMessages: async () => [],
      readSession: async () => [],
    });
    expect(ctx.codingActivity.commits.length).toBe(1);
    expect(ctx.codingActivity.commits[0]?.sha).toBe("abc123");
    expect(ctx.codingActivity.criticSummary.total).toBe(1);
    expect(ctx.codingActivity.criticSummary.byCategory["god-file"]).toBe(1);
  });

  it("criticSummary excludes critique entries older than lastConsolidatedAt", async () => {
    const mem = makeMemory();
    const lastConsolidatedAt = new Date("2026-06-15T00:00:00Z");
    const ctx = await buildSummarizerContext("/fake/home", mem, lastConsolidatedAt, {
      loadAllCritiqueEntries: async () => [
        // Before the cutoff → excluded by summarizeCriticEvents' since filter.
        { id: "c0", ts: "2026-06-01T00:00:00Z", body: "god-file at src/old.ts:1" },
      ],
      loadRecentCritiques: async () => [],
      loadRecentDismissals: async () => [],
      loadRecentChatMessages: async () => [],
      readSession: async () => [],
    });
    expect(ctx.codingActivity.criticSummary.total).toBe(0);
    expect(ctx.codingActivity.criticSummary.byCategory).toEqual({});
  });

  it("commits defaults to [] when no projectRoot given", async () => {
    const mem = makeMemory();
    const ctx = await buildSummarizerContext("/fake/home", mem, new Date(0), {
      loadAllCritiqueEntries: async () => [],
      loadRecentCritiques: async () => [],
      loadRecentDismissals: async () => [],
      loadRecentChatMessages: async () => [],
      readSession: async () => [],
    });
    expect(ctx.codingActivity.commits).toEqual([]);
    expect(ctx.codingActivity.criticSummary.total).toBe(0);
  });

  it("criticSummary counts rubric-flag bodies via unfiltered path (Defect 2 fix)", async () => {
    // Real rubric-noise body — starts with the RUBRIC_NOISE_PREFIXES marker.
    // The OLD filtered path (loadAllCritiqueEntries) excludes bodies like this,
    // so summarizeCriticEvents received 0 entries → byCategory={} in production.
    const rubricNoiseBody =
      "Rubric flagged concerns the model didn't surface:\n- god-file at src/big.ts:1 — File is 900 lines";

    // (a) Prove the filter WOULD exclude this body (old path returned total=0)
    expect(isRubricNoiseCritique(rubricNoiseBody)).toBe(true);

    const mem = makeMemory();
    const ctx = await buildSummarizerContext("/fake/home", mem, new Date(0), {
      // (b) Provide via the unfiltered injectable — proves the new count path includes it
      loadAllCritiqueEntriesUnfiltered: async () => [
        { id: "c1", ts: "2026-06-28T00:00:00Z", body: rubricNoiseBody },
      ],
      // Provide filtered as empty to show the old path returned 0
      loadAllCritiqueEntries: async () => [],
      loadRecentCritiques: async () => [],
      loadRecentDismissals: async () => [],
      loadRecentChatMessages: async () => [],
      readSession: async () => [],
    });

    // New unfiltered path: rubric-flag body IS counted
    expect(ctx.codingActivity.criticSummary.total).toBe(1);
    expect(ctx.codingActivity.criticSummary.byCategory["god-file"]).toBe(1);
  });
});

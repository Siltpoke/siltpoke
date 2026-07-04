// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * extractEventFragments wired into consolidate() + code-side source-ref
 * grounding.
 *
 * Covers:
 *   commit-grounded drafts land in finalMemory.event_fragments (expiry + source).
 *   grounding — bogus refs dropped; mixed real+bogus keeps draft, strips bogus source.
 *   fact paths (facts[] + readActiveFacts/readActiveStyleFacts) identical w/ or w/o events.
 *   contingency — zero coding activity / extractor [] → 0 fragments, ran:true, no error.
 *   single write — writeMemoryFn invoked exactly once (events ride the existing write).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitSignal } from "../../src/memory/coding-signal";
import { consolidate } from "../../src/memory/consolidate";
import type { EventFragmentDraft } from "../../src/memory/event-fragment";
import { type CoreMemory, readMemory, writeMemory } from "../../src/memory/memory";
import { readActiveFacts, readActiveStyleFacts } from "../../src/memory/recall";
import type { SummarizerOutput } from "../../src/memory/summarizer";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "consolidate-events-"));
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

const REAL_SHA = "fixsha0000000000000000000000000000000000";
const BOGUS_REF = "bogus-not-a-real-id";

function buildBaseMemory(lastConsolidatedAt: string): CoreMemory {
  return {
    schemaVersion: 2,
    long_term_summary: "base summary",
    learned_rules: [],
    personality_drift: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0 },
    last_consolidated_at: lastConsolidatedAt,
    consolidation_due_at: lastConsolidatedAt,
    user_profile: { communication_style: "neutral", goals: [], constraints: [], prefs: {} },
    chat_sessions: [],
    event_fragments: [],
    episodes: [],
    facts: [
      {
        id: "f-style01",
        text: "User prefers responses in Chinese",
        source_session_id: null,
        confidence: 0.85,
        status: "active",
        created_at: lastConsolidatedAt,
        last_seen_at: lastConsolidatedAt,
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
        kind: "style",
      },
    ],
  };
}

function fixtureCommit(): CommitSignal {
  return {
    sha: REAL_SHA,
    subject: "feat: ship the thing",
    files: ["src/thing.ts"],
    additions: 40,
    deletions: 2,
    date: "2026-06-30T12:00:00Z",
  };
}

function commitDraft(ref: string): EventFragmentDraft {
  return {
    text: `Developer shipped the thing (${ref.slice(0, 6)})`,
    occurred_at: "2026-06-30T12:00:00Z",
    sources: [{ kind: "commit", ref }],
    entities: [],
    confidence: 0.8,
    learned_from_stream: "commit",
  };
}

const noopBrain = async (): Promise<SummarizerOutput> => ({ candidates: [] });

/** Common deps: real commit fixture, identity tagEntities (seed fact is untagged→would call brain). */
function baseDeps(extractDrafts: EventFragmentDraft[]) {
  return {
    callSummarizerBrain: noopBrain,
    tagEntities: async (m: CoreMemory) => m,
    loadRecentCommits: async (): Promise<CommitSignal[]> => [fixtureCommit()],
    extractEventFragments: async (): Promise<EventFragmentDraft[]> => extractDrafts,
    // Defensive default (janitor-default-on lesson, mirrors extractEventFragments
    // above): existing tests in this file never produce >=2 same-day fragments,
    // so synthesizeEpisodes makes zero calls today regardless — this stub just
    // guarantees no accidental live Haiku call for any future/derived test.
    synthesizeFn: async () => "{}",
  };
}

describe("consolidate — event-fragment wiring", () => {
  test("commit-grounded drafts land in finalMemory.event_fragments with expiry + source", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    await writeMemory(tmpHome, buildBaseMemory(eightDaysAgo));

    const now = new Date();
    const result = await consolidate({
      homeBase: tmpHome,
      projectBase: join(tmpHome, ".siltpoke"),
      now,
      deps: baseDeps([commitDraft(REAL_SHA)]),
    });

    expect(result.ran).toBe(true);
    if (result.ran) expect(result.eventFragments).toBe(1);

    const updated = (await readMemory(tmpHome))!;
    expect(updated.event_fragments).toHaveLength(1);
    const f = updated.event_fragments[0]!;
    expect(f.id).toMatch(/^ev-/);
    expect(f.sources).toEqual([{ kind: "commit", ref: REAL_SHA }]);
    expect(f.created_at).toBe(now.toISOString());
    expect(new Date(f.expires_at).getTime()).toBeGreaterThan(new Date(f.created_at).getTime());
  });

  test("grounding: bogus-ref draft dropped; mixed real+bogus kept with bogus source stripped", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    await writeMemory(tmpHome, buildBaseMemory(eightDaysAgo));

    const bogusOnly = commitDraft(BOGUS_REF); // no real source → dropped entirely
    const mixed: EventFragmentDraft = {
      text: "Developer shipped a mixed-source event",
      occurred_at: "2026-06-30T12:00:00Z",
      sources: [
        { kind: "commit", ref: REAL_SHA },
        { kind: "critique", ref: BOGUS_REF },
      ],
      entities: [],
      confidence: 0.8,
      learned_from_stream: "commit",
    };

    const result = await consolidate({
      homeBase: tmpHome,
      projectBase: join(tmpHome, ".siltpoke"),
      now: new Date(),
      deps: baseDeps([bogusOnly, mixed]),
    });

    expect(result.ran).toBe(true);
    if (result.ran) expect(result.eventFragments).toBe(1);

    const updated = (await readMemory(tmpHome))!;
    expect(updated.event_fragments).toHaveLength(1);
    const kept = updated.event_fragments[0]!;
    expect(kept.text).toBe("Developer shipped a mixed-source event");
    // bogus source stripped, only the verifiable real one stored
    expect(kept.sources).toEqual([{ kind: "commit", ref: REAL_SHA }]);
  });

  test("grounding: real commit sha under a mismatched kind is DROPPED (kind must match)", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    await writeMemory(tmpHome, buildBaseMemory(eightDaysAgo));

    // Same REAL sha, but one draft mislabels its kind as "critique" (fabricated
    // provenance). Grounding verifies kind:"commit" AND ref∈knownRefs, so the
    // mislabelled draft must drop while the correctly-labelled one is kept.
    const mislabelled: EventFragmentDraft = {
      text: "Mislabelled provenance — commit sha under a critique kind",
      occurred_at: "2026-06-30T12:00:00Z",
      sources: [{ kind: "critique", ref: REAL_SHA }],
      entities: [],
      confidence: 0.8,
      learned_from_stream: "critique",
    };
    const honest: EventFragmentDraft = {
      text: "Honest provenance — commit sha under a commit kind",
      occurred_at: "2026-06-30T12:00:00Z",
      sources: [{ kind: "commit", ref: REAL_SHA }],
      entities: [],
      confidence: 0.8,
      learned_from_stream: "commit",
    };

    const result = await consolidate({
      homeBase: tmpHome,
      projectBase: join(tmpHome, ".siltpoke"),
      now: new Date(),
      deps: baseDeps([mislabelled, honest]),
    });

    expect(result.ran).toBe(true);
    if (result.ran) expect(result.eventFragments).toBe(1);

    const updated = (await readMemory(tmpHome))!;
    expect(updated.event_fragments).toHaveLength(1);
    expect(updated.event_fragments[0]!.text).toBe(
      "Honest provenance — commit sha under a commit kind",
    );
  });

  test("differential: fact paths identical whether events present or not", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const now = new Date();

    // Run WITH events
    const homeWith = mkdtempSync(join(tmpdir(), "consolidate-ev-with-"));
    await writeMemory(homeWith, buildBaseMemory(eightDaysAgo));
    await consolidate({
      homeBase: homeWith,
      projectBase: join(homeWith, ".siltpoke"),
      now,
      deps: baseDeps([commitDraft(REAL_SHA)]),
    });
    const memWith = (await readMemory(homeWith))!;

    // Run WITHOUT events (extractor returns [])
    const homeWithout = mkdtempSync(join(tmpdir(), "consolidate-ev-without-"));
    await writeMemory(homeWithout, buildBaseMemory(eightDaysAgo));
    await consolidate({
      homeBase: homeWithout,
      projectBase: join(homeWithout, ".siltpoke"),
      now,
      deps: baseDeps([]),
    });
    const memWithout = (await readMemory(homeWithout))!;

    try {
      // facts[] byte-identical
      expect(JSON.stringify(memWith.facts)).toBe(JSON.stringify(memWithout.facts));
      // recall outputs identical
      expect(JSON.stringify(readActiveFacts(memWith))).toBe(
        JSON.stringify(readActiveFacts(memWithout)),
      );
      expect(JSON.stringify(readActiveStyleFacts(memWith))).toBe(
        JSON.stringify(readActiveStyleFacts(memWithout)),
      );
      // but events DID diverge (proves the with-run actually exercised the event path)
      expect(memWith.event_fragments).toHaveLength(1);
      expect(memWithout.event_fragments).toHaveLength(0);
    } finally {
      rmSync(homeWith, { recursive: true, force: true });
      rmSync(homeWithout, { recursive: true, force: true });
    }
  });

  test("contingency: zero coding activity + extractor [] → 0 fragments, ran:true, no error", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    await writeMemory(tmpHome, buildBaseMemory(eightDaysAgo));

    // A chat signal to satisfy the minimum-signal guard without any commits.
    const dir = join(tmpHome, "chats");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const msgTs = new Date(Date.now() - 8 * 24 * 3600 * 1000 + 60_000).toISOString();
    writeFileSync(
      join(dir, "sess-x.jsonl"),
      JSON.stringify({
        id: "m1", session_id: "sess-x", role: "user", content: "hi",
        ts: msgTs, model: null, tokens: null, fts_skip: false, claude_session_id: null,
      }),
      "utf8",
    );

    const result = await consolidate({
      homeBase: tmpHome,
      now: new Date(),
      deps: {
        callSummarizerBrain: noopBrain,
        tagEntities: async (m: CoreMemory) => m,
        loadRecentCommits: async (): Promise<CommitSignal[]> => [],
        extractEventFragments: async (): Promise<EventFragmentDraft[]> => [],
      },
    });

    expect(result.ran).toBe(true);
    if (result.ran) expect(result.eventFragments).toBe(0);

    const updated = (await readMemory(tmpHome))!;
    expect(updated.event_fragments).toHaveLength(0);
  });

  test("single write: writeMemoryFn invoked exactly once (events ride the existing write)", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    await writeMemory(tmpHome, buildBaseMemory(eightDaysAgo));

    let writeCount = 0;
    await consolidate({
      homeBase: tmpHome,
      projectBase: join(tmpHome, ".siltpoke"),
      now: new Date(),
      deps: {
        ...baseDeps([commitDraft(REAL_SHA)]),
        writeMemory: async (home: string, m: CoreMemory, projectCwd?: string) => {
          writeCount += 1;
          await writeMemory(home, m, projectCwd);
        },
      },
    });

    expect(writeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Episode synthesis — synthesizeEpisodes/applyEpisodes wired into
// consolidate Step 5, AFTER applyEventFragments, before the single write.
//
// Covers:
//   Fragments spanning 2 day-buckets → 2 episodes, episodesSynthesized:2.
//   Unchanged re-run (same member set) makes zero synthesizeFn calls.
//   synthesizeFn throwing degrades to 0 episodes; facts + event
//   fragments stay intact (never breaks the rest of the pass).
// ---------------------------------------------------------------------------

const SHA_DAY_A_1 = "aaaaaaa1111111111111111111111111111111a";
const SHA_DAY_A_2 = "aaaaaaa2222222222222222222222222222222a";
const SHA_DAY_B_1 = "bbbbbbb1111111111111111111111111111111b";
const SHA_DAY_B_2 = "bbbbbbb2222222222222222222222222222222b";

/** Two commits on 2026-06-30 (day A) + two on 2026-07-01 (day B) — enough
 * per day to clear EPISODE_MIN_MEMBERS (2) in both UTC day-buckets. */
function twoDayCommits(): CommitSignal[] {
  return [
    { sha: SHA_DAY_A_1, subject: "feat: day A first", files: ["a1.ts"], additions: 5, deletions: 0, date: "2026-06-30T10:00:00Z" },
    { sha: SHA_DAY_A_2, subject: "feat: day A second", files: ["a2.ts"], additions: 5, deletions: 0, date: "2026-06-30T14:00:00Z" },
    { sha: SHA_DAY_B_1, subject: "feat: day B first", files: ["b1.ts"], additions: 5, deletions: 0, date: "2026-07-01T09:00:00Z" },
    { sha: SHA_DAY_B_2, subject: "feat: day B second", files: ["b2.ts"], additions: 5, deletions: 0, date: "2026-07-01T11:00:00Z" },
  ];
}

function twoDayDrafts(): EventFragmentDraft[] {
  return [
    {
      text: "Developer shipped day-A first change",
      occurred_at: "2026-06-30T10:00:00Z",
      sources: [{ kind: "commit", ref: SHA_DAY_A_1 }],
      entities: [],
      confidence: 0.8,
      learned_from_stream: "commit",
    },
    {
      text: "Developer shipped day-A second change",
      occurred_at: "2026-06-30T14:00:00Z",
      sources: [{ kind: "commit", ref: SHA_DAY_A_2 }],
      entities: [],
      confidence: 0.8,
      learned_from_stream: "commit",
    },
    {
      text: "Developer shipped day-B first change",
      occurred_at: "2026-07-01T09:00:00Z",
      sources: [{ kind: "commit", ref: SHA_DAY_B_1 }],
      entities: [],
      confidence: 0.8,
      learned_from_stream: "commit",
    },
    {
      text: "Developer shipped day-B second change",
      occurred_at: "2026-07-01T11:00:00Z",
      sources: [{ kind: "commit", ref: SHA_DAY_B_2 }],
      entities: [],
      confidence: 0.8,
      learned_from_stream: "commit",
    },
  ];
}

describe("consolidate — episode synthesis wiring", () => {
  test("fragments spanning 2 day-buckets → 2 episodes, episodesSynthesized:2", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    await writeMemory(tmpHome, buildBaseMemory(eightDaysAgo));

    let synthesizeCalls = 0;
    const now = new Date();
    const result = await consolidate({
      homeBase: tmpHome,
      projectBase: join(tmpHome, ".siltpoke"),
      now,
      deps: {
        callSummarizerBrain: noopBrain,
        tagEntities: async (m: CoreMemory) => m,
        loadRecentCommits: async (): Promise<CommitSignal[]> => twoDayCommits(),
        extractEventFragments: async (): Promise<EventFragmentDraft[]> => twoDayDrafts(),
        synthesizeFn: async () => {
          synthesizeCalls++;
          return JSON.stringify({ narrative: "A cohesive two-event day.", entity_labels: [] });
        },
      },
    });

    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.eventFragments).toBe(4);
      expect(result.episodesSynthesized).toBe(2);
    }
    expect(synthesizeCalls).toBe(2); // one call per day-bucket cluster

    const updated = (await readMemory(tmpHome))!;
    expect(updated.episodes).toHaveLength(2);
    const dayKeys = updated.episodes.map((e) => e.day_key).sort();
    expect(dayKeys).toEqual(["2026-06-30", "2026-07-01"]);
    for (const ep of updated.episodes) {
      expect(ep.member_fragment_ids.length).toBeGreaterThanOrEqual(2);
      expect(ep.narrative).toBe("A cohesive two-event day.");
      expect(ep.version).toBe(1);
    }
  });

  test("unchanged re-run (same member set) makes zero synthesizeFn calls", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    await writeMemory(tmpHome, buildBaseMemory(eightDaysAgo));

    const commits = twoDayCommits();
    const drafts = twoDayDrafts();

    const round1Now = new Date();
    const round1 = await consolidate({
      homeBase: tmpHome,
      projectBase: join(tmpHome, ".siltpoke"),
      now: round1Now,
      deps: {
        callSummarizerBrain: noopBrain,
        tagEntities: async (m: CoreMemory) => m,
        loadRecentCommits: async (): Promise<CommitSignal[]> => commits,
        extractEventFragments: async (): Promise<EventFragmentDraft[]> => drafts,
        synthesizeFn: async () => JSON.stringify({ narrative: "First-pass narrative.", entity_labels: [] }),
      },
    });
    expect(round1.ran).toBe(true);
    if (round1.ran) expect(round1.episodesSynthesized).toBe(2);

    // Re-run far enough later to clear the trigger gate (minDays=7), with the
    // SAME commits/drafts (identical text) — applyEventFragments dedups them
    // to zero NEW fragments, so the day-bucket member sets are byte-identical
    // to what applyEpisodes already stored → skip-if-unchanged should fire.
    const round2Now = new Date(round1Now.getTime() + 8 * 24 * 3600 * 1000);
    let round2SynthesizeCalls = 0;
    const round2 = await consolidate({
      homeBase: tmpHome,
      projectBase: join(tmpHome, ".siltpoke"),
      now: round2Now,
      deps: {
        callSummarizerBrain: noopBrain,
        tagEntities: async (m: CoreMemory) => m,
        loadRecentCommits: async (): Promise<CommitSignal[]> => commits,
        extractEventFragments: async (): Promise<EventFragmentDraft[]> => drafts,
        synthesizeFn: async () => {
          round2SynthesizeCalls++;
          return JSON.stringify({ narrative: "Should never be called.", entity_labels: [] });
        },
      },
    });

    expect(round2.ran).toBe(true);
    if (round2.ran) {
      expect(round2.eventFragments).toBe(0); // dedup: no NEW fragments
      expect(round2.episodesSynthesized).toBe(0); // cost guard: no re-narration
    }
    expect(round2SynthesizeCalls).toBe(0);

    // Prior episodes kept, unchanged (never-clobber) — same narrative/version.
    const updated = (await readMemory(tmpHome))!;
    expect(updated.episodes).toHaveLength(2);
    for (const ep of updated.episodes) {
      expect(ep.narrative).toBe("First-pass narrative.");
      expect(ep.version).toBe(1);
    }
  });

  test("synthesizeFn throwing degrades to 0 episodes; facts + event fragments stay intact", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    await writeMemory(tmpHome, buildBaseMemory(eightDaysAgo));

    const now = new Date();
    const result = await consolidate({
      homeBase: tmpHome,
      projectBase: join(tmpHome, ".siltpoke"),
      now,
      deps: {
        callSummarizerBrain: noopBrain,
        tagEntities: async (m: CoreMemory) => m,
        loadRecentCommits: async (): Promise<CommitSignal[]> => twoDayCommits(),
        extractEventFragments: async (): Promise<EventFragmentDraft[]> => twoDayDrafts(),
        synthesizeFn: async () => {
          throw new Error("simulated brain failure");
        },
      },
    });

    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.eventFragments).toBe(4); // event capture unaffected
      expect(result.episodesSynthesized).toBe(0); // every cluster degraded to no-draft
    }

    const updated = (await readMemory(tmpHome))!;
    expect(updated.event_fragments).toHaveLength(4); // fragments intact (offline invariant)
    expect(updated.episodes).toHaveLength(0); // no episode stored, no throw
    // fact path untouched (differential: episode failure never
    // perturbs facts[]).
    expect(updated.facts.find((f) => f.id === "f-style01")).toBeDefined();
  });
});

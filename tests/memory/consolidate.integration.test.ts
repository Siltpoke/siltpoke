/**
 * Integration tests for consolidate().
 *
 * Sets up a real temp homeBase with seeded memory.json + fake critique files +
 * fake dismissal files. Injects a stub summarizer brain. Verifies that
 * memory.json is atomically updated by the end of the cycle.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consolidate } from "../../src/memory/consolidate";
import { readMemory, writeMemory } from "../../src/memory/memory";
import type { CoreMemory } from "../../src/memory/memory";
import type { SummarizerOutput } from "../../src/memory/summarizer";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "consolidate-int-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildBasememory(lastConsolidatedAt: string): CoreMemory {
  return {
    schemaVersion: 2,
    long_term_summary: "base summary",
    learned_rules: [],
    personality_drift: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0 },
    last_consolidated_at: lastConsolidatedAt,
    consolidation_due_at: lastConsolidatedAt,
    user_profile: {
      communication_style: "neutral",
      goals: [],
      constraints: [],
      prefs: {},
    },
    chat_sessions: [],
    event_fragments: [],
    episodes: [],
    facts: [
      {
        id: "f-retire01",
        text: "User dislikes long explanations",
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
      },
    ],
  };
}

function writeCritiqueFile(
  homeBase: string,
  id: string,
  timestamp: string,
  body: string,
): void {
  const dateDir = timestamp.slice(0, 10);
  const archiveDir = join(homeBase, "critiques", "archive", dateDir);
  mkdirSync(archiveDir, { recursive: true });
  const md = [
    "---",
    `schemaVersion: 1`,
    `timestamp: ${timestamp}`,
    `critique_id: ${id}`,
    `session_id: sess-001`,
    `cwd: /tmp/proj`,
    `project: proj`,
    `mood: happy`,
    `pose: base`,
    `severity: medium`,
    `confidence: high`,
    `status: pending`,
    "---",
    "",
    "# [SILTPOKE CRITIQUE]",
    "",
    "> secondary reviewer opinion.",
    "",
    "## Bubble (user-facing)",
    "",
    "Some bubble text",
    "",
    "## Critique (for Claude, if forwarded)",
    "",
    "```",
    body,
    "```",
    "",
    "## Severity / Confidence",
    "",
    "severity: medium",
    "confidence: high",
    "",
  ].join("\n");
  writeFileSync(join(archiveDir, `${id}.md`), md, "utf8");
}

function writeDismissal(
  homeBase: string,
  ts: string,
  rule_category: string,
  reason: string,
): void {
  const archivePath = join(homeBase, "feedback-archive.jsonl");
  const entry = JSON.stringify({
    ts,
    critique_id: "c-test",
    verdict: "dismissed",
    reason,
    reflection: { rule_id: null, rule_category, confidence: null },
  });
  writeFileSync(archivePath, entry + "\n", { flag: "a" });
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("consolidate() — integration", () => {
  test("end-to-end: trigger + fake brain + candidates → memory.json updated atomically", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const eightDaysAgoIso = eightDaysAgo.toISOString();

    // Seed memory.json
    const initialMemory = buildBasememory(eightDaysAgoIso);
    await writeMemory(tmpHome, initialMemory);

    // Seed critique file after last_consolidated_at
    const critiqueTs = new Date(eightDaysAgo.getTime() + 60_000).toISOString();
    writeCritiqueFile(
      tmpHome,
      "c-int01",
      critiqueTs,
      "User consistently skips type-checking errors",
    );

    // Seed dismissal after last_consolidated_at
    const dismissalTs = new Date(eightDaysAgo.getTime() + 120_000).toISOString();
    writeDismissal(tmpHome, dismissalTs, "type-safety", "too verbose");

    // Stub summarizer brain: 1 add + 1 retire
    const fakeRetireId = "f-retire01";
    const fakeBrain = async (): Promise<SummarizerOutput> => ({
      candidates: [
        {
          action: "add",
          candidate_claim: "User prefers short answers",
          evidence_quote: "User consistently skips",
          suggested_confidence: 0.92,
          supersedes_id: null,
        },
        {
          action: "retire",
          candidate_claim: "",
          evidence_quote: null,
          suggested_confidence: 0.8,
          supersedes_id: fakeRetireId,
        },
      ],
    });

    const now = new Date();
    const result = await consolidate({
      homeBase: tmpHome,
      now,
      deps: {
        callSummarizerBrain: fakeBrain,
      },
    });

    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.candidates).toBe(2);
      expect(result.apply.added).toBe(1);
      expect(result.apply.retired).toBe(1);
    }

    // Read back from disk to verify atomic write
    const updatedMemory = await readMemory(tmpHome);
    expect(updatedMemory).not.toBeNull();

    // +1 pending fact from "add" (pending-first regardless of confidence —
    // formerly born active when conf ≥ 0.9). The only pre-existing active
    // fact is retired below, leaving 0 active.
    const activeFacts = updatedMemory!.facts.filter((f) => f.status === "active");
    expect(activeFacts.length).toBe(0);
    const pendingFacts = updatedMemory!.facts.filter((f) => f.status === "pending");
    expect(pendingFacts.length).toBe(1);
    expect(pendingFacts[0]!.text).toBe("User prefers short answers");

    // 1 retired fact from "retire"
    const retiredFacts = updatedMemory!.facts.filter((f) => f.status === "retired");
    expect(retiredFacts.length).toBe(1);
    expect(retiredFacts[0]!.id).toBe(fakeRetireId);

    // Timestamps updated
    expect(updatedMemory!.last_consolidated_at).toBe(now.toISOString());
    const expectedDue = new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();
    expect(updatedMemory!.consolidation_due_at).toBe(expectedDue);
  });

  test("dismissal-only signal (no critiques) → still runs", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const eightDaysAgoIso = eightDaysAgo.toISOString();

    await writeMemory(tmpHome, buildBasememory(eightDaysAgoIso));

    // Only dismissals, no critique files
    const dismissalTs = new Date(eightDaysAgo.getTime() + 60_000).toISOString();
    writeDismissal(tmpHome, dismissalTs, "naming", "too picky");

    const result = await consolidate({
      homeBase: tmpHome,
      now: new Date(),
      deps: {
        callSummarizerBrain: async () => ({ candidates: [] }),
        // This test exercises the dismissal-only trigger signal, not the
        // entity janitor. buildBasememory's seed fact is active + untagged,
        // so without a stub the real janitor would attempt a live Brain call.
        tagEntities: async (memory) => memory,
      },
    });

    expect(result.ran).toBe(true);
  });

  test("gate not satisfied (1 day since last) → no disk write, ran: false", async () => {
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 3600 * 1000);
    await writeMemory(tmpHome, buildBasememory(oneDayAgo.toISOString()));

    // No usage-events.jsonl → stopCount=0 → gate: days=1 < 7, count=0 < 10 → not satisfied
    let summarizerCalled = false;
    const result = await consolidate({
      homeBase: tmpHome,
      now: new Date(),
      deps: {
        callSummarizerBrain: async () => {
          summarizerCalled = true;
          return { candidates: [] };
        },
        loadRecentCritiques: async () => ["critique"],
        loadRecentDismissals: async () => [],
      },
    });

    expect(result.ran).toBe(false);
    expect(summarizerCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// consolidate — chat-only signal
// ---------------------------------------------------------------------------

describe("consolidate — chat-only signal", () => {
  test("chat messages alone trigger a run (no critiques, no dismissals)", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await writeMemory(tmpHome, buildBasememory(eightDaysAgo.toISOString()));

    const dir = join(tmpHome, "chats");
    mkdirSync(dir, { recursive: true });
    const msgTs = new Date(eightDaysAgo.getTime() + 60_000).toISOString();
    writeFileSync(
      join(dir, "sess-chat.jsonl"),
      JSON.stringify({
        id: "m1", session_id: "sess-chat", role: "user",
        content: "请一直用中文跟我说话", ts: msgTs,
        model: null, tokens: null, fts_skip: false, claude_session_id: null,
      }),
      "utf8",
    );

    let sawChat = false;
    const result = await consolidate({
      homeBase: tmpHome,
      now: new Date(),
      deps: {
        callSummarizerBrain: async (ctx) => {
          sawChat = ctx.recentChat.some((s) => s.includes("用中文"));
          return { candidates: [] };
        },
        // Chat-only trigger signal test, not the entity janitor — see note
        // on the dismissal-only test above for why this stub is needed.
        tagEntities: async (memory) => memory,
      },
    });

    expect(result.ran).toBe(true);
    expect(sawChat).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bug#4-C: loadRecentCritiques excludes rubric-noise fallback bodies
// ---------------------------------------------------------------------------

describe("loadRecentCritiques — rubric-noise filtering", () => {
  test("filters rubric-flag bodies, keeps substantive critiques", async () => {
    const since = new Date("2026-04-01T00:00:00.000Z");
    const t1 = "2026-04-02T00:00:00.000Z";
    const t2 = "2026-04-03T00:00:00.000Z";

    // Rubric-noise fallback (deterministic) → must be excluded
    writeCritiqueFile(
      tmpHome,
      "c-rubric",
      t1,
      [
        "Rubric flagged concerns the model didn't surface:",
        "- god-file at src/web/screens/RepoGraph.tsx:1 — File is 681 lines (threshold: 500).",
      ].join("\n"),
    );
    // Substantive LLM prose → must be kept
    writeCritiqueFile(
      tmpHome,
      "c-real",
      t2,
      "You renamed the handler but two callsites still point at the old name.",
    );

    const { loadRecentCritiques } = await import("../../src/memory/consolidate");
    const bodies = await loadRecentCritiques(tmpHome, since);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("renamed the handler");
  });
});

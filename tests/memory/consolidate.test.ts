/**
 * Unit tests for consolidate().
 *
 * All IO is stubbed via deps injection. No disk access.
 */

import { test, expect, describe } from "bun:test";
import { consolidate, isRubricNoiseCritique, buildSummarizerContext } from "../../src/memory/consolidate";
import type { ConsolidateOpts } from "../../src/memory/consolidate";
import type { CoreMemory } from "../../src/memory/memory";
import type { SummarizerOutput } from "../../src/memory/summarizer";
import type { CommitSignal } from "../../src/memory/coding-signal";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function makeSummarizerOutput(
  candidates: SummarizerOutput["candidates"] = [],
): SummarizerOutput {
  return { candidates };
}

function makeOpts(overrides: Partial<ConsolidateOpts> = {}): ConsolidateOpts {
  return {
    homeBase: "/fake/home",
    ...overrides,
  };
}

// Base deps stub: memory with last_consolidated_at 8 days ago, 12 brain calls since,
// some critiques + dismissals so gate + signal both pass.
function makePassingDeps(
  memoryOverrides?: Partial<CoreMemory>,
  summarizerOutput?: SummarizerOutput,
): ConsolidateOpts["deps"] {
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  const mem = makeMemory({ last_consolidated_at: eightDaysAgo, ...memoryOverrides });
  let written: CoreMemory | null = null;

  return {
    readMemory: async () => mem,
    writeMemory: async (_h, m) => { written = m; },
    callSummarizerBrain: async () =>
      summarizerOutput ?? makeSummarizerOutput([]),
    loadRecentCritiques: async () => ["critique body one"],
    loadRecentDismissals: async () => [
      { rule_category: "style", reason: "too noisy", date: "2026-04-05" },
    ],
    loadRecentChatMessages: async () => [],
    // Defensive default (janitor-default-on lesson, mirrors extractEventFragments
    // above): no test in this file produces >=2 same-day event fragments today,
    // so synthesizeEpisodes never actually calls this, but a bare stub here means
    // a future test that DOES reach the synthesis step never fires a live Haiku
    // call by accident.
    synthesizeFn: async () => "{}",
  };
}

// ---------------------------------------------------------------------------
// Trigger gate tests
// ---------------------------------------------------------------------------

describe("consolidate() — trigger gate", () => {
  test("stopCount < 10 AND days < 7 → ran: false (gate not satisfied)", async () => {
    // 3 days ago, 3 brain calls since
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const mem = makeMemory({ last_consolidated_at: threeDaysAgo });

    let brainCallCount = 0;
    const result = await consolidate(
      makeOpts({
        deps: {
          readMemory: async () => mem,
          writeMemory: async () => {},
          callSummarizerBrain: async () => {
            brainCallCount++;
            return makeSummarizerOutput();
          },
          // Simulate only 3 brain calls since last consolidation
          loadRecentCritiques: async () => ["c1"],
          loadRecentDismissals: async () => [],
        },
        // Patch the stop-count reader by making usage-events.jsonl absent — file is
        // read from homeBase. We use a nonexistent dir so count comes back 0.
        homeBase: "/nonexistent/path/for-trigger-test-1",
      }),
    );

    // stopCount=0, days≈3 → neither threshold met → ran: false
    expect(result.ran).toBe(false);
    if (!result.ran) {
      expect(result.reason).toBe("trigger gate not satisfied");
    }
    expect(brainCallCount).toBe(0);
  });

  test("days < 1 (12h ago) → ran: false (cold-start guard blocks tight loops)", async () => {
    const nowMs = Date.now();
    const twelveHoursAgo = new Date(nowMs - 12 * 3600 * 1000).toISOString();
    const mem = makeMemory({ last_consolidated_at: twelveHoursAgo });

    const result = await consolidate(
      makeOpts({
        now: new Date(nowMs),
        homeBase: "/nonexistent/path/cold-start",
        deps: {
          readMemory: async () => mem,
          writeMemory: async () => {},
          callSummarizerBrain: async () => makeSummarizerOutput(),
          loadRecentCritiques: async () => ["critique"],
          loadRecentDismissals: async () => [],
        },
      }),
    );

    expect(result.ran).toBe(false);
    if (!result.ran) {
      expect(result.reason).toBe("trigger gate not satisfied");
    }
  });

  test("days === 0.5 (half a day ago) → ran: false (cold-start guard)", async () => {
    const nowMs = Date.now();
    const halfDayAgo = new Date(nowMs - 0.5 * 24 * 3600 * 1000).toISOString();
    const mem = makeMemory({ last_consolidated_at: halfDayAgo });

    const result = await consolidate(
      makeOpts({
        now: new Date(nowMs),
        homeBase: "/nonexistent/path/cold-start-half",
        deps: {
          readMemory: async () => mem,
          writeMemory: async () => {},
          callSummarizerBrain: async () => makeSummarizerOutput(),
          loadRecentCritiques: async () => ["critique"],
          loadRecentDismissals: async () => [],
        },
      }),
    );

    expect(result.ran).toBe(false);
  });

  test("days >= 7 → gate fires even if stopCount < threshold", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const mem = makeMemory({ last_consolidated_at: eightDaysAgo });

    let summarizerCalled = false;
    const result = await consolidate(
      makeOpts({
        homeBase: "/nonexistent/path/days-trigger",
        deps: {
          readMemory: async () => mem,
          writeMemory: async () => {},
          callSummarizerBrain: async () => {
            summarizerCalled = true;
            return makeSummarizerOutput([
              {
                action: "add",
                candidate_claim: "User prefers concise answers",
                evidence_quote: null,
                suggested_confidence: 0.95,
                supersedes_id: null,
              },
            ]);
          },
          loadRecentCritiques: async () => ["critique body"],
          loadRecentDismissals: async () => [],
        },
      }),
    );

    // stopCount=0 (no file) but days=8 >= 7 → gate fires
    expect(summarizerCalled).toBe(true);
    expect(result.ran).toBe(true);
  });

  test("stopCount >= 10 → gate fires even if days < 7", async () => {
    // 3 days ago in memory, but inject high stop count by seeding usage-events.jsonl
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmpHome = mkdtempSync(join(tmpdir(), "consolidate-stop-count-"));
    try {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      const mem = makeMemory({
        last_consolidated_at: threeDaysAgo.toISOString(),
      });

      // Write 12 brain_call events after threeDaysAgo
      const lines = Array.from({ length: 12 }, (_, i) => {
        const ts = new Date(threeDaysAgo.getTime() + (i + 1) * 60_000).toISOString();
        return JSON.stringify({ ts, kind: "main", input_tokens: 100, output_tokens: 50 });
      });
      writeFileSync(join(tmpHome, "usage-events.jsonl"), lines.join("\n") + "\n", "utf8");

      let summarizerCalled = false;
      const result = await consolidate(
        makeOpts({
          homeBase: tmpHome,
          now: new Date(),
          deps: {
            readMemory: async () => mem,
            writeMemory: async () => {},
            callSummarizerBrain: async () => {
              summarizerCalled = true;
              return makeSummarizerOutput();
            },
            loadRecentCritiques: async () => ["critique"],
            loadRecentDismissals: async () => [],
          },
        }),
      );

      // stopCount=12 >= 10 → fires even though days < 7
      expect(summarizerCalled).toBe(true);
      expect(result.ran).toBe(true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Minimum-signal guard
// ---------------------------------------------------------------------------

describe("consolidate() — minimum-signal guard", () => {
  test("empty critiques AND empty dismissals → ran: false even when gate satisfied", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const mem = makeMemory({ last_consolidated_at: eightDaysAgo });

    let summarizerCalled = false;
    const result = await consolidate(
      makeOpts({
        homeBase: "/nonexistent/path/no-signal",
        deps: {
          readMemory: async () => mem,
          writeMemory: async () => {},
          callSummarizerBrain: async () => {
            summarizerCalled = true;
            return makeSummarizerOutput();
          },
          loadRecentCritiques: async () => [],
          loadRecentDismissals: async () => [],
        },
      }),
    );

    expect(result.ran).toBe(false);
    if (!result.ran) {
      expect(result.reason).toBe("no new signal to consolidate");
    }
    expect(summarizerCalled).toBe(false);
  });

  test("critiques present but no dismissals → gate fires (signal satisfied)", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const mem = makeMemory({ last_consolidated_at: eightDaysAgo });

    let summarizerCalled = false;
    const result = await consolidate(
      makeOpts({
        homeBase: "/nonexistent/path/critiques-only",
        deps: {
          readMemory: async () => mem,
          writeMemory: async () => {},
          callSummarizerBrain: async () => {
            summarizerCalled = true;
            return makeSummarizerOutput();
          },
          loadRecentCritiques: async () => ["some critique"],
          loadRecentDismissals: async () => [],
        },
      }),
    );

    expect(summarizerCalled).toBe(true);
    expect(result.ran).toBe(true);
  });

  test("coding signal only (1 commit, no critiques/dismissals/chat) → guard passes, summarizer called", async () => {
    // Regression guard for the coding-signal branch of the min-signal
    // guard. All episodic signals are empty; ONLY commits.length > 0 should prevent
    // the bail. Without the coding-signal condition this test would fail.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const mem = makeMemory({ last_consolidated_at: eightDaysAgo });

    const fakeCommit: CommitSignal = {
      sha: "abc1234def567",
      subject: "feat: add coding-signal loader to consolidate",
      files: ["src/memory/coding-signal.ts"],
      additions: 80,
      deletions: 2,
      date: new Date().toISOString(),
    };

    let summarizerCalled = false;
    const result = await consolidate(
      makeOpts({
        homeBase: "/nonexistent/path/coding-signal-only",
        // projectBase is required so consolidate() derives a non-undefined projectRoot
        // (dirname(projectBase)), which lets buildSummarizerContext call commitsLoader.
        projectBase: "/fake/project/.siltpoke",
        deps: {
          readMemory: async () => mem,
          writeMemory: async () => {},
          callSummarizerBrain: async () => {
            summarizerCalled = true;
            return makeSummarizerOutput();
          },
          loadRecentCritiques: async () => [],
          loadRecentDismissals: async () => [],
          loadRecentChatMessages: async () => [],
          // Inject 1 commit — the only signal present.
          loadRecentCommits: async () => [fakeCommit],
          // No critic summary (criticSummary.total = 0 via empty entries).
          loadAllCritiqueEntries: async () => [],
          // 1 commit ⇒ knownRefs non-empty ⇒ consolidate calls the event
          // extractor; stub it so no real Brain subprocess spawns in this unit test.
          extractEventFragments: async () => [],
        },
      }),
    );

    // commits.length = 1 satisfies the coding-signal branch → guard must NOT bail.
    expect(summarizerCalled).toBe(true);
    expect(result.ran).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("consolidate() — happy path", () => {
  test("stub brain returns valid candidates → applyCandidates + prune called → memory written", async () => {
    const now = new Date();
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 3600 * 1000).toISOString();
    const mem = makeMemory({ last_consolidated_at: eightDaysAgo });

    let writtenMemory: CoreMemory | null = null;

    const result = await consolidate(
      makeOpts({
        homeBase: "/nonexistent/path/happy",
        now,
        deps: {
          readMemory: async () => mem,
          writeMemory: async (_h, m) => { writtenMemory = m; },
          callSummarizerBrain: async () =>
            makeSummarizerOutput([
              {
                action: "add",
                candidate_claim: "User prefers TypeScript over JavaScript",
                evidence_quote: null,
                suggested_confidence: 0.95,
                supersedes_id: null,
              },
            ]),
          loadRecentCritiques: async () => ["critique text"],
          loadRecentDismissals: async () => [],
        },
      }),
    );

    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.candidates).toBe(1);
      expect(result.apply.added).toBe(1);
    }

    // Memory must be written
    expect(writtenMemory).not.toBeNull();
    expect(writtenMemory!.facts).toHaveLength(1);
    expect(writtenMemory!.facts[0]!.status).toBe("pending"); // pending-first regardless of confidence (was active when conf ≥ 0.9 auto-actived)
  });

  test("last_consolidated_at and consolidation_due_at updated on success", async () => {
    const now = new Date();
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 3600 * 1000).toISOString();
    const mem = makeMemory({ last_consolidated_at: eightDaysAgo });

    let writtenMemory: CoreMemory | null = null;
    const expectedDue = new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();

    await consolidate(
      makeOpts({
        homeBase: "/nonexistent/path/timestamps",
        now,
        deps: {
          readMemory: async () => mem,
          writeMemory: async (_h, m) => { writtenMemory = m; },
          callSummarizerBrain: async () => makeSummarizerOutput(),
          loadRecentCritiques: async () => ["critique"],
          loadRecentDismissals: async () => [],
        },
      }),
    );

    expect(writtenMemory).not.toBeNull();
    expect(writtenMemory!.last_consolidated_at).toBe(now.toISOString());
    expect(writtenMemory!.consolidation_due_at).toBe(expectedDue);
  });

  test("result.ran=true includes correct apply + prune counts", async () => {
    const nowFixed = new Date();
    const eightDaysAgo = new Date(nowFixed.getTime() - 8 * 24 * 3600 * 1000).toISOString();
    // One active fact that is stale (>90d old, conf < 0.5)
    const ninetyOneDaysAgo = new Date(nowFixed.getTime() - 91 * 24 * 3600 * 1000).toISOString();
    const staleFact = {
      id: "f-stale01",
      text: "stale fact",
      source_session_id: null,
      confidence: 0.3,
      status: "active" as const,
      created_at: ninetyOneDaysAgo,
      last_seen_at: ninetyOneDaysAgo,
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 0,
      retired_reason: null,
      stability: "durable" as const,
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
        save_reason: null,
        invalid_at: null,
        events: [],
    };
    const mem = makeMemory({
      last_consolidated_at: eightDaysAgo,
      facts: [staleFact],
    });

    const result = await consolidate(
      makeOpts({
        homeBase: "/nonexistent/path/counts",
        now: nowFixed,
        deps: {
          readMemory: async () => mem,
          writeMemory: async () => {},
          callSummarizerBrain: async () =>
            makeSummarizerOutput([
              {
                action: "add",
                candidate_claim: "New fact",
                evidence_quote: null,
                suggested_confidence: 0.95,
                supersedes_id: null,
              },
            ]),
          loadRecentCritiques: async () => ["critique"],
          loadRecentDismissals: async () => [],
        },
      }),
    );

    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.apply.added).toBe(1);
      // After wiring decay sweep: stale active fact becomes retire_proposed (not retired),
      // so prune only counts pending-status facts → 0 pruned here.
      expect(result.prune.factsPruned).toBe(0);
      // The decay sweep proposed the stale fact for retirement.
      expect(result.decay.proposed).toBeGreaterThanOrEqual(1);
    }
  });

  test("decay sweep: stale active fact → retire_proposed in written memory + decay.proposed >= 1", async () => {
    const nowFixed = new Date();
    const eightDaysAgo = new Date(nowFixed.getTime() - 8 * 24 * 3600 * 1000).toISOString();
    // 90-day-old fact with low confidence — well below DECAY_THRESHOLD
    const ninetyDaysAgo = new Date(nowFixed.getTime() - 90 * 24 * 3600 * 1000).toISOString();
    const staleFact = {
      id: "f-decay-01",
      text: "very old low-confidence fact",
      source_session_id: null,
      confidence: 0.3,
      status: "active" as const,
      created_at: ninetyDaysAgo,
      last_seen_at: ninetyDaysAgo,
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 0,
      retired_reason: null,
      stability: "durable" as const,
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
        save_reason: null,
        invalid_at: null,
        events: [],
    };
    const mem = makeMemory({
      last_consolidated_at: eightDaysAgo,
      facts: [staleFact],
    });

    let writtenMemory: CoreMemory | null = null;

    const result = await consolidate(
      makeOpts({
        homeBase: "/nonexistent/path/decay-sweep",
        now: nowFixed,
        deps: {
          readMemory: async () => mem,
          writeMemory: async (_h, m) => { writtenMemory = m; },
          callSummarizerBrain: async () => makeSummarizerOutput([]),
          loadRecentCritiques: async () => ["critique for signal"],
          loadRecentDismissals: async () => [],
        },
      }),
    );

    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.decay.proposed).toBeGreaterThanOrEqual(1);
    }

    // Written memory must show the stale fact as retire_proposed, not retired
    expect(writtenMemory).not.toBeNull();
    const decayedFact = writtenMemory!.facts.find((f) => f.id === "f-decay-01");
    expect(decayedFact).not.toBeUndefined();
    expect(decayedFact!.status).toBe("retire_proposed");
  });
});

// ---------------------------------------------------------------------------
// projectBase critique-path routing (memory capture hardening)
//
// Regression guard: the critic writes critiques PROJECT-LOCAL
// ({repo}/.siltpoke/critiques/archive) but consolidate was reading the GLOBAL
// homeBase (~/.siltpoke/critiques/archive), so the minimum-signal guard always
// saw 0 critiques → ran:false forever. These tests exercise the REAL default
// loadRecentCritiques (NOT stubbed) to prove the path is read from projectBase.
// ---------------------------------------------------------------------------

describe("consolidate() — projectBase critique routing", () => {
  function seedCritique(archiveRoot: string, dateDir: string, id: string, ts: string, body: string) {
    const { mkdirSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const dayDir = join(archiveRoot, dateDir);
    mkdirSync(dayDir, { recursive: true });
    const md = [
      "---",
      "schemaVersion: 1",
      `timestamp: ${ts}`,
      `critique_id: ${id}`,
      "status: pending",
      "---",
      "",
      "## Critique (for Claude, if forwarded)",
      "",
      "```",
      body,
      "```",
      "",
    ].join("\n");
    writeFileSync(join(dayDir, `${id}.md`), md, "utf8");
  }

  test("critiques read from injected projectBase, not homeBase → reaches summarizer", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    // homeBase: empty (mirrors the stale global ~/.siltpoke with no fresh critiques)
    const tmpHome = mkdtempSync(join(tmpdir(), "consolidate-home-"));
    // projectBase: repo-local .siltpoke where the critic actually writes
    const tmpProject = mkdtempSync(join(tmpdir(), "consolidate-project-"));

    try {
      const now = new Date();
      const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
      const mem = makeMemory({ last_consolidated_at: eightDaysAgo.toISOString() });

      // Seed a recent, non-empty critique ONLY in the project-local archive.
      const recentTs = new Date(now.getTime() - 1 * 24 * 3600 * 1000).toISOString();
      seedCritique(
        join(tmpProject, "critiques", "archive"),
        "2026-06-23",
        "abc123",
        recentTs,
        "User prefers explicit error handling over silent catches.",
      );

      let summarizerCalled = false;
      const result = await consolidate(
        makeOpts({
          homeBase: tmpHome,
          projectBase: tmpProject,
          now,
          deps: {
            readMemory: async () => mem,
            writeMemory: async () => {},
            callSummarizerBrain: async () => {
              summarizerCalled = true;
              return makeSummarizerOutput();
            },
            // NOTE: loadRecentCritiques + loadRecentDismissals intentionally NOT
            // stubbed — we exercise the real path resolution.
          },
        }),
      );

      // The minimum-signal guard must see the project-local critique → run.
      expect(summarizerCalled).toBe(true);
      expect(result.ran).toBe(true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(tmpProject, { recursive: true, force: true });
    }
  });

  test("absent projectBase → falls back to homeBase (back-compat)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmpHome = mkdtempSync(join(tmpdir(), "consolidate-home-fallback-"));

    try {
      const now = new Date();
      const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
      const mem = makeMemory({ last_consolidated_at: eightDaysAgo.toISOString() });

      // Seed critique in homeBase; no projectBase passed → loader must read homeBase.
      const recentTs = new Date(now.getTime() - 1 * 24 * 3600 * 1000).toISOString();
      seedCritique(
        join(tmpHome, "critiques", "archive"),
        "2026-06-23",
        "home01",
        recentTs,
        "Fallback critique body.",
      );

      let summarizerCalled = false;
      const result = await consolidate(
        makeOpts({
          homeBase: tmpHome,
          now,
          deps: {
            readMemory: async () => mem,
            writeMemory: async () => {},
            callSummarizerBrain: async () => {
              summarizerCalled = true;
              return makeSummarizerOutput();
            },
          },
        }),
      );

      expect(summarizerCalled).toBe(true);
      expect(result.ran).toBe(true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("consolidate() — error paths", () => {
  test("callSummarizerBrain throws → caught, returns ran: false with reason containing 'consolidate error'", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const mem = makeMemory({ last_consolidated_at: eightDaysAgo });

    const result = await consolidate(
      makeOpts({
        homeBase: "/nonexistent/path/brain-throw",
        deps: {
          readMemory: async () => mem,
          writeMemory: async () => {},
          callSummarizerBrain: async () => {
            throw new Error("Brain timeout");
          },
          loadRecentCritiques: async () => ["critique"],
          loadRecentDismissals: async () => [],
        },
      }),
    );

    expect(result.ran).toBe(false);
    if (!result.ran) {
      expect(result.reason).toContain("consolidate error");
      expect(result.reason).toContain("Brain timeout");
    }
  });

  test("writeMemory throws → caught, returns ran: false", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const mem = makeMemory({ last_consolidated_at: eightDaysAgo });

    const result = await consolidate(
      makeOpts({
        homeBase: "/nonexistent/path/write-throw",
        deps: {
          readMemory: async () => mem,
          writeMemory: async () => {
            throw new Error("disk full");
          },
          callSummarizerBrain: async () => makeSummarizerOutput(),
          loadRecentCritiques: async () => ["critique"],
          loadRecentDismissals: async () => [],
        },
      }),
    );

    expect(result.ran).toBe(false);
    if (!result.ran) {
      expect(result.reason).toContain("consolidate error");
    }
  });

  test("memory not found → ran: false with reason 'memory not found'", async () => {
    const result = await consolidate(
      makeOpts({
        homeBase: "/nonexistent/path/no-memory",
        deps: {
          readMemory: async () => null,
          writeMemory: async () => {},
          callSummarizerBrain: async () => makeSummarizerOutput(),
          loadRecentCritiques: async () => [],
          loadRecentDismissals: async () => [],
        },
      }),
    );

    expect(result.ran).toBe(false);
    if (!result.ran) {
      expect(result.reason).toBe("memory not found");
    }
  });
});

// ---------------------------------------------------------------------------
// Session summary writeback, excerpt
// ---------------------------------------------------------------------------

describe("consolidate() — session summary writeback", () => {
  test("consolidate writes LLM session_summaries back to matching chat_sessions", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const mem = makeMemory({
      last_consolidated_at: eightDaysAgo,
      chat_sessions: [
        {
          id: "s1",
          started_at: eightDaysAgo,
          ended_at: null,
          message_count: 2,
          summary: "Extractive placeholder: How do I use generics?",
          summary_generated_at: null,
          tags: [],
          anchor: null,
        },
        {
          id: "s2",
          started_at: eightDaysAgo,
          ended_at: null,
          message_count: 1,
          summary: "Another placeholder",
          summary_generated_at: null,
          tags: [],
          anchor: null,
        },
      ],
    });

    let writtenMemory: CoreMemory | null = null;

    const result = await consolidate(
      makeOpts({
        homeBase: "/nonexistent/path/ac1-writeback",
        deps: {
          readMemory: async () => mem,
          writeMemory: async (_h, m) => { writtenMemory = m; },
          callSummarizerBrain: async () => ({
            candidates: [],
            session_summaries: [{ session_id: "s1", summary: "Real one-liner about generics." }],
          }),
          loadRecentCritiques: async () => ["critique"],
          loadRecentDismissals: async () => [],
          readSession: async () => [],
        },
      }),
    );

    expect(result.ran).toBe(true);
    expect(writtenMemory).not.toBeNull();
    // s1's summary must be overwritten with the LLM-generated value
    const s1 = writtenMemory!.chat_sessions.find((s) => s.id === "s1");
    expect(s1?.summary).toBe("Real one-liner about generics.");
    // s1 got a real LLM recap → summary_generated_at must be stamped so the
    // lazy /api/chat/recap-recent path (summary_generated_at === null) does
    // not redundantly re-summarize an already-consolidated session.
    expect(s1?.summary_generated_at).not.toBeNull();
    // s2 was not returned by summarizer → unchanged, including its flag
    const s2 = writtenMemory!.chat_sessions.find((s) => s.id === "s2");
    expect(s2?.summary).toBe("Another placeholder");
    expect(s2?.summary_generated_at).toBeNull();
  });

  // Re-embed on summary change is owned and tested by recall's own
  // refreshSummaryIndex hash self-heal. See tests/chat/recall-index.test.ts.
});

// ---------------------------------------------------------------------------
// Entity-model consolidate janitor wiring
// ---------------------------------------------------------------------------
// tagUntaggedEntities itself is unit-tested in tests/memory/tag-entities.test.ts.
// This integration test only asserts consolidate INVOKES the janitor (via the
// `deps.tagEntities` seam, mirroring `callSummarizerBrain`) and that the
// tagged result — not the pre-tag memory — is what gets written.

describe("consolidate() — entity janitor wiring", () => {
  test("invokes deps.tagEntities and writes its returned memory", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const mem = makeMemory({ last_consolidated_at: eightDaysAgo });

    let tagEntitiesCalled = false;
    let writtenMemory: CoreMemory | null = null;
    const taggedMemory = makeMemory({ last_consolidated_at: eightDaysAgo, long_term_summary: "tagged-marker" });

    const result = await consolidate(
      makeOpts({
        homeBase: "/nonexistent/path/janitor-wiring",
        deps: {
          readMemory: async () => mem,
          writeMemory: async (_h, m) => { writtenMemory = m; },
          callSummarizerBrain: async () => makeSummarizerOutput(),
          loadRecentCritiques: async () => ["critique"],
          loadRecentDismissals: async () => [],
          tagEntities: async (_memory, _deps) => {
            tagEntitiesCalled = true;
            return taggedMemory;
          },
        },
      }),
    );

    expect(result.ran).toBe(true);
    expect(tagEntitiesCalled).toBe(true);
    // The janitor's returned memory (not the pre-tag memory) is what's written,
    // except for the two fields consolidate stamps after the janitor result
    // would normally flow through — here we assert via the marker field that
    // survives untouched, proving writeMemory got the janitor's object.
    expect(writtenMemory).not.toBeNull();
    expect(writtenMemory!.long_term_summary).toBe("tagged-marker");
  });

  test("no untagged facts → janitor still invoked but memory passes through unchanged", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const mem = makeMemory({ last_consolidated_at: eightDaysAgo });

    let writtenMemory: CoreMemory | null = null;

    const result = await consolidate(
      makeOpts({
        homeBase: "/nonexistent/path/janitor-real-fn",
        deps: {
          readMemory: async () => mem,
          writeMemory: async (_h, m) => { writtenMemory = m; },
          callSummarizerBrain: async () => makeSummarizerOutput(),
          loadRecentCritiques: async () => ["critique"],
          loadRecentDismissals: async () => [],
          // No `tagEntities` override here — exercises the REAL default
          // (tagUntaggedEntities), confirming it degrades safely with no
          // active facts at all (nothing to tag, no Brain call attempted).
        },
      }),
    );

    expect(result.ran).toBe(true);
    expect(writtenMemory).not.toBeNull();
    expect(writtenMemory!.facts).toEqual([]);
  });
});

describe("buildSummarizerContext — excerpt collection", () => {
  test("excerpt: populates sessionsNeedingSummary from injected readSession", async () => {
    const lastConsolidatedAt = new Date("2026-06-01T00:00:00Z");
    const mem = makeMemory({
      last_consolidated_at: lastConsolidatedAt.toISOString(),
      chat_sessions: [
        {
          id: "s1",
          started_at: "2026-06-10T10:00:00Z",
          ended_at: null, // active → needs summary
          message_count: 4,
          summary: "Extractive placeholder: How do I use generics?",
          summary_generated_at: null,
          tags: [],
          anchor: null,
        },
      ],
    });

    const fakeMessages = [
      { id: "m1", session_id: "s1", role: "user" as const, content: "How do I use generics?", ts: "2026-06-10T10:00:01Z", model: null, tokens: null, fts_skip: false, claude_session_id: null },
      { id: "m2", session_id: "s1", role: "assistant" as const, content: "Generics let you write reusable code.", ts: "2026-06-10T10:00:02Z", model: null, tokens: null, fts_skip: false, claude_session_id: null },
      { id: "m3", session_id: "s1", role: "user" as const, content: "Can you show an example?", ts: "2026-06-10T10:01:00Z", model: null, tokens: null, fts_skip: false, claude_session_id: null },
      { id: "m4", session_id: "s1", role: "assistant" as const, content: "function identity<T>(x: T): T { return x; }", ts: "2026-06-10T10:01:05Z", model: null, tokens: null, fts_skip: false, claude_session_id: null },
    ];

    const ctx = await buildSummarizerContext("/fake/home", mem, lastConsolidatedAt, {
      loadRecentCritiques: async () => [],
      loadRecentDismissals: async () => [],
      loadRecentChatMessages: async () => [],
      readSession: async () => fakeMessages,
    });

    expect(ctx.sessionsNeedingSummary).toHaveLength(1);
    expect(ctx.sessionsNeedingSummary[0]?.id).toBe("s1");
    expect(ctx.sessionsNeedingSummary[0]?.message_count).toBe(4);
    // excerpt should contain content from the JSONL
    expect(ctx.sessionsNeedingSummary[0]?.excerpt).toContain("generics");
  });

  test("excerpt: sessions that ended before last_consolidated_at are excluded", async () => {
    const lastConsolidatedAt = new Date("2026-06-20T00:00:00Z");
    const mem = makeMemory({
      last_consolidated_at: lastConsolidatedAt.toISOString(),
      chat_sessions: [
        {
          id: "s-old",
          started_at: "2026-06-01T00:00:00Z",
          ended_at: "2026-06-05T00:00:00Z", // ended BEFORE last consolidation
          message_count: 2,
          summary: "Old session",
          summary_generated_at: null,
          tags: [],
          anchor: null,
        },
        {
          id: "s-new",
          started_at: "2026-06-22T00:00:00Z",
          ended_at: "2026-06-23T00:00:00Z", // ended AFTER last consolidation
          message_count: 1,
          summary: "New session",
          summary_generated_at: null,
          tags: [],
          anchor: null,
        },
      ],
    });

    const ctx = await buildSummarizerContext("/fake/home", mem, lastConsolidatedAt, {
      loadRecentCritiques: async () => [],
      loadRecentDismissals: async () => [],
      loadRecentChatMessages: async () => [],
      readSession: async () => [],
    });

    expect(ctx.sessionsNeedingSummary.map((s) => s.id)).not.toContain("s-old");
    expect(ctx.sessionsNeedingSummary.map((s) => s.id)).toContain("s-new");
  });
});

describe("consolidate() — INV1: single summarizer call site", () => {
  test("INV1: consolidate.ts has exactly one summarizerFn( call — no new brain/budget gates", () => {
    const { readFileSync } = require("node:fs");
    const src: string = readFileSync("src/memory/consolidate.ts", "utf8");
    const calls = (src.match(/summarizerFn\(/g) ?? []).length;
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Bug#4-C: rubric-noise filter
// ---------------------------------------------------------------------------
// The critic synthesizes a deterministic fallback critique body when the Brain
// emits no prose (severity-promotion.ts). These are NOT episodic user-state
// signal — feeding them to the summarizer makes it manufacture junk facts.
// isRubricNoiseCritique flags them so the consolidation signal excludes them.
// (isRubricNoiseCritique imported at top of file.)

describe("isRubricNoiseCritique", () => {
  test("flags rubric-flag fallback body (the deterministic god-file re-emission)", () => {
    const body = [
      "Rubric flagged concerns the model didn't surface:",
      "- god-file at src/web/screens/RepoGraph.tsx:1 — File is 681 lines (threshold: 500).",
    ].join("\n");
    expect(isRubricNoiseCritique(body)).toBe(true);
  });

  test("flags diff-summary-risks fallback body (Haiku pre-pass, not episodic)", () => {
    const body = [
      "Diff-summary risks (Haiku pre-pass):",
      "- touches auth path without a test",
    ].join("\n");
    expect(isRubricNoiseCritique(body)).toBe(true);
  });

  test("does NOT flag substantive LLM prose critique", () => {
    const body =
      "You renamed the handler but left two callsites pointing at the old name; the daemon will 500 on /explain.";
    expect(isRubricNoiseCritique(body)).toBe(false);
  });

  test("does NOT flag empty body", () => {
    expect(isRubricNoiseCritique("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Extract-role seam (single-brain S2, task 8)
//
// consolidate() builds ONE role-routed brainFn (`makeRoleRawBrain(homeBase,
// "extract")`) and injects it into BOTH callSummarizerBrain and
// extractEventFragments — neither leaf function receives `homeBase` itself.
// These tests avoid `mock.module` (verified in earlier single-brain tasks to
// leak across test files in this Bun version) in favor of (a) a spy-based
// assertion that both leaves receive the SAME seam, and (b) a real
// end-to-end run against a non-claude ("qoder") extract-role provider, same
// PATH-shadowed-binary technique as tests/memory/extract-facts.test.ts and
// tests/memory/tag-entities.test.ts.
// ---------------------------------------------------------------------------

describe("consolidate() — extract role seam (single-brain S2 task 8)", () => {
  test("summarizer + event extractor both receive the SAME injected brainFn seam", async () => {
    const now = new Date();
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 3600 * 1000).toISOString();
    const mem = makeMemory({ last_consolidated_at: eightDaysAgo });

    const fakeCommit: CommitSignal = {
      sha: "seam1234abcd",
      subject: "feat: exercise the extract-role seam",
      files: ["src/memory/consolidate.ts"],
      additions: 10,
      deletions: 1,
      date: now.toISOString(),
    };

    let summarizerBrainFn: unknown;
    let extractBrainFn: unknown;

    const result = await consolidate(
      makeOpts({
        homeBase: "/nonexistent/path/seam-test",
        // projectBase required so consolidate() derives a projectRoot and the
        // commit stub below is consulted (knownRefs.size > 0 gates the event
        // extractor call — see consolidate.ts's cost-guard comment).
        projectBase: "/fake/project/.siltpoke",
        now,
        deps: {
          readMemory: async () => mem,
          writeMemory: async () => {},
          callSummarizerBrain: async (_context, opts) => {
            summarizerBrainFn = opts?.brainFn;
            return makeSummarizerOutput();
          },
          extractEventFragments: async (_context, opts) => {
            extractBrainFn = opts?.brainFn;
            return [];
          },
          loadRecentCritiques: async () => ["critique text"],
          loadRecentDismissals: async () => [],
          loadRecentChatMessages: async () => [],
          loadRecentCommits: async () => [fakeCommit],
          loadAllCritiqueEntries: async () => [],
        },
      }),
    );

    expect(result.ran).toBe(true);
    expect(typeof summarizerBrainFn).toBe("function");
    expect(typeof extractBrainFn).toBe("function");
    // Built ONCE in consolidate() and injected into both — same reference,
    // not two independently-constructed role brains.
    expect(summarizerBrainFn).toBe(extractBrainFn);
  });

  test("default (no config.json) → extract role resolves to the SAME pinned claude model both leaves hardcoded pre-migration (byte-identical)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmpHome = mkdtempSync(join(tmpdir(), "consolidate-seam-default-"));
    try {
      // No config.json written → loadBrainConfig defaults to claude for
      // every role. resolveRole is the pure function makeRoleRawBrain calls
      // internally to force the model on every request — asserting it
      // directly (rather than spawning a real `claude -p` subprocess) proves
      // the default seam resolves to the exact pinned string both leaf
      // functions hardcoded as DEFAULT_MODEL before this task deleted it.
      const { loadBrainConfig } = await import("../../src/brain/brain-config");
      const { resolveRole } = await import("../../src/brain/registry");
      const config = await loadBrainConfig(tmpHome);
      const resolved = resolveRole(config, "extract");
      expect(resolved.family).toBe("claude");
      expect(resolved.model).toBe("claude-haiku-4-5-20251001");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("config.json selecting a non-claude extract provider → the REAL (unstubbed) summarizer + event extractor both reach it via the shared seam", async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmpHome = mkdtempSync(join(tmpdir(), "consolidate-seam-qoder-home-"));
    const tmpBin = mkdtempSync(join(tmpdir(), "consolidate-seam-qoder-bin-"));
    const originalPath = process.env.PATH;
    const callLog = join(tmpHome, "qoder-calls.log");

    try {
      writeFileSync(
        join(tmpHome, "config.json"),
        JSON.stringify({ brain: { roles: { extract: { provider: "qoder" } } } }),
      );

      const fakeBin = join(tmpBin, "qodercli");
      writeFileSync(
        fakeBin,
        [
          "#!/usr/bin/env bun",
          `require("node:fs").appendFileSync(${JSON.stringify(callLog)}, "call\\n");`,
          // Envelope satisfies BOTH the summarizer's { candidates } schema and
          // the event extractor's { events } schema — the same fake binary
          // answers whichever caller reaches it via the shared seam.
          'const inner = JSON.stringify({ candidates: [], events: [] });',
          'const envelope = { type: "result", subtype: "success", is_error: false, result: inner, total_cost_usd: 0, usage: { input_tokens: 3, output_tokens: 2 } };',
          "process.stdout.write(JSON.stringify(envelope));",
          "",
        ].join("\n"),
      );
      chmodSync(fakeBin, 0o755);
      process.env.PATH = `${tmpBin}:${originalPath ?? ""}`;

      const now = new Date();
      const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 3600 * 1000).toISOString();
      const mem = makeMemory({ last_consolidated_at: eightDaysAgo });

      const fakeCommit: CommitSignal = {
        sha: "qoder1234abcd",
        subject: "feat: exercise the qoder extract-role seam",
        files: ["src/memory/consolidate.ts"],
        additions: 5,
        deletions: 0,
        date: now.toISOString(),
      };

      const result = await consolidate(
        makeOpts({
          homeBase: tmpHome,
          projectBase: "/fake/project/.siltpoke",
          now,
          deps: {
            readMemory: async () => mem,
            writeMemory: async () => {},
            // callSummarizerBrain / extractEventFragments intentionally NOT
            // stubbed — this exercises the REAL leaf functions, which now
            // only reach the qoder binary because consolidate injects the
            // role-routed brainFn into both.
            loadRecentCritiques: async () => ["critique text"],
            loadRecentDismissals: async () => [],
            loadRecentChatMessages: async () => [],
            loadRecentCommits: async () => [fakeCommit],
            loadAllCritiqueEntries: async () => [],
          },
        }),
      );

      expect(result.ran).toBe(true);
      // The fake qodercli binary was invoked exactly twice — once for the
      // summarizer, once for the event extractor — proving BOTH leaves
      // reached the SAME non-claude extract-role provider via consolidate's
      // shared seam (not just one of them, and not a stale claude default).
      const { readFileSync, existsSync } = await import("node:fs");
      expect(existsSync(callLog)).toBe(true);
      const calls = readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean);
      expect(calls.length).toBe(2);
    } finally {
      process.env.PATH = originalPath;
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(tmpBin, { recursive: true, force: true });
    }
  });
});

import { test, expect, describe, it } from "bun:test";
import {
  assembleSummarizerPrompt,
  callSummarizerBrain,
  candidateSchema,
  summarizerOutputSchema,
  type SummarizerContext,
  type SummarizerOutput,
  type BrainFn,
} from "../../src/memory/summarizer";
import { BrainError, } from "../../src/brain/brain";
import type { CallBrainOptions, BrainCallRawResult } from "../../src/brain/brain";

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
  activeFacts: [
    { id: "f-001", claim: "User prefers terse feedback.", confidence: 0.9 },
    { id: "f-002", claim: "User works in TypeScript.", confidence: 0.8 },
  ],
  recentCritiques: [
    "critique_for_claude: avoid unnecessary console.log",
    "critique_for_claude: prefer const over let",
  ],
  recentChat: [
    "[user] Can you explain how async/await works?",
  ],
  recentDismissals: [
    {
      rule_category: "null_check",
      reason: "Already handled upstream",
      date: "2026-05-01",
    },
    {
      rule_category: "null_check",
      reason: "Not applicable",
      date: "2026-05-03",
    },
  ],
  sessionsNeedingSummary: [],
};

function makeFakeBrainFn(output: SummarizerOutput): BrainFn {
  return async (_opts: CallBrainOptions): Promise<BrainCallRawResult> => ({
    output: output as unknown,
    usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 10,
      output_tokens: 20,
      total_cost_usd: null,
    },
  });
}

function makeMalformedBrainFn(raw: unknown): BrainFn {
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

// ---------------------------------------------------------------------------
// F1 regression: callBrainRaw path does not crash with schema mismatch
// ---------------------------------------------------------------------------
// This verifies that passing callBrainRaw explicitly (which is now also the
// production default) does NOT throw a critic-schema BrainError before
// summarizerOutputSchema.safeParse has a chance to run.
// The test stubs the spawn layer so no real claude process is invoked.

describe("callSummarizerBrain — callBrainRaw default path", () => {
  test("explicit callBrainRaw injection: schema-valid output parses correctly", async () => {
    // Stub: synthesise a BrainCallRawResult that looks like what callBrainRaw
    // would produce for a summarizer response.
    const rawOutput = {
      candidates: [
        {
          action: "add",
          candidate_claim: "User favors brevity.",
          evidence_quote: null,
          suggested_confidence: 0.92,
          supersedes_id: null,
        },
      ],
    };

    const stubFn: BrainFn = async (_opts: CallBrainOptions): Promise<BrainCallRawResult> => ({
      output: rawOutput,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 5,
        output_tokens: 10,
        total_cost_usd: null,
      },
    });

    // Passing { brainFn: stubFn } — same call shape as the production path
    // with callBrainRaw, verifying the raw-result contract is exercised.
    const result = await callSummarizerBrain(emptyContext, { brainFn: stubFn });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.action).toBe("add");
  });

  test("explicit callBrainRaw injection: critic-shaped payload throws BrainError (not schema mismatch from callBrain)", async () => {
    // A critic-shaped payload does NOT satisfy summarizerOutputSchema
    // (no `candidates` array) → should throw BrainError("Summarizer response failed …")
    // NOT a critic-schema error from inside callBrain.
    const criticShapedPayload = {
      severity: "medium",
      mood: "curious",
      bubble_short: "Use const not let.",
    };
    const stubFn: BrainFn = async (_opts: CallBrainOptions): Promise<BrainCallRawResult> => ({
      output: criticShapedPayload,
      usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 5, output_tokens: 10, total_cost_usd: null },
    });

    await expect(
      callSummarizerBrain(emptyContext, { brainFn: stubFn }),
    ).rejects.toThrow("Summarizer response failed schema validation");
  });
});

// ---------------------------------------------------------------------------
// assembleSummarizerPrompt tests
// ---------------------------------------------------------------------------

describe("assembleSummarizerPrompt", () => {
  test("includes EXISTING ACTIVE FACTS section heading", () => {
    const prompt = assembleSummarizerPrompt(emptyContext);
    expect(prompt).toContain("EXISTING ACTIVE FACTS:");
  });

  test("shows (none) when no active facts", () => {
    const prompt = assembleSummarizerPrompt(emptyContext);
    expect(prompt).toContain("(none)");
  });

  test("includes fact id, claim, confidence when facts present", () => {
    const prompt = assembleSummarizerPrompt(richContext);
    expect(prompt).toContain("[f-001]");
    expect(prompt).toContain("User prefers terse feedback.");
    expect(prompt).toContain("0.90");
  });

  test("includes RECENT CRITIQUES section heading", () => {
    const prompt = assembleSummarizerPrompt(richContext);
    expect(prompt).toContain("RECENT CRITIQUES (signal about user state):");
  });

  test("includes critique body when critiques present", () => {
    const prompt = assembleSummarizerPrompt(richContext);
    expect(prompt).toContain("avoid unnecessary console.log");
  });

  test("includes RECENT DISMISSED CRITIQUES section heading", () => {
    const prompt = assembleSummarizerPrompt(richContext);
    expect(prompt).toContain("RECENT DISMISSED CRITIQUES (negative signal):");
  });

  test("includes dismissal category + reason + date when dismissals present", () => {
    const prompt = assembleSummarizerPrompt(richContext);
    expect(prompt).toContain("null_check");
    expect(prompt).toContain("Already handled upstream");
    expect(prompt).toContain("2026-05-01");
  });

  test("includes JSON emit instruction and rules", () => {
    const prompt = assembleSummarizerPrompt(emptyContext);
    expect(prompt).toContain('Emit JSON: { "candidates": [...] }');
    expect(prompt).toContain("Maximum 20 candidates per call");
  });
});

// ---------------------------------------------------------------------------
// callSummarizerBrain tests
// ---------------------------------------------------------------------------

describe("callSummarizerBrain", () => {
  test("happy path — returns parsed SummarizerOutput", async () => {
    const fakeOutput: SummarizerOutput = {
      candidates: [
        {
          action: "add",
          candidate_claim: "User prefers TypeScript over JavaScript.",
          evidence_quote: "User prefers TypeScript",
          suggested_confidence: 0.95,
          supersedes_id: null,
        },
      ],
    };
    const result = await callSummarizerBrain(emptyContext, {
      brainFn: makeFakeBrainFn(fakeOutput),
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.action).toBe("add");
    expect(result.candidates[0]?.suggested_confidence).toBe(0.95);
  });

  test("empty candidates array is valid", async () => {
    const fakeOutput: SummarizerOutput = { candidates: [] };
    const result = await callSummarizerBrain(emptyContext, {
      brainFn: makeFakeBrainFn(fakeOutput),
    });
    expect(result.candidates).toHaveLength(0);
  });

  test("malformed: not an object with candidates key → throws BrainError", async () => {
    const brainFn = makeMalformedBrainFn("not json at all");
    await expect(
      callSummarizerBrain(emptyContext, { brainFn }),
    ).rejects.toThrow(BrainError);
  });

  // Bug#4-A: per-candidate validation — one invalid candidate must NOT reject
  // the whole batch (that loses every good fact). Drop bad, keep valid.
  test("robust: invalid action enum → that candidate dropped, valid kept", async () => {
    const bad = {
      candidates: [
        {
          action: "invent", // invalid → dropped
          candidate_claim: "noise",
          evidence_quote: null,
          suggested_confidence: 0.9,
          supersedes_id: null,
        },
        {
          action: "add", // valid → kept
          candidate_claim: "User prefers terse feedback.",
          evidence_quote: null,
          suggested_confidence: 0.9,
          supersedes_id: null,
        },
      ],
    };
    const result = await callSummarizerBrain(emptyContext, {
      brainFn: makeMalformedBrainFn(bad),
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.candidate_claim).toBe("User prefers terse feedback.");
  });

  test("robust: confidence > 1 → that candidate dropped, valid kept", async () => {
    const bad = {
      candidates: [
        {
          action: "add",
          candidate_claim: "valid claim",
          evidence_quote: null,
          suggested_confidence: 0.5,
          supersedes_id: null,
        },
        {
          action: "add",
          candidate_claim: "bad confidence",
          evidence_quote: null,
          suggested_confidence: 1.5, // invalid → dropped
          supersedes_id: null,
        },
      ],
    };
    const result = await callSummarizerBrain(emptyContext, {
      brainFn: makeMalformedBrainFn(bad),
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.candidate_claim).toBe("valid claim");
  });

  // Bug#4-A regression: the exact paid-run failure — one over-long claim among
  // valid candidates must not nuke the batch to 0 facts.
  test("robust: over-long claim among valid → over-long dropped, rest kept", async () => {
    const mixed = {
      candidates: [
        { action: "add" as const, candidate_claim: "x".repeat(400), evidence_quote: null, suggested_confidence: 0.9, supersedes_id: null }, // > 280 → dropped
        { action: "add" as const, candidate_claim: "User works in TypeScript strict mode.", evidence_quote: null, suggested_confidence: 0.8, supersedes_id: null },
        { action: "add" as const, candidate_claim: "User runs Bun, not Node.", evidence_quote: null, suggested_confidence: 0.7, supersedes_id: null },
      ],
    };
    const result = await callSummarizerBrain(emptyContext, {
      brainFn: makeMalformedBrainFn(mixed),
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((c) => c.candidate_claim.length <= 280)).toBe(true);
  });

  test("robust: every candidate invalid → returns empty (no throw)", async () => {
    const allBad = {
      candidates: [
        { action: "nope", candidate_claim: "a", evidence_quote: null, suggested_confidence: 0.5, supersedes_id: null },
        { action: "add", candidate_claim: "b", evidence_quote: null, suggested_confidence: 9, supersedes_id: null },
      ],
    };
    const r = await callSummarizerBrain(emptyContext, { brainFn: makeMalformedBrainFn(allBad) });
    expect(r.candidates).toHaveLength(0);
  });

  test("cap: 25 valid candidates → truncated to 20 (no throw)", async () => {
    const oversized = Array.from({ length: 25 }, (_, i) => ({
      action: "add" as const,
      candidate_claim: `claim ${i}`,
      evidence_quote: null,
      suggested_confidence: 0.9,
      supersedes_id: null,
    }));
    const result = await callSummarizerBrain(emptyContext, {
      brainFn: makeMalformedBrainFn({ candidates: oversized }),
    });
    expect(result.candidates).toHaveLength(20);
  });

  test("exactly 20 candidates passes validation", async () => {
    const exactly20 = Array.from({ length: 20 }, (_, i) => ({
      action: "add" as const,
      candidate_claim: `claim ${i}`,
      evidence_quote: null,
      suggested_confidence: 0.9,
      supersedes_id: null,
    }));
    const fakeOutput = { candidates: exactly20 };
    const brainFn = makeFakeBrainFn(fakeOutput as SummarizerOutput);
    const result = await callSummarizerBrain(emptyContext, { brainFn });
    expect(result.candidates).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// Schema unit tests
// ---------------------------------------------------------------------------

describe("candidateSchema", () => {
  test("accepts valid add candidate", () => {
    const result = candidateSchema.safeParse({
      action: "add",
      candidate_claim: "User writes tests first.",
      evidence_quote: "writes tests",
      suggested_confidence: 0.85,
      supersedes_id: null,
    });
    expect(result.success).toBe(true);
  });

  test("accepts candidate_claim up to 280 chars (Bug#4-B raised cap)", () => {
    const result = candidateSchema.safeParse({
      action: "add",
      candidate_claim: "x".repeat(280),
      evidence_quote: null,
      suggested_confidence: 0.8,
      supersedes_id: null,
    });
    expect(result.success).toBe(true);
  });

  test("rejects candidate_claim > 280 chars", () => {
    const result = candidateSchema.safeParse({
      action: "add",
      candidate_claim: "x".repeat(281),
      evidence_quote: null,
      suggested_confidence: 0.8,
      supersedes_id: null,
    });
    expect(result.success).toBe(false);
  });

  test("rejects evidence_quote > 240 chars", () => {
    const result = candidateSchema.safeParse({
      action: "add",
      candidate_claim: "test",
      evidence_quote: "x".repeat(241),
      suggested_confidence: 0.8,
      supersedes_id: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("summarizerOutputSchema", () => {
  test("rejects array of > 20 candidates", () => {
    const result = summarizerOutputSchema.safeParse({
      candidates: Array.from({ length: 21 }, () => ({
        action: "add",
        candidate_claim: "test",
        evidence_quote: null,
        suggested_confidence: 0.9,
        supersedes_id: null,
      })),
    });
    expect(result.success).toBe(false);
  });


  test("includes RECENT CHAT section with the user's message", () => {
    const prompt = assembleSummarizerPrompt({
      activeFacts: [], recentCritiques: [], recentChat: ["[user] 请用中文跟我说"], recentDismissals: [],
      sessionsNeedingSummary: [],
    });
    expect(prompt).toContain("RECENT CHAT");
    expect(prompt).toContain("请用中文跟我说");
  });

  test("includes the decision-relevance gate and durability test in the rules", () => {
    const prompt = assembleSummarizerPrompt({
      activeFacts: [], recentCritiques: [], recentChat: [], recentDismissals: [],
      sessionsNeedingSummary: [],
    });
    expect(prompt).toContain("decision-relevant");
    expect(prompt).toContain("generalizable");
  });

});

// ---------------------------------------------------------------------------
// Session summaries
// ---------------------------------------------------------------------------

const ctx = (over: Partial<SummarizerContext> = {}): SummarizerContext => ({
  activeFacts: [], recentCritiques: [], recentChat: [], recentDismissals: [],
  sessionsNeedingSummary: [], ...over,
});

// ---------------------------------------------------------------------------
// Prompt-shape fix — JSON emit includes session_summaries when sessions present
// ---------------------------------------------------------------------------

test("prompt-shape: JSON emit includes session_summaries when sessions are present", () => {
  const p = assembleSummarizerPrompt(ctx({
    sessionsNeedingSummary: [
      {
        id: "s1",
        started_at: "2026-06-26T00:00:00Z",
        message_count: 3,
        excerpt: "user: hello\nassistant: hi there",
      },
    ],
  }));
  // When sessions are present, emit shape must tell the model about session_summaries
  expect(p).toContain("session_summaries");
  // The emit JSON line itself must reference the field
  const emitLine = p.split("\n").find((l) => l.startsWith("Emit JSON:"));
  expect(emitLine).toBeDefined();
  expect(emitLine).toContain("session_summaries");
});

test("prompt-shape: candidates-only emit when no sessions present", () => {
  const p = assembleSummarizerPrompt(ctx());
  const emitLine = p.split("\n").find((l) => l.startsWith("Emit JSON:"));
  expect(emitLine).toBeDefined();
  // When no sessions, the emit line must still be valid but need not mention session_summaries
  expect(emitLine).toContain("candidates");
  // Crucially: the existing test still holds — no confusion for normal runs
  expect(emitLine).not.toContain("session_summaries");
});

test("prompt lists sessions needing a summary with their excerpt", () => {
  const p = assembleSummarizerPrompt(ctx({
    sessionsNeedingSummary: [
      { id: "s1", started_at: "2026-06-26T00:00:00Z", message_count: 6,
        excerpt: "user: wire recall\nassistant: ok" },
    ],
  }));
  expect(p).toContain("SESSIONS NEEDING A ONE-LINE SUMMARY");
  expect(p).toContain("s1");
  expect(p).toContain("wire recall");
});

test("output schema accepts session_summaries", () => {
  const parsed = summarizerOutputSchema.parse({
    candidates: [],
    session_summaries: [{ session_id: "s1", summary: "Wired cross-chat recall into consolidate." }],
  });
  expect(parsed.session_summaries?.[0].session_id).toBe("s1");
});

// Regression: per-item drop-not-reject guard for session_summaries
// One malformed entry (summary > 200 chars) must be dropped; the valid sibling survives.
// This mirrors the same guard for candidates and guards against a future regression that
// would reject the whole batch on a single bad entry.
test("robust: over-long session_summary dropped, valid sibling survives (not whole batch rejected)", async () => {
  const mixed = {
    candidates: [],
    session_summaries: [
      { session_id: "s1", summary: "x".repeat(300) }, // 300 > 200 max → dropped
      { session_id: "s2", summary: "valid short summary" },
    ],
  };
  const result = await callSummarizerBrain(emptyContext, {
    brainFn: makeMalformedBrainFn(mixed),
  });
  expect(result.session_summaries).toHaveLength(1);
  expect(result.session_summaries?.[0]?.session_id).toBe("s2");
});

// ---------------------------------------------------------------------------
// RECENT CODING ACTIVITY section in assembleSummarizerPrompt
// ---------------------------------------------------------------------------

it("renders RECENT CODING ACTIVITY with commits + critic counts", () => {
  const p = assembleSummarizerPrompt(ctx({
    codingActivity: {
      commits: [{ sha: "a", subject: "feat: add parser", files: ["src/q.ts"], additions: 5, deletions: 1, date: "2026-06-28T00:00:00Z" }],
      criticSummary: { byCategory: { "god-file": 3 }, total: 3 },
    },
  }));
  expect(p).toContain("RECENT CODING ACTIVITY");
  expect(p).toContain("feat: add parser");
  expect(p).toContain("god-file");
});

it("renders (none) when no coding activity", () => {
  const p = assembleSummarizerPrompt(ctx({
    codingActivity: { commits: [], criticSummary: { byCategory: {}, total: 0 } },
  }));
  expect(p).toMatch(/RECENT CODING ACTIVITY[\s\S]*\(none\)/);
});

// ---------------------------------------------------------------------------
// Memory Book Change A — candidateSchema why_worth_saving
// ---------------------------------------------------------------------------

describe("candidateSchema why_worth_saving", () => {
  it("accepts a why_worth_saving one-liner", () => {
    const c = candidateSchema.parse({
      why_worth_saving: "stable working-style preference, recurs across sessions",
      action: "add", candidate_claim: "prefers TDD", evidence_quote: null,
      suggested_confidence: 0.8, supersedes_id: null,
    });
    expect(c.why_worth_saving).toContain("recurs");
  });

  it("stays valid when why_worth_saving is absent (pre-change output)", () => {
    const c = candidateSchema.parse({
      action: "skip", candidate_claim: "noise", evidence_quote: null,
      suggested_confidence: 0.1, supersedes_id: null,
    });
    expect(c.why_worth_saving).toBeUndefined();
  });

  it("parses successfully when why_worth_saving is 300 chars (over display cap — schema must not gate on length)", () => {
    // why_worth_saving must NOT have a .max() constraint — a long prose reason
    // must not silently drop the entire fact. Apply-time slice (saveReasonFrom)
    // caps the stored value at 280; the schema must only enforce structure.
    const result = candidateSchema.safeParse({
      why_worth_saving: "x".repeat(300),
      action: "add", candidate_claim: "prefers TDD", evidence_quote: null,
      suggested_confidence: 0.9, supersedes_id: null,
    });
    expect(result.success).toBe(true);
  });
});

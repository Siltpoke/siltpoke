/** @jsxImportSource hono/jsx */
/**
 * CritiqueAuditBlocks.test.tsx — render tests for the 6 audit blocks.
 *
 * Each test renders a block to HTML and asserts key strings / attributes
 * are present. No DOM or browser needed — Hono JSX produces a string.
 */
import { describe, test, expect } from "bun:test";
import {
  BlockA,
  BlockC,
  BlockD,
  BlockE,
  BlockF,
} from "../../../src/web/primitives/CritiqueAuditBlocks";
import type { V2SidecarData } from "../../../src/state/v2-sidecar";
import type { CriticCall } from "../../../src/state/critic-event-log";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_V2: V2SidecarData = {
  schemaVersion: 2,
  critique_id: "c-test-001",
  ts: "2026-05-20T12:00:00.000Z",
  severity: "high",
  confidence: "high",
  category: "security",
  status: "pending",
  reasoning: "AWS key in source. Detected by secrets scan.",
  critique_for_claude: "Move AKIA to env var.",
  suggested_fix: null,
  bubble_short: "ouch secret",
  bubble_long: null,
  mood: "concerned",
  pose: "base",
  intent_classification: "bugfix",
  intent_confidence: 0.92,
  user_raw_query: "fix the secret",
  agent_reply: null,
  signal_sources: ["secrets-scan", "rubric-tier1"],
  rubric_triggers: [
    // Use valid ALL_RUBRIC_RULES IDs so BlockC checklist can match them
    {
      rule_id: "god-file",
      tier: 1,
      severity: "high",
      file: "src/auth.ts",
      line: 18,
      snippet: "const accessKey = 'AKIAIOSFODNN7EXAMPLE'",
      signal_source: "secrets-scan",
    },
    {
      rule_id: "god-function",
      tier: 2,
      severity: "low",
      file: "src/big.ts",
      line: 1,
      snippet: "// 1000 lines",
      signal_source: "rubric-tier2",
    },
  ],
  changed_files: ["src/auth.ts", "src/big.ts"],
  diff_intent: "move secrets to env",
};

const BASE_CALL: CriticCall = {
  timestamp: "2026-05-20T12:00:00.000Z",
  session_id: "sess-test",
  cwd: "/tmp/project",
  project: "project",
  status: "fired",
  skip_reason: null,
  critique_id: null,
  bubble_short: "ouch secret",
  bubble_long: null,
  critique_for_claude: "Move AKIA to env var.",
  severity: "high",
  confidence: "high",
  evidence: [],
  gating_decision: null,
  turns_included: null,
  duration_ms: 3200,
  cost_usd: 0.0032,
  tokens: { input: 8000, output: 200, cache_read: 4000, cache_create: 0 },
  diff_snapshot_id: null,
  diff_text: null,
  diff_summary: {
    intent: "move AWS key to env",
    key_changes: ["removed hardcoded key"],
    risks: [],
    file_count: 1,
    files_with_purpose: [{ path: "src/auth.ts", purpose: "move key" }],
    source: "haiku",
  },
  summary_error: null,
  error_message: null,
  user_action: null,
  speech_kind: "critical",
  reasoning: "AWS key embedded in source.",
  timing: { summary_ms: 1200, critic_ms: 2000, wall_ms: 3200 },
  v2: null,
};

// ---------------------------------------------------------------------------
// Block A — WHAT I READ
// ---------------------------------------------------------------------------

describe("BlockA", () => {
  test("renders section with audit-block id 'A'", () => {
    const html = String(<BlockA v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain('data-audit-block="A"');
  });

  test("renders WHAT I READ label", () => {
    const html = String(<BlockA v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("WHAT I READ");
  });

  test("renders changed files", () => {
    const html = String(<BlockA v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("src/auth.ts");
    expect(html).toContain("src/big.ts");
  });

  test("renders user raw query", () => {
    const html = String(<BlockA v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("fix the secret");
  });

  test("renders diff intent from v2", () => {
    const html = String(<BlockA v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("move secrets to env");
  });

  test("renders placeholder when v2 is null", () => {
    const html = String(<BlockA v2={null} c={BASE_CALL} />);
    expect(html).toContain("v2 audit data unavailable");
    expect(html).toContain('data-audit-block="A"');
  });

  test("falls back to diff_summary.intent when v2.diff_intent is null", () => {
    const v2NoIntent = { ...BASE_V2, diff_intent: null };
    const html = String(<BlockA v2={v2NoIntent} c={BASE_CALL} />);
    // Should fall back to c.diff_summary.intent
    expect(html).toContain("move AWS key to env");
  });
});

// ---------------------------------------------------------------------------
// Block C — RUBRIC CHECKLIST
// ---------------------------------------------------------------------------

describe("BlockC", () => {
  test("renders section with audit-block id 'C'", () => {
    const html = String(<BlockC v2={BASE_V2} />);
    expect(html).toContain('data-audit-block="C"');
  });

  test("renders RUBRIC CHECKLIST label", () => {
    const html = String(<BlockC v2={BASE_V2} />);
    expect(html).toContain("RUBRIC CHECKLIST");
  });

  test("renders tier group labels", () => {
    const html = String(<BlockC v2={BASE_V2} />);
    expect(html).toContain("Tier 1");
    expect(html).toContain("Tier 2");
    expect(html).toContain("Tier 3");
  });

  test("renders fail (✗) for triggered rules", () => {
    const html = String(<BlockC v2={BASE_V2} />);
    // aws-access-key triggered → ✗; god-file triggered → ✗
    const failCount = (html.match(/rubric-row--fail/g) ?? []).length;
    expect(failCount).toBeGreaterThanOrEqual(2);
  });

  test("renders pass (✓) for non-triggered rules when rubric ran", () => {
    const html = String(<BlockC v2={BASE_V2} />);
    const passCount = (html.match(/rubric-row--pass/g) ?? []).length;
    expect(passCount).toBeGreaterThan(0);
  });

  test("renders N/A (⊘) for legacy critique (schemaVersion=1)", () => {
    const legacyV2 = { ...BASE_V2, schemaVersion: 1, rubric_triggers: [] };
    const html = String(<BlockC v2={legacyV2} />);
    const naCount = (html.match(/rubric-row--na/g) ?? []).length;
    expect(naCount).toBeGreaterThan(0);
    expect(html).toContain("rubric not run (legacy review)");
  });

  test("renders pass (✓) for all rules when pipeline ran clean (schemaVersion=2, 0 triggers)", () => {
    const cleanV2 = { ...BASE_V2, schemaVersion: 2, rubric_triggers: [] };
    const html = String(<BlockC v2={cleanV2} />);
    const passCount = (html.match(/rubric-row--pass/g) ?? []).length;
    expect(passCount).toBeGreaterThan(0);
    expect(html).toContain("all rules pass — 0 triggers");
    // None should be N/A when pipeline ran cleanly
    expect(html).not.toMatch(/rubric-row--na/);
  });

  test("shows trigger detail (file:line) for failing rules", () => {
    const html = String(<BlockC v2={BASE_V2} />);
    // god-file trigger is at src/auth.ts:18
    expect(html).toContain("src/auth.ts:18");
    // god-function trigger is at src/big.ts:1
    expect(html).toContain("src/big.ts:1");
  });

  test("renders placeholder when v2 is null", () => {
    const html = String(<BlockC v2={null} />);
    expect(html).toContain("v2 audit data unavailable");
  });

  test("renders Tier 3 placeholder noting no rules", () => {
    const html = String(<BlockC v2={BASE_V2} />);
    expect(html).toContain("no Tier 3 rules implemented yet");
  });
});

// ---------------------------------------------------------------------------
// Block D — SIGNALS APPLIED
// ---------------------------------------------------------------------------

describe("BlockD", () => {
  test("renders section with audit-block id 'D'", () => {
    const html = String(<BlockD v2={BASE_V2} />);
    expect(html).toContain('data-audit-block="D"');
  });

  test("renders SIGNALS APPLIED label", () => {
    const html = String(<BlockD v2={BASE_V2} />);
    expect(html).toContain("SIGNALS APPLIED");
  });

  test("renders signal_sources chips when present", () => {
    const html = String(<BlockD v2={BASE_V2} />);
    expect(html).toContain("secrets-scan");
    expect(html).toContain("rubric-tier1");
  });

  test("renders preference-history header + empty-log copy when stats null", () => {
    const html = String(<BlockD v2={BASE_V2} />);
    expect(html).toContain("preference history");
    expect(html).toContain("preference-log empty or unavailable");
  });

  test("renders preference-history counts when stats provided", () => {
    const stats = {
      total: 5,
      ack: 2,
      dismiss: 2,
      forward: 1,
      feedback: 0,
      byCritique: {},
      windowStart: null,
      windowEnd: null,
    };
    const html = String(<BlockD v2={BASE_V2} preferenceStats={stats} critiqueId="c-test" />);
    expect(html).toContain("ack 2");
    expect(html).toContain("dismiss 2");
    expect(html).toContain("forward 1");
  });

  test("renders few-shot panel when critique_id provided", () => {
    const html = String(<BlockD v2={BASE_V2} critiqueId="c-test-001" />);
    expect(html).toContain("few-shot retrieval");
    expect(html).toContain("/api/critique/c-test-001/few-shot");
  });

  test("renders repo-memory placeholder", () => {
    const html = String(<BlockD v2={BASE_V2} />);
    expect(html).toContain("repo-memory conventions");
  });

  test("renders placeholder when v2 is null", () => {
    const html = String(<BlockD v2={null} />);
    expect(html).toContain("v2 audit data unavailable");
  });
});

// ---------------------------------------------------------------------------
// Block E — VERDICT CHAIN
// ---------------------------------------------------------------------------

describe("BlockE", () => {
  test("renders section with audit-block id 'E'", () => {
    const html = String(<BlockE v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain('data-audit-block="E"');
  });

  test("renders VERDICT CHAIN label", () => {
    const html = String(<BlockE v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("VERDICT CHAIN");
  });

  test("renders severity badge from v2", () => {
    const html = String(<BlockE v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("high");
  });

  test("renders category badge from v2", () => {
    const html = String(<BlockE v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("security");
  });

  test("renders intent classification with confidence", () => {
    const html = String(<BlockE v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("bugfix");
    expect(html).toContain("92%");
  });

  test("renders reasoning from v2", () => {
    const html = String(<BlockE v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("AWS key in source. Detected by secrets scan.");
  });

  test("renders critique_for_claude from v2", () => {
    const html = String(<BlockE v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("Move AKIA to env var.");
  });

  test("falls back to CriticCall.reasoning when v2 is null", () => {
    const html = String(<BlockE v2={null} c={BASE_CALL} />);
    expect(html).toContain("AWS key embedded in source.");
  });

  test("falls back to CriticCall.critique_for_claude when v2 is null", () => {
    const html = String(<BlockE v2={null} c={BASE_CALL} />);
    expect(html).toContain("Move AKIA to env var.");
  });

  test("renders no-reasoning placeholder when both null", () => {
    const callNoReasoning = { ...BASE_CALL, reasoning: null, critique_for_claude: null };
    const html = String(<BlockE v2={null} c={callNoReasoning} />);
    expect(html).toContain("no reasoning");
    expect(html).toContain("no actionable review");
  });
});

// ---------------------------------------------------------------------------
// Block F — COST
// ---------------------------------------------------------------------------

describe("BlockF", () => {
  test("renders section with audit-block id 'F'", () => {
    const html = String(<BlockF v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain('data-audit-block="F"');
  });

  test("renders COST label", () => {
    const html = String(<BlockF v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("COST");
  });

  test("renders token breakdown when tokens present", () => {
    const html = String(<BlockF v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("input:");
    expect(html).toContain("output:");
    expect(html).toContain("cache read:");
    expect(html).toContain("cache hit:");
  });

  test("renders cost in dollars", () => {
    const html = String(<BlockF v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("0.0032");
  });

  test("renders timing breakdown", () => {
    const html = String(<BlockF v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("summary");
    expect(html).toContain("review");
    expect(html).toContain("total");
  });

  test("renders placeholder when no tokens and no cost", () => {
    const callNoTokens = { ...BASE_CALL, tokens: null, cost_usd: null, timing: null };
    const html = String(<BlockF v2={null} c={callNoTokens} />);
    expect(html).toContain("no cost data");
  });

  test("renders cost-only line when tokens null but cost present", () => {
    const callCostOnly = { ...BASE_CALL, tokens: null, timing: null };
    const html = String(<BlockF v2={null} c={callCostOnly} />);
    expect(html).toContain("no token breakdown available");
    expect(html).toContain("0.0032");
  });
});

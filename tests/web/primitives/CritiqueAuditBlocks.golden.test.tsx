/** @jsxImportSource hono/jsx */
/**
 * CritiqueAuditBlocks.golden — characterization snapshots for the
 * 5 audit blocks (A, C, D, E, F) used inside the /history expand panel.
 *
 * Each block is exercised in two states:
 *   1. v2 = null  → placeholder/empty path
 *   2. v2 = canned → populated path
 *
 * Snapshots pin the SSR HTML output. Re-capture via R1_GOLDEN_MODE=capture.
 */
import { test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import {
  BlockA,
  BlockC,
  BlockD,
  BlockE,
  BlockF,
} from "../../../src/web/primitives/CritiqueAuditBlocks";
import type { V2SidecarData } from "../../../src/state/v2-sidecar";
import type { CriticCall } from "../../../src/state/critic-event-log";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");
const CAPTURE = process.env.R1_GOLDEN_MODE === "capture";

const CANNED_V2: V2SidecarData = {
  schemaVersion: 2,
  critique_id: "c-golden-1",
  ts: "2026-05-14T12:00:00Z",
  severity: "medium",
  confidence: "high",
  category: "code_smell",
  status: "pending",
  reasoning: "The added helper duplicates logic already present in utils.ts.",
  critique_for_claude: "Reuse the existing util — don't fork the format helper.",
  suggested_fix: "Import from utils.ts.",
  bubble_short: "duplicate helper",
  bubble_long: "You added a 4-line helper that already exists in utils.ts.",
  mood: "side_eye",
  pose: "tilt",
  intent_classification: "refactor",
  intent_confidence: 0.82,
  user_raw_query: "clean up the date helpers",
  agent_reply: "Added a new formatDate function in src/format.ts.",
  signal_sources: ["diff_intent", "rubric"],
  rubric_triggers: [
    {
      rule_id: "duplicate-logic",
      tier: 2,
      severity: "medium",
      file: "src/format.ts",
      line: 12,
      snippet: "function formatDate(d: Date)",
      message: "Duplicates utils.ts:34",
      signal_source: "rubric",
    },
  ],
  changed_files: ["src/format.ts", "src/utils.ts"],
  diff_intent: "Add a date formatting helper.",
};

const CANNED_CALL: CriticCall = {
  timestamp: "2026-05-14T12:00:00Z",
  session_id: "s-golden",
  cwd: "/fixture/proj-a",
  project: "proj-a",
  status: "FIRED",
  skip_reason: null,
  bubble_short: "duplicate helper",
  bubble_long: "You added a 4-line helper that already exists in utils.ts.",
  critique_for_claude: "Reuse the existing util — don't fork the format helper.",
  severity: "medium",
  confidence: "high",
  evidence: [],
  gating_decision: "NORMAL",
  turns_included: 3,
  duration_ms: 1200,
  cost_usd: 0.0012,
  tokens: { input: 100, output: 50, cache_read: 0, cache_create: 0 },
  diff_snapshot_id: null,
  diff_text: null,
  diff_summary: null,
  summary_error: null,
  user_action: null,
  speech_kind: "narrative",
  reasoning: null,
  timing: null,
  critique_id: "c-golden-1",
  v2: null,
} as unknown as CriticCall;

function diffOrCapture(html: string, fixtureName: string): void {
  const fixturePath = join(FIXTURE_DIR, fixtureName);
  if (CAPTURE || !existsSync(fixturePath)) {
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, html, "utf8");
    expect(html).toBe(html);
    return;
  }
  const expected = readFileSync(fixturePath, "utf8");
  if (html !== expected) {
    throw new Error(
      `${fixtureName} mismatch.\n` +
        `Fixture: ${fixturePath}\n` +
        `Expected ${expected.length} bytes, got ${html.length} bytes.\n` +
        `Re-capture with: R1_GOLDEN_MODE=capture bun test tests/web/primitives/CritiqueAuditBlocks.golden.test.tsx`,
    );
  }
  expect(html).toBe(expected);
}

// Block A ──────────────────────────────────────────────────────────────────
test("golden: BlockA v2=null", () => {
  diffOrCapture(String(<BlockA v2={null} c={CANNED_CALL} />), "BlockA-null.html");
});
test("golden: BlockA v2=canned", () => {
  diffOrCapture(
    String(<BlockA v2={CANNED_V2} c={CANNED_CALL} />),
    "BlockA-canned.html",
  );
});

// Block C ──────────────────────────────────────────────────────────────────
test("golden: BlockC v2=null", () => {
  diffOrCapture(
    String(<BlockC v2={null} cwd="/fixture/proj-a" />),
    "BlockC-null.html",
  );
});
test("golden: BlockC v2=canned", () => {
  diffOrCapture(
    String(<BlockC v2={CANNED_V2} cwd="/fixture/proj-a" />),
    "BlockC-canned.html",
  );
});
test("golden: BlockC v2=pipelineRanClean (schemaVersion=2, 0 triggers)", () => {
  const cleanV2: V2SidecarData = { ...CANNED_V2, rubric_triggers: [] };
  diffOrCapture(
    String(<BlockC v2={cleanV2} cwd="/fixture/proj-a" />),
    "BlockC-pipelineRanClean.html",
  );
});
test("golden: BlockC v2=legacy (schemaVersion=1)", () => {
  const legacyV2: V2SidecarData = { ...CANNED_V2, schemaVersion: 1, rubric_triggers: [] };
  diffOrCapture(
    String(<BlockC v2={legacyV2} cwd="/fixture/proj-a" />),
    "BlockC-legacy.html",
  );
});

// Block D ──────────────────────────────────────────────────────────────────
test("golden: BlockD v2=null", () => {
  diffOrCapture(String(<BlockD v2={null} />), "BlockD-null.html");
});
test("golden: BlockD v2=canned", () => {
  diffOrCapture(
    String(<BlockD v2={CANNED_V2} critiqueId="c-golden-1" />),
    "BlockD-canned.html",
  );
});

// Block E ──────────────────────────────────────────────────────────────────
test("golden: BlockE v2=null", () => {
  diffOrCapture(String(<BlockE v2={null} c={CANNED_CALL} />), "BlockE-null.html");
});
test("golden: BlockE v2=canned", () => {
  diffOrCapture(
    String(<BlockE v2={CANNED_V2} c={CANNED_CALL} />),
    "BlockE-canned.html",
  );
});

// Block F ──────────────────────────────────────────────────────────────────
test("golden: BlockF v2=null", () => {
  diffOrCapture(String(<BlockF v2={null} c={CANNED_CALL} />), "BlockF-null.html");
});
test("golden: BlockF v2=canned", () => {
  diffOrCapture(
    String(<BlockF v2={CANNED_V2} c={CANNED_CALL} />),
    "BlockF-canned.html",
  );
});

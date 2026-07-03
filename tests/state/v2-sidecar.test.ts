/**
 * v2-sidecar.test.ts — unit tests for loadV2Sidecar + frontmatter parser.
 *
 * Tests: sidecar parse, fallback behavior, and lookup by session_id.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadV2Sidecar } from "../../src/state/v2-sidecar";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-v2sidecar-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeArchiveFile(dayDir: string, filename: string, content: string): void {
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(join(dayDir, filename), content, "utf8");
}

const DEMO_V2 = `---
schemaVersion: 2
critique_id: c-demo-001
ts: 2026-05-20T12:00:00.000Z
session_id: sess-abc123
intent_classification: bugfix
intent_confidence: 0.92
category: security
severity: high
confidence: high
status: pending
signal_sources: [secrets-scan, rubric-tier1]
reasoning: "AWS key embedded in source."
critique_for_claude: "Move AKIA to env var."
suggested_fix: "const key = process.env.AWS_KEY;"
mood: concerned
pose: base
bubble_short: "secret in source"
bubble_long: ""
agent_restatement: "I'll move the API key to an environment variable."
agent_restatement_source: verb-pattern
user_raw_query: "fix the secret"
xp_earned_events: []
evidence:
  - rule_id: aws-access-key
    tier: 1
    severity: high
    file: src/auth.ts
    line: 18
    snippet: "const accessKey = 'AKIAIOSFODNN7EXAMPLE'"
    signal_source: secrets-scan
  - rule_id: god-file
    tier: 1
    file: src/big.ts
    line: 1
    snippet: "// 1000 lines"
    signal_source: rubric-tier1
---
Body text here.
`;

const DEMO_V1 = `---
schemaVersion: 1
timestamp: 2026-05-19T10:00:00.000Z
critique_id: c-v1-001
session_id: sess-v1-xyz
cwd: /tmp/project
mood: neutral
pose: sit
severity: info
confidence: high
status: pending
---

# [SILTPOKE CRITIQUE]

## Bubble (user-facing)

All looks fine.
`;

// ---------------------------------------------------------------------------
// Parse: v2 sidecar with full fields
// ---------------------------------------------------------------------------

test("parses v2 sidecar — schemaVersion, critique_id, severity, category", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-20");
  writeArchiveFile(dayDir, "c-demo-001.md", DEMO_V2);

  const result = await loadV2Sidecar("c-demo-001", null, tmp);
  expect(result).not.toBeNull();
  expect(result?.schemaVersion).toBe(2);
  expect(result?.critique_id).toBe("c-demo-001");
  expect(result?.severity).toBe("high");
  expect(result?.category).toBe("security");
  expect(result?.status).toBe("pending");
});

test("parses v2 sidecar — intent fields", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-20");
  writeArchiveFile(dayDir, "c-demo-001.md", DEMO_V2);

  const result = await loadV2Sidecar("c-demo-001", null, tmp);
  expect(result?.intent_classification).toBe("bugfix");
  expect(result?.intent_confidence).toBeCloseTo(0.92);
  expect(result?.user_raw_query).toBe("fix the secret");
});

test("parses v2 sidecar — signal_sources flow array", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-20");
  writeArchiveFile(dayDir, "c-demo-001.md", DEMO_V2);

  const result = await loadV2Sidecar("c-demo-001", null, tmp);
  expect(result?.signal_sources).toEqual(["secrets-scan", "rubric-tier1"]);
});

test("parses v2 sidecar — evidence block (2 triggers)", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-20");
  writeArchiveFile(dayDir, "c-demo-001.md", DEMO_V2);

  const result = await loadV2Sidecar("c-demo-001", null, tmp);
  expect(result?.rubric_triggers).toHaveLength(2);

  const first = result?.rubric_triggers[0]!;
  expect(first.rule_id).toBe("aws-access-key");
  expect(first.tier).toBe(1);
  expect(first.file).toBe("src/auth.ts");
  expect(first.line).toBe(18);
  expect(first.snippet).toContain("AKIAIOSFODNN7EXAMPLE");
  expect(first.signal_source).toBe("secrets-scan");

  const second = result?.rubric_triggers[1]!;
  expect(second.rule_id).toBe("god-file");
  expect(second.tier).toBe(1);
});

test("parses v2 sidecar — reasoning and critique_for_claude", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-20");
  writeArchiveFile(dayDir, "c-demo-001.md", DEMO_V2);

  const result = await loadV2Sidecar("c-demo-001", null, tmp);
  expect(result?.reasoning).toBe("AWS key embedded in source.");
  expect(result?.critique_for_claude).toBe("Move AKIA to env var.");
  expect(result?.suggested_fix).toBe("const key = process.env.AWS_KEY;");
});

// ---------------------------------------------------------------------------
// Parse: v1 sidecar (missing v2 fields → null)
// ---------------------------------------------------------------------------

test("v1 sidecar — v2 fields are null", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-19");
  writeArchiveFile(dayDir, "c-v1-001.md", DEMO_V1);

  const result = await loadV2Sidecar("c-v1-001", null, tmp);
  expect(result).not.toBeNull();
  expect(result?.schemaVersion).toBe(1);
  expect(result?.intent_classification).toBeNull();
  expect(result?.intent_confidence).toBeNull();
  expect(result?.user_raw_query).toBeNull();
  expect(result?.signal_sources).toEqual([]);
  expect(result?.rubric_triggers).toHaveLength(0);
});

test("v1 sidecar — core v1 fields are parsed", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-19");
  writeArchiveFile(dayDir, "c-v1-001.md", DEMO_V1);

  const result = await loadV2Sidecar("c-v1-001", null, tmp);
  expect(result?.critique_id).toBe("c-v1-001");
  expect(result?.severity).toBe("info");
  expect(result?.confidence).toBe("high");
  expect(result?.mood).toBe("neutral");
});

// ---------------------------------------------------------------------------
// Lookup by session_id
// ---------------------------------------------------------------------------

test("lookup by session_id when critiqueId is null", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-20");
  writeArchiveFile(dayDir, "c-demo-001.md", DEMO_V2);

  const result = await loadV2Sidecar(null, "sess-abc123", tmp);
  expect(result).not.toBeNull();
  expect(result?.critique_id).toBe("c-demo-001");
});

test("lookup by session_id finds correct file among multiple", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-20");
  writeArchiveFile(dayDir, "c-demo-001.md", DEMO_V2);
  // Another file with different session
  const other = DEMO_V2.replace("sess-abc123", "sess-other-456").replace("c-demo-001", "c-other-002");
  writeArchiveFile(dayDir, "c-other-002.md", other);

  const result = await loadV2Sidecar(null, "sess-abc123", tmp);
  expect(result?.critique_id).toBe("c-demo-001");
});

test("both critiqueId and sessionId null → returns null", async () => {
  const result = await loadV2Sidecar(null, null, tmp);
  expect(result).toBeNull();
});

// ---------------------------------------------------------------------------
// Fallback: file missing
// ---------------------------------------------------------------------------

test("returns null when archive doesn't exist", async () => {
  const result = await loadV2Sidecar("c-nonexistent", null, tmp);
  expect(result).toBeNull();
});

test("returns null when sessionId doesn't match any file", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-20");
  writeArchiveFile(dayDir, "c-demo-001.md", DEMO_V2);

  const result = await loadV2Sidecar(null, "sess-no-match", tmp);
  expect(result).toBeNull();
});

test("returns null when file is malformed (no frontmatter)", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-20");
  writeArchiveFile(dayDir, "c-malformed.md", "no frontmatter here\njust body text");

  const result = await loadV2Sidecar("c-malformed", null, tmp);
  // Malformed means no --- → parseFrontmatter returns empty fm → maps to null-safe data
  // It returns a sidecar with null values (not a hard null)
  expect(result).not.toBeNull();
  expect(result?.critique_id).toBeNull();
  expect(result?.schemaVersion).toBeNull();
});

// ---------------------------------------------------------------------------
// Newest-day-first: picks most recent
// ---------------------------------------------------------------------------

test("newest-day-first lookup picks latest archive day", async () => {
  // Write same session_id in two different days
  const oldDay = join(tmp, "critiques", "archive", "2026-05-19");
  const newDay = join(tmp, "critiques", "archive", "2026-05-20");
  const old = DEMO_V1.replace("c-v1-001", "c-old").replace("sess-v1-xyz", "sess-multi");
  const newer = DEMO_V2.replace("c-demo-001", "c-new").replace("sess-abc123", "sess-multi");
  writeArchiveFile(oldDay, "c-old.md", old);
  writeArchiveFile(newDay, "c-new.md", newer);

  // Should find the newer day first
  const result = await loadV2Sidecar(null, "sess-multi", tmp);
  expect(result?.critique_id).toBe("c-new");
});

// ---------------------------------------------------------------------------
// Issue 2 fix: v2 sidecar .v2.md preference + schemaVersion key alignment
// ---------------------------------------------------------------------------

const DEMO_V2_SIDECAR = `---
schemaVersion: 2
critique_id: c-roundtrip-001
session_id: sess-rt-001
cwd: /tmp/project
intent_classification: feature
intent_confidence: 0.75
signal_sources: [rubric-tier1, rubric-tier2]
rubric_trigger_count: 3
evidence:
  - rule_id: god-file
    tier: 1
    severity: high
    file: src/critic/run-critic.ts
    line: 1
    message: "File exceeds 800 lines"
  - rule_id: long-param-list
    tier: 2
    severity: med
    file: src/critic/run-critic.ts
    line: 263
    message: "Function has >4 params"
  - rule_id: god-function
    tier: 2
    severity: med
    file: src/critic/run-critic.ts
    line: 263
    message: "Function exceeds 50 LOC"
user_raw_query: add tracing to the critic pipeline
agent_restatement: Adding OTEL spans to each phase of runCritic().
agent_restatement_source: verb-pattern
alignment_check: null
---

# V2 Evidence Sidecar

See c-roundtrip-001.md for the full critique.
`;

test("v2.md sidecar: loader prefers {id}.v2.md over {id}.md", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-20");
  // Write the plain .md with no evidence (v1-like)
  writeArchiveFile(dayDir, "c-roundtrip-001.md", DEMO_V1.replace("c-v1-001", "c-roundtrip-001").replace("sess-v1-xyz", "sess-rt-001"));
  // Write the .v2.md sidecar with 3 triggers
  writeArchiveFile(dayDir, "c-roundtrip-001.v2.md", DEMO_V2_SIDECAR);

  const result = await loadV2Sidecar("c-roundtrip-001", null, tmp);
  expect(result).not.toBeNull();
  // Should have parsed the .v2.md, not the .md (which has 0 triggers)
  expect(result?.rubric_triggers).toHaveLength(3);
  expect(result?.rubric_triggers[0]?.rule_id).toBe("god-file");
  expect(result?.rubric_triggers[1]?.rule_id).toBe("long-param-list");
  expect(result?.rubric_triggers[2]?.rule_id).toBe("god-function");
});

test("v2.md sidecar: 3 triggers parsed with correct tier and severity", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-20");
  writeArchiveFile(dayDir, "c-roundtrip-001.v2.md", DEMO_V2_SIDECAR);

  const result = await loadV2Sidecar("c-roundtrip-001", null, tmp);
  expect(result?.rubric_triggers[0]?.tier).toBe(1);
  expect(result?.rubric_triggers[0]?.severity).toBe("high");
  expect(result?.rubric_triggers[1]?.tier).toBe(2);
  expect(result?.rubric_triggers[1]?.severity).toBe("med");
  expect(result?.rubric_triggers[2]?.severity).toBe("med");
});

test("v2.md sidecar: captured intent fields parsed correctly", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-20");
  writeArchiveFile(dayDir, "c-roundtrip-001.v2.md", DEMO_V2_SIDECAR);

  const result = await loadV2Sidecar("c-roundtrip-001", null, tmp);
  expect(result?.user_raw_query).toBe("add tracing to the critic pipeline");
});

// ---------------------------------------------------------------------------
// YAML block scalar (`|`) support — fixes empty Block A on multi-line queries
// ---------------------------------------------------------------------------

const DEMO_V2_BLOCK_SCALAR = `---
schemaVersion: 2
critique_id: c-block-001
session_id: sess-block-test
severity: info
confidence: high
status: pending
signal_sources: []
user_raw_query: |
  fix the null pointer in parser
  also rename the helper to camelCase
  and add a unit test
agent_restatement: |
  I'll guard against null and rename the helper.
agent_restatement_source: first-paragraph
alignment_check: null
---
Body.
`;

test("parses YAML | block scalar for user_raw_query (multi-line)", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-20");
  writeArchiveFile(dayDir, "c-block-001.md", DEMO_V2_BLOCK_SCALAR);

  const result = await loadV2Sidecar("c-block-001", null, tmp);
  expect(result).not.toBeNull();
  expect(result?.user_raw_query).toBe(
    "fix the null pointer in parser\nalso rename the helper to camelCase\nand add a unit test",
  );
});

const DEMO_V2_BLOCK_PRESERVES_INNER_COLONS = `---
schemaVersion: 2
critique_id: c-block-003
session_id: sess-block-test-3
severity: info
confidence: high
status: pending
signal_sources: []
user_raw_query: |
  [Image: source: /Users/foo/Desktop/shot.png]
  [Image: source: /Users/foo/Desktop/shot2.png]
---
`;

test("block scalar preserves lines containing colons (image refs)", async () => {
  const dayDir = join(tmp, "critiques", "archive", "2026-05-20");
  writeArchiveFile(dayDir, "c-block-003.md", DEMO_V2_BLOCK_PRESERVES_INNER_COLONS);

  const result = await loadV2Sidecar("c-block-003", null, tmp);
  expect(result?.user_raw_query).toBe(
    "[Image: source: /Users/foo/Desktop/shot.png]\n[Image: source: /Users/foo/Desktop/shot2.png]",
  );
});

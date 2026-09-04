/** @jsxImportSource hono/jsx */
/**
 * CritiqueAuditBlocks.test.tsx — render tests for the 6 audit blocks.
 *
 * Each test renders a block to HTML and asserts key strings / attributes
 * are present. No DOM or browser needed — Hono JSX produces a string.
 */
import { AUDIT_ABSENCE_COPY } from "../../../src/state/audit-absence";
import { describe, test, expect } from "bun:test";
import {
  BlockA,
  BlockC,
  BlockD,
  BlockE,
  BlockF,
} from "../../../src/web/primitives/CritiqueAuditBlocks";
import { ALL_RULES } from "../../../src/web/primitives/critique-audit/rules-data";
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
  audit_absence: "unrecorded" as const,
  evidence_label: null,
  evidence_unverified: 0,
  diff_shown: null,
  diff_total: null,
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
  provider: "claude",
  authorFamily: "claude",
  billing: "usd",
  model: null,
  branch: null,
  user_raw_query: null,
  user_raw_query_truncated: false,
  agent_reply: null,
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

  // A row with NOTHING on it — no sidecar and no diff_summary. Only this is
  // supposed to render the placeholder as the block's whole content.
  const EMPTY_CALL: CriticCall = { ...BASE_CALL, diff_summary: null };

  test("placeholder states the row's OWN reason, and drops the legacy claim", () => {
    // The dominant real case (53.5% of fired reviews on a measured store).
    const c = { ...EMPTY_CALL, audit_absence: "evidence_empty" as const };
    const html = String(<BlockA v2={null} c={c} />);
    expect(html).toContain(AUDIT_ABSENCE_COPY.evidence_empty);
    expect(html).toContain('data-audit-block="A"');
    // The regression this pins: the old build printed this for EVERY absence,
    // including reviews minutes old. It may now appear only on `unrecorded`.
    expect(html).not.toContain(AUDIT_ABSENCE_COPY.unrecorded);
  });

  test("placeholder still says 'pre-dates' for a genuinely unrecorded row", () => {
    const c = { ...EMPTY_CALL, audit_absence: "unrecorded" as const };
    const html = String(<BlockA v2={null} c={c} />);
    expect(html).toContain(AUDIT_ABSENCE_COPY.unrecorded);
  });

  test("falls back to diff_summary.intent when v2.diff_intent is null", () => {
    const v2NoIntent = { ...BASE_V2, diff_intent: null };
    const html = String(<BlockA v2={v2NoIntent} c={BASE_CALL} />);
    // Should fall back to c.diff_summary.intent
    expect(html).toContain("move AWS key to env");
  });

  // -------------------------------------------------------------------------
  // Defect ② — the block returned a placeholder before ever looking at the row
  // -------------------------------------------------------------------------

  test("with NO sidecar, reads the row's diff_summary instead of claiming nothing was read", () => {
    // 356 of the 381 no-sidecar rows (93.4%) on a measured store look exactly
    // like this — snapshot `...-2026-08-19T19Z.txt` §5.
    const html = String(<BlockA v2={null} c={BASE_CALL} />);
    expect(html).toContain("src/auth.ts");
    expect(html).toContain("move AWS key to env");
    // And it must NOT print "no record of what Siltpoke read" over the record.
    expect(html).not.toContain(AUDIT_ABSENCE_COPY.unrecorded);
  });

  test("renders each file's purpose, not just its path", () => {
    const html = String(<BlockA v2={null} c={BASE_CALL} />);
    expect(html).toContain("move key");
  });

  test("sidecar file list wins, and the row supplies the purposes", () => {
    // v2 lists two files; diff_summary knows the purpose of one of them.
    const html = String(<BlockA v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("src/big.ts"); // present only in the sidecar list
    expect(html).toContain("move key"); // purpose joined on from the row
  });

  test("the two sources are joined across their DIFFERENT path namespaces", () => {
    // Production shape, which no earlier fixture had: the sidecar's
    // `changed_files` are ABSOLUTE (a real sidecar on the measured machine
    // carries `- /Users/.../smoke-desktop.ts`) while
    // `diff_summary.files_with_purpose[].path` is repo-relative. Keying the
    // join on the raw string missed every entry and dropped every purpose,
    // and both older fixtures used one namespace on both sides.
    const c: CriticCall = {
      ...BASE_CALL,
      cwd: "/tmp/project",
      diff_summary: {
        intent: "move AWS key to env",
        key_changes: [],
        risks: [],
        file_count: 1,
        files_with_purpose: [{ path: "src/auth.ts", purpose: "move key" }],
        source: "haiku",
      },
    };
    const v2Absolute = { ...BASE_V2, changed_files: ["/tmp/project/src/auth.ts"] };
    const html = String(<BlockA v2={v2Absolute} c={c} />);
    expect(html).toContain("move key");
  });

  test("the truncation sentinel is not rendered as a file", () => {
    // `run-diff-summary.ts` appends a synthetic entry whose `path` is a NOTE,
    // not a path, and it points at a section that is not under this block.
    // 165 of 381 no-sidecar rows carry it (43.3%, snapshot §5).
    const c: CriticCall = {
      ...BASE_CALL,
      diff_summary: {
        intent: "big change",
        key_changes: [],
        risks: [],
        file_count: 18,
        files_with_purpose: [
          { path: "src/auth.ts", purpose: "move key" },
          {
            path: "[15 additional files truncated — see DIFF SNAPSHOT below]",
            purpose: "summary truncated; actual diff has more files than Haiku read",
          },
        ],
        source: "haiku",
      },
    };
    const html = String(<BlockA v2={null} c={c} />);
    expect(html).toContain("src/auth.ts");
    // The note must not appear as a row, and the page must not tell the reader
    // to look at a DIFF SNAPSHOT that is not on this surface.
    expect(html).not.toContain("DIFF SNAPSHOT");
    expect(html).not.toContain("additional files truncated");
    // The fact is not lost — it becomes a count, from `file_count` (18) minus
    // the one real entry.
    expect(html).toContain("17 more the summary did not name");
  });

  test("a heuristic diff summary is not labelled as a Haiku pre-pass", () => {
    // `intent` is a byte-count sentence when Haiku failed; 43 of 381 rows.
    const c: CriticCall = {
      ...BASE_CALL,
      diff_summary: {
        intent: "29 files changed · +2030 −606 (heuristic summary — Haiku unavailable)",
        key_changes: [],
        risks: [],
        file_count: 0,
        files_with_purpose: [],
        source: "heuristic",
      },
    };
    const html = String(<BlockA v2={null} c={c} />);
    expect(html).toContain("heuristic summary — Haiku unavailable");
    expect(html).not.toContain("haiku pre-pass");
    expect(html).toContain("no LLM — counted from the diff");
  });

  test("an EMPTY sidecar file list falls through to the row, and does not read as zero files", () => {
    // "The sidecar recorded no list" and "the diff touched no files" are
    // different facts; the row still knows which files there were.
    const html = String(<BlockA v2={{ ...BASE_V2, changed_files: [] }} c={BASE_CALL} />);
    expect(html).toContain("src/auth.ts");
  });

  test("a file listed twice is rendered once", () => {
    const v2Dup = { ...BASE_V2, changed_files: ["src/auth.ts", "src/auth.ts"] };
    const html = String(<BlockA v2={v2Dup} c={BASE_CALL} />);
    // Count ROWS, not occurrences of the path: each row carries the path twice
    // (a `title` attribute and the visible text), so a naive substring count
    // reads 2 for a correctly de-duplicated list.
    expect((html.match(/title="src\/auth\.ts"/g) ?? []).length).toBe(1);
  });

  test("the honest agent-reply label is the DEFAULT, not an opt-in", () => {
    // `/history` never passed the override, so the label its own JSDoc called
    // inaccurate shipped on every row it rendered.
    const html = String(<BlockA v2={BASE_V2} c={{ ...BASE_CALL, agent_reply: "ok" }} />);
    expect(html).toContain("first ¶, ≤1200 chars");
    expect(html).not.toContain("agent reply (verbatim)");
  });

  // -------------------------------------------------------------------------
  // Defect ⑤ — the user's own words, now on the row
  // -------------------------------------------------------------------------

  test("with NO sidecar, renders user_raw_query + agent_reply off the row", () => {
    const c: CriticCall = {
      ...BASE_CALL,
      user_raw_query: "why is the rubric empty",
      agent_reply: "because the block returned early",
    };
    const html = String(<BlockA v2={null} c={c} />);
    expect(html).toContain("why is the rubric empty");
    expect(html).toContain("because the block returned early");
  });

  test("sidecar's query wins over the row's when both exist", () => {
    const c: CriticCall = { ...BASE_CALL, user_raw_query: "the row copy" };
    const html = String(<BlockA v2={BASE_V2} c={c} />);
    expect(html).toContain("fix the secret"); // BASE_V2.user_raw_query
    expect(html).not.toContain("the row copy");
  });

  test("a row written AFTER the wire is not told it is older than the wire", () => {
    // The claim the first version of this test was named for and did not check:
    // it asserted only the prefix, while the fabricated clause sat in the tail.
    // `user_raw_query` is null on brand-new rows in three reachable ways — an
    // unreadable transcript, a turn with no user message, the pipeline switched
    // off — and the page must not guess which.
    const c: CriticCall = {
      ...BASE_CALL,
      timestamp: "2026-09-01T12:00:00.000Z",
      user_raw_query: null,
    };
    const html = String(<BlockA v2={null} c={c} />);
    expect(html).toContain("your own words were not saved");
    expect(html).not.toContain("older");
    // ...and it names the possibilities without asserting a cause. The first
    // version of THIS fix said "so this one hit something that stopped it",
    // which is itself a claim — and a real page rendered it over a row written
    // hours before the code existed, because a date has no hour.
    expect(html).toContain("or something stopped the capture");
    expect(html).toContain("ran before that update reached this machine");
  });

  test("a row written BEFORE the wire is told exactly that", () => {
    // Swap-proof against the test above: delete the branch and one of the two
    // fails, whichever way the constant falls.
    const c: CriticCall = {
      ...BASE_CALL,
      timestamp: "2026-07-01T12:00:00.000Z",
      user_raw_query: null,
    };
    const html = String(<BlockA v2={null} c={c} />);
    expect(html).toContain("this review is from before that");
    // The older branch DOES get to be definite — that is the whole point of
    // branching — so it must not carry the newer branch's hedge.
    expect(html).not.toContain("or something stopped the capture");
  });

  test("flags a truncated row query, and only when the row's copy is the one shown", () => {
    const truncated: CriticCall = {
      ...BASE_CALL,
      user_raw_query: "x".repeat(2000),
      user_raw_query_truncated: true,
    };
    expect(String(<BlockA v2={null} c={truncated} />)).toContain("first 2000 characters");
    // Sidecar supplied the text shown, so the ROW's truncation flag is not
    // about it and must not be claimed.
    expect(String(<BlockA v2={BASE_V2} c={truncated} />)).not.toContain(
      "first 2000 characters",
    );
  });
});

// ---------------------------------------------------------------------------
// Block C — RUBRIC CHECKLIST
// ---------------------------------------------------------------------------

describe("BlockC", () => {
  test("renders section with audit-block id 'C'", () => {
    const html = String(<BlockC v2={BASE_V2} absence="present" />);
    expect(html).toContain('data-audit-block="C"');
  });

  test("renders RUBRIC CHECKLIST label", () => {
    const html = String(<BlockC v2={BASE_V2} absence="present" />);
    expect(html).toContain("RUBRIC CHECKLIST");
  });

  test("renders tier group labels", () => {
    const html = String(<BlockC v2={BASE_V2} absence="present" />);
    expect(html).toContain("Tier 1");
    expect(html).toContain("Tier 2");
    expect(html).toContain("Tier 3");
  });

  test("renders fail (✗) for triggered rules", () => {
    const html = String(<BlockC v2={BASE_V2} absence="present" />);
    // aws-access-key triggered → ✗; god-file triggered → ✗
    const failCount = (html.match(/rubric-row--fail/g) ?? []).length;
    expect(failCount).toBeGreaterThanOrEqual(2);
  });

  test("renders pass (✓) for non-triggered rules when rubric ran", () => {
    const html = String(<BlockC v2={BASE_V2} absence="present" />);
    const passCount = (html.match(/rubric-row--pass/g) ?? []).length;
    expect(passCount).toBeGreaterThan(0);
  });

  test("renders a dot (·, was ⊘) for a legacy critique (schemaVersion=1)", () => {
    const legacyV2 = { ...BASE_V2, schemaVersion: 1, rubric_triggers: [] };
    const html = String(<BlockC v2={legacyV2} absence="present" />);
    const naCount = (html.match(/rubric-row--na/g) ?? []).length;
    expect(naCount).toBeGreaterThan(0);
    expect(html).toContain("rubric not run (legacy review)");
  });

  test("renders pass (✓) for all rules when pipeline ran clean (schemaVersion=2, 0 triggers)", () => {
    const cleanV2 = { ...BASE_V2, schemaVersion: 2, rubric_triggers: [] };
    const html = String(<BlockC v2={cleanV2} absence="present" />);
    const passCount = (html.match(/rubric-row--pass/g) ?? []).length;
    expect(passCount).toBeGreaterThan(0);
    expect(html).toContain("all rules pass — 0 triggers");
    // None should be N/A when pipeline ran cleanly
    expect(html).not.toMatch(/rubric-row--na/);
  });

  test("shows trigger detail (file:line) for failing rules", () => {
    const html = String(<BlockC v2={BASE_V2} absence="present" />);
    // god-file trigger is at src/auth.ts:18
    expect(html).toContain("src/auth.ts:18");
    // god-function trigger is at src/big.ts:1
    expect(html).toContain("src/big.ts:1");
  });

  test("without a sidecar it still renders the panels that never needed one", () => {
    // Found by opening the page, not by a failing test: with no sidecar the
    // whole block collapsed to one sentence, taking down two panels that do
    // not read `v2` at all. Preference history is an aggregate over the
    // preference log; few-shot keys off `critique_id`. Block C, one section
    // up, already degrades the honest way — it keeps rendering the rubric
    // checklist with a dot beside every rule.
    const html = String(<BlockD v2={null} critiqueId="c-test-001" absence="evidence_empty" />);
    expect(html).toContain(AUDIT_ABSENCE_COPY.evidence_empty);
    expect(html).toContain("preference history");
  });

  test("few-shot stays behind the gate — its PROPS are independent, its DATA is not", () => {
    // The first version of this split read the prop list (`critiqueId` only),
    // called few-shot independent, and rendered it on sidecar-less rows. Its
    // endpoint builds the query text out of the sidecar and returns an empty
    // list the moment that is missing, so the panel could only ever say "no
    // similar past reviews" — after paying for a request. Worse, it uses
    // `x-init="load()"`, and `tests/web/routes/timeline-tabs.test.ts` pins the
    // page to exactly one such loader at page load; rendering it per row turned
    // a lazy page into a fan-out. Caught by the full suite, not by this file.
    const noSidecar = String(<BlockD v2={null} critiqueId="c-test-001" absence="evidence_empty" />);
    expect(noSidecar).not.toContain("few-shot retrieval");
    expect(noSidecar).not.toContain('x-init="load()"');
    // …and it is still there when the sidecar is, or the gate would just be a
    // deletion.
    const withSidecar = String(<BlockD v2={BASE_V2} critiqueId="c-test-001" absence="present" />);
    expect(withSidecar).toContain("few-shot retrieval");
  });

  test("…and still withholds the two panels that DO read the sidecar", () => {
    // The other direction. Without this, "render everything unconditionally"
    // passes the test above while inventing a repo-memory verdict for a row
    // whose rubric triggers were never recorded.
    const html = String(<BlockD v2={null} critiqueId="c-test-001" absence="evidence_empty" />);
    expect(html).not.toContain("repo-memory conventions");
    expect(html).not.toContain("signal sources fired");
    // And the sidecar case is unchanged — both come back.
    const withV2 = String(<BlockD v2={BASE_V2} critiqueId="c-test-001" absence="present" />);
    expect(withV2).toContain("repo-memory conventions");
  });

  test("names what the four preference counters are, not just their numbers", () => {
    // `ack 0 · dismiss 0 · forward 0 · feedback 0` gave four bare words and no
    // vocabulary, so a zero read as "no data" when it means "you have never
    // done this". Block C, one section up, lists its rules by name for exactly
    // this reason.
    const html = String(<BlockD v2={null} absence="evidence_empty" />);
    expect(html).toContain("data-preference-legend");
    for (const word of ["you marked it seen", "you said the review was wrong", "you acted on it", "you wrote why"]) {
      expect(html).toContain(word);
    }
  });

  test("the legend does not claim what the signals feed — that link is unverified", () => {
    // `preference-log.jsonl` is what these counters read; `consolidate.ts`'s
    // dismissal loader reads `feedback-archive.jsonl`, a different file on a
    // different write path. A sentence about what these signals teach would be
    // the page asserting what its own data does not support.
    const html = String(<BlockD v2={null} absence="evidence_empty" />);
    for (const claim of ["teaches", "learns", "feeds into memory", "trains"]) {
      expect(html.toLowerCase()).not.toContain(claim);
    }
  });

  test("placeholder states the given reason, not a fixed sentence", () => {
    const html = String(<BlockC v2={null} absence="brain_killed" />);
    expect(html).toContain(AUDIT_ABSENCE_COPY.brain_killed);
    expect(html).not.toContain(AUDIT_ABSENCE_COPY.unrecorded);
    // Swap-proof: a different kind must produce different text, or the block
    // would be ignoring the prop and this assertion would pass on any wiring.
    const other = String(<BlockC v2={null} absence="evidence_empty" />);
    expect(other).not.toContain(AUDIT_ABSENCE_COPY.brain_killed);
  });

  test("renders Tier 3 placeholder noting no rules", () => {
    const html = String(<BlockC v2={BASE_V2} absence="present" />);
    expect(html).toContain("no Tier 3 rules implemented yet");
  });

  // -------------------------------------------------------------------------
  // Defect ① — the checklist vanished whole whenever there was no sidecar
  // -------------------------------------------------------------------------

  test("with NO sidecar, still draws every rule — the list is static, not per-review", () => {
    const html = String(<BlockC v2={null} absence="evidence_empty" />);
    const rows = (html.match(/data-rule-id=/g) ?? []).length;
    // Count comes from ALL_RULES, not from a hand-copied number here: the
    // assertion is "all of them", and hardcoding 13 would go quietly wrong the
    // day a rule is added.
    expect(rows).toBe(ALL_RULES.length);
    expect(rows).toBeGreaterThan(0);
    expect(html).toContain("Tier 1");
    expect(html).toContain("Tier 2");
  });

  test("an unchecked rule gets a dot — not a tick and not a cross", () => {
    const html = String(<BlockC v2={null} absence="evidence_empty" />);
    expect((html.match(/rubric-row--na/g) ?? []).length).toBe(ALL_RULES.length);
    expect(html).not.toMatch(/rubric-row--pass/);
    expect(html).not.toMatch(/rubric-row--fail/);
    expect(html).toContain(">·<");
    // The two glyphs that CLAIM an outcome must be absent — that is the whole
    // shape of the fix, and asserting only the dot would pass on a row that
    // rendered a dot AND a tick.
    expect(html).not.toContain(">✓<");
    expect(html).not.toContain(">✗<");
  });

  test("with NO sidecar, still says WHY there are no results", () => {
    // The list is drawn, but the reason must not be lost to draw it.
    const html = String(<BlockC v2={null} absence="brain_killed" />);
    expect(html).toContain(AUDIT_ABSENCE_COPY.brain_killed);
  });
});

// ---------------------------------------------------------------------------
// Block D — WHAT ELSE I KNEW
// ---------------------------------------------------------------------------

describe("BlockD", () => {
  test("renders section with audit-block id 'D'", () => {
    const html = String(<BlockD v2={BASE_V2} absence="present" />);
    expect(html).toContain('data-audit-block="D"');
  });

  test("renders WHAT ELSE I KNEW label", () => {
    const html = String(<BlockD v2={BASE_V2} absence="present" />);
    expect(html).toContain("WHAT ELSE I KNEW");
  });

  test("renders signal_sources chips when present", () => {
    const html = String(<BlockD v2={BASE_V2} absence="present" />);
    expect(html).toContain("secrets-scan");
    expect(html).toContain("rubric-tier1");
  });

  test("renders preference-history header + empty-log copy when stats null", () => {
    const html = String(<BlockD v2={BASE_V2} absence="present" />);
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
    const html = String(<BlockD v2={BASE_V2} preferenceStats={stats} critiqueId="c-test" absence="present" />);
    expect(html).toContain("ack 2");
    expect(html).toContain("dismiss 2");
    expect(html).toContain("forward 1");
  });

  test("renders few-shot panel when critique_id provided", () => {
    const html = String(<BlockD v2={BASE_V2} critiqueId="c-test-001" absence="present" />);
    expect(html).toContain("few-shot retrieval");
    expect(html).toContain("/api/critique/c-test-001/few-shot");
  });

  test("renders repo-memory placeholder", () => {
    const html = String(<BlockD v2={BASE_V2} absence="present" />);
    expect(html).toContain("repo-memory conventions");
  });

  test("placeholder states the given reason, not a fixed sentence", () => {
    const html = String(<BlockD v2={null} absence="brain_schema" />);
    expect(html).toContain(AUDIT_ABSENCE_COPY.brain_schema);
    expect(html).not.toContain(AUDIT_ABSENCE_COPY.unrecorded);
    const other = String(<BlockD v2={null} absence="evidence_empty" />);
    expect(other).not.toContain(AUDIT_ABSENCE_COPY.brain_schema);
  });
});

// ---------------------------------------------------------------------------
// Block E — HOW I DECIDED
// ---------------------------------------------------------------------------

describe("BlockE", () => {
  test("renders section with audit-block id 'E'", () => {
    const html = String(<BlockE v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain('data-audit-block="E"');
  });

  test("renders HOW I DECIDED label", () => {
    const html = String(<BlockE v2={BASE_V2} c={BASE_CALL} />);
    expect(html).toContain("HOW I DECIDED");
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

  // Track #7 T3 (AC8, null-render half) — a quota-billed provider (codex)
  // row has real tokens but a legitimately null cost_usd (never a fabricated
  // dollar figure). The row must stay visible with its token counts; only
  // the $ line is omitted — no placeholder, no crash, no "$0.0000" lie.
  test("codex-shaped row (tokens present, cost_usd null, quota billing) — tokens render, no $ line, no placeholder", () => {
    const codexCall = {
      ...BASE_CALL,
      tokens: { input: 500, output: 120, cache_read: 0, cache_create: 0 },
      cost_usd: null,
      provider: "codex",
      billing: "quota" as const,
      model: "gpt-5-codex",
    };
    const html = String(<BlockF v2={null} c={codexCall} />);
    expect(html).toContain("input: 500");
    expect(html).toContain("output: 120");
    expect(html).not.toContain("no cost data");
    expect(html).not.toContain("$ ");
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * parseCall — track #7 T3 (AC7): provider/billing/model passthrough with
 * historical-row-compatible defaults (absent fields ⇒ claude/usd/null).
 */
import { test, expect } from "bun:test";
import { parseCall } from "../../src/state/critic-event-log-parse";

const baseFired = {
  timestamp: "2026-07-07T12:00:00.000Z",
  session_id: "sess-1",
  cwd: "/repo/proj",
  critic_path_decision: "NORMAL",
  m112_accepted: true,
  brain_output: {
    bubble_short: "ok",
    severity: "info",
    confidence: "high",
  },
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_cost_usd: null,
  },
};

test("historical row without provider/billing/model → claude/usd/null defaults", () => {
  const call = parseCall(baseFired);
  expect(call).not.toBeNull();
  expect(call!.provider).toBe("claude");
  expect(call!.billing).toBe("usd");
  expect(call!.model).toBeNull();
  // Historical claude row: quota semantics never leak in.
  expect(call!.cost_usd).toBeNull();
});

test("codex row passes through provider=codex, billing=quota, model=served string", () => {
  const call = parseCall({
    ...baseFired,
    provider: "codex",
    billing: "quota",
    model: "gpt-5-codex",
  });
  expect(call).not.toBeNull();
  expect(call!.provider).toBe("codex");
  expect(call!.billing).toBe("quota");
  expect(call!.model).toBe("gpt-5-codex");
});

// Slice B (T4): authorFamily — WHO built this run, persisted first-class so the
// timeline/swiftbar tag survives even when the reviewer was overridden to a
// different family than the builder. Historical rows default to claude.
test("historical row without authorFamily → defaults claude", () => {
  const call = parseCall(baseFired);
  expect(call!.authorFamily).toBe("claude");
});

test("row with authorFamily passes it through (independent of reviewer provider)", () => {
  const call = parseCall({ ...baseFired, authorFamily: "codebuddy", provider: "codex" });
  expect(call!.authorFamily).toBe("codebuddy"); // builder = codebuddy
  expect(call!.provider).toBe("codex"); // reviewer overridden to codex — tag still shows builder
});

test("garbage billing value falls back to usd (narrow guard)", () => {
  const call = parseCall({ ...baseFired, provider: "codex", billing: "dollars" });
  expect(call!.billing).toBe("usd");
});

test("skipped row also carries default provider fields", () => {
  const call = parseCall({
    timestamp: "2026-07-07T12:00:00.000Z",
    session_id: "sess-2",
    cwd: "/repo/proj",
    skipped: "quiet_hours",
  });
  expect(call).not.toBeNull();
  expect(call!.provider).toBe("claude");
  expect(call!.billing).toBe("usd");
  expect(call!.model).toBeNull();
});

test("brain-error row also carries default provider fields", () => {
  const call = parseCall({
    timestamp: "2026-07-07T12:00:00.000Z",
    session_id: "sess-3",
    cwd: "/repo/proj",
    error_message: "codex exec exited with code 1",
  });
  expect(call).not.toBeNull();
  expect(call!.skip_reason).toBe("brain_error");
  expect(call!.provider).toBe("claude");
  expect(call!.billing).toBe("usd");
});

// ---------------------------------------------------------------------------
// diff_summary.truncated passthrough.
//
// `truncated` has to cross three hand-written layers to reach the dashboard —
// the zod schema, this parser, and the CriticCall type — and none of them
// propagate a new field automatically. The renderer's own tests build their
// summaries by hand, so they stay green even if THIS layer drops the field.
// These are the assertions that catch that.
// ---------------------------------------------------------------------------

const summaryRow = (truncated?: unknown) => ({
  ...baseFired,
  diff_summary: {
    intent: "did a thing",
    key_changes: ["k"],
    risks: ["r"],
    file_count: 1,
    files_with_purpose: [{ path: "src/a.ts", purpose: "p" }],
    source: "haiku",
    ...(truncated === undefined ? {} : { truncated }),
  },
});

test("parseCall carries diff_summary.truncated through", () => {
  const call = parseCall(summaryRow({ risks: 2, key_changes: 1 }));
  expect(call?.diff_summary?.truncated).toEqual({
    key_changes: 1,
    risks: 2,
    files_with_purpose: undefined,
  });
});

test("a row with no truncated field parses the summary and omits the field", () => {
  const call = parseCall(summaryRow());
  // Asserting the summary is actually THERE, not merely non-null: an earlier
  // draft of this test used not.toBeNull(), which `undefined` satisfies, so it
  // passed while parseCall was returning null for a malformed fixture.
  expect(call?.diff_summary?.intent).toBe("did a thing");
  expect(call?.diff_summary?.truncated).toBeUndefined();
});

test("an empty truncated object does not become a phantom truncation", () => {
  // {} must read as "nothing dropped", not as a present-but-blank record a
  // renderer might treat as truthy.
  const call = parseCall(summaryRow({}));
  expect(call?.diff_summary?.intent).toBe("did a thing");
  expect(call?.diff_summary?.truncated).toBeUndefined();
});

test("junk values in truncated are dropped rather than propagated", () => {
  const call = parseCall(
    summaryRow({ risks: "lots", key_changes: -4, files_with_purpose: 3 }),
  );
  // Only the one real count survives; a string and a negative are not counts.
  expect(call?.diff_summary?.truncated).toEqual({
    key_changes: undefined,
    risks: undefined,
    files_with_purpose: 3,
  });
});

// ---------------------------------------------------------------------------
// The user's own words, off the ROW (2026-08-19). Before this they lived only
// in the v2 sidecar — 3% of rows — so Block A said "not captured" on the rest.
// ---------------------------------------------------------------------------

test("row carries user_raw_query + agent_reply through to the call", () => {
  const call = parseCall({
    ...baseFired,
    user_raw_query: "why is the checklist empty",
    agent_reply: "the block returned before reading the row",
  });
  expect(call!.user_raw_query).toBe("why is the checklist empty");
  expect(call!.agent_reply).toBe("the block returned before reading the row");
  expect(call!.user_raw_query_truncated).toBe(false);
});

test("a row written before the field exists reads as null, not undefined", () => {
  const call = parseCall(baseFired);
  expect(call!.user_raw_query).toBeNull();
  expect(call!.agent_reply).toBeNull();
  expect(call!.user_raw_query_truncated).toBe(false);
});

test("empty strings are treated as absent, not as a blank quote", () => {
  // Renders as an empty box under a heading promising a verbatim quote.
  const call = parseCall({ ...baseFired, user_raw_query: "", agent_reply: "" });
  expect(call!.user_raw_query).toBeNull();
  expect(call!.agent_reply).toBeNull();
});

test("the truncation flag is carried, but never without a query to describe", () => {
  const withQuery = parseCall({
    ...baseFired,
    user_raw_query: "x".repeat(10),
    user_raw_query_truncated: true,
  });
  expect(withQuery!.user_raw_query_truncated).toBe(true);
  // A flag with no query would claim something was cut when nothing was saved.
  const orphan = parseCall({ ...baseFired, user_raw_query_truncated: true });
  expect(orphan!.user_raw_query).toBeNull();
  expect(orphan!.user_raw_query_truncated).toBe(false);
});

test("a skip row gets the fields too — every branch of parseCall, not just fired", () => {
  const call = parseCall({
    timestamp: "2026-08-19T12:00:00.000Z",
    session_id: "sess-skip",
    cwd: "/repo/proj",
    skipped: "no_code_changes",
    user_raw_query: "just asking a question",
  });
  expect(call!.status).toBe("skipped");
  expect(call!.user_raw_query).toBe("just asking a question");
});

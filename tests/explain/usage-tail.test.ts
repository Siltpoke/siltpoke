/**
 * Tolerant usage parse from a failed run's stdout tail.
 *
 * Golden fixture synthesized from a sample run a claude -p result-event shape (the
 * success path parses the same shape in src/brain/brain.ts ResultEvent):
 * total_cost_usd 0.8542, input_tokens 150000. The tail is the LAST 500 chars
 * of stdout — JSON may be complete, cut mid-usage-block, or absent entirely.
 */
import { expect, test } from "bun:test";
import { parseUsageFromTail } from "../../src/explain/usage-tail";

// A sample run shape: the final result event of a `claude -p --output-format json`
// stream (array form, as providers.ts JSON.parses on the success path).
const RESULT_EVENT_JSON =
  '{"type":"result","subtype":"error_during_execution","is_error":true,' +
  '"result":"","total_cost_usd":0.8542,"usage":{"input_tokens":150000,' +
  '"cache_creation_input_tokens":48211,"cache_read_input_tokens":1024,' +
  '"output_tokens":31}}]';

test("test_tail_parse_full_result_event_json (golden a sample run)", () => {
  const tail = `…er events elided…,${RESULT_EVENT_JSON}`.slice(-500);
  const u = parseUsageFromTail(tail);
  expect(u).not.toBeNull();
  expect(u?.total_cost_usd).toBeCloseTo(0.8542, 5);
  expect(u?.input_tokens).toBe(150000);
  expect(u?.cache_creation_input_tokens).toBe(48211);
  expect(u?.cache_read_input_tokens).toBe(1024);
  expect(u?.output_tokens).toBe(31);
});

test("test_tail_parse_inside_providers_error_message", () => {
  // The real wiring input is the providers.ts thrown message, not bare stdout.
  const msg = `claude -p exited 1: stderr tail:  | stdout tail: ${RESULT_EVENT_JSON}`;
  const u = parseUsageFromTail(msg);
  expect(u?.total_cost_usd).toBeCloseTo(0.8542, 5);
  expect(u?.input_tokens).toBe(150000);
});

test("test_tail_parse_cut_mid_usage_block (fields after the cut are 0)", () => {
  const tail =
    '…,"total_cost_usd":0.8542,"usage":{"input_tokens":150000,"cache_creation_inp';
  const u = parseUsageFromTail(tail);
  expect(u).not.toBeNull();
  expect(u?.total_cost_usd).toBeCloseTo(0.8542, 5);
  expect(u?.input_tokens).toBe(150000);
  expect(u?.cache_creation_input_tokens).toBe(0);
  expect(u?.cache_read_input_tokens).toBe(0);
  expect(u?.output_tokens).toBe(0);
});

test("test_tail_parse_no_json_at_all_returns_null", () => {
  expect(parseUsageFromTail("claude -p exited 137")).toBeNull();
  expect(parseUsageFromTail("")).toBeNull();
  expect(
    parseUsageFromTail("claude -p exited 1: stderr tail: Error: not logged in"),
  ).toBeNull();
});

test("test_tail_parse_cut_mid_number_is_not_a_truncated_value", () => {
  // The tail slices at a byte boundary — a number cut mid-digits would parse to
  // a WRONG (smaller) value. A field only counts when its number is closed by a
  // JSON delimiter; a lone cut-off field → null (fall back to estimate).
  expect(parseUsageFromTail('…,"usage":{"input_tokens":2029')).toBeNull();
});

test("test_tail_parse_last_occurrence_wins", () => {
  // A tail can carry more than one usage-bearing fragment (per-turn events
  // before the final result event); the result event is last in the stream.
  const tail =
    '"usage":{"input_tokens":7,"output_tokens":1},…,"total_cost_usd":0.8542,' +
    '"usage":{"input_tokens":150000,"output_tokens":31}}';
  const u = parseUsageFromTail(tail);
  expect(u?.input_tokens).toBe(150000);
  expect(u?.output_tokens).toBe(31);
});

// ── review BF3(b) — cross-object pairing guard ───────────────────────────────

test("test_BF3_cross_object_cost_is_NOT_paired_with_trailing_tokens", () => {
  // The last cost lives in an EARLIER object (closed by `}` before `,{`); the
  // token fields live in the trailing object. Pairing them would attach a
  // per-turn $0.001 to the result event's 150000 tokens — a fabricated pair.
  const tail =
    '…,"total_cost_usd":0.001},{"type":"result",' +
    '"usage":{"input_tokens":150000,"output_tokens":31}}';
  const u = parseUsageFromTail(tail);
  expect(u).not.toBeNull();
  expect(u?.input_tokens).toBe(150000); // trailing object's tokens are real
  expect(u?.output_tokens).toBe(31);
  expect(u?.total_cost_usd).toBeNull(); // the cost belonged to a previous event
});

test("test_BF3_same_object_cost_token_pairing_still_works (guard does not over-fire)", () => {
  // The a claude -p result-event shape (cost, then nested usage — no object boundary
  // between them) must keep pairing exactly as before.
  const u = parseUsageFromTail(
    ',"total_cost_usd":0.8542,"usage":{"input_tokens":150000,"output_tokens":31}}',
  );
  expect(u?.total_cost_usd).toBeCloseTo(0.8542, 5);
  expect(u?.input_tokens).toBe(150000);
});

test("test_BF3_same_object_cost_AFTER_tokens_drops_cost (conservative corollary pinned)", () => {
  // Hypothetical future field reorder: cost appears after the usage block in
  // the SAME object. The pairing guard cannot distinguish this from the
  // cross-object case, so it deliberately drops cost to null (estimate
  // fallback — under-ledgers, never fabricates). Pinned per final-pass note
  // so a future reorder fails loudly here instead of silently changing basis.
  const u = parseUsageFromTail(
    ',"usage":{"input_tokens":150000,"output_tokens":31},"total_cost_usd":0.8542}',
  );
  expect(u).not.toBeNull();
  expect(u?.input_tokens).toBe(150000);
  expect(u?.total_cost_usd).toBeNull();
});

// ── review BF3(c) — magnitude sanity bound ───────────────────────────────────

test("test_BF3_magnitude_just_under_ceiling_passes", () => {
  const u = parseUsageFromTail(
    ',"total_cost_usd":999.99,"usage":{"input_tokens":49999999,"output_tokens":31}}',
  );
  expect(u).not.toBeNull();
  expect(u?.input_tokens).toBe(49999999);
  expect(u?.total_cost_usd).toBeCloseTo(999.99, 2);
});

test("test_BF3_absurd_token_count_rejects_to_null (estimate fallback takes over)", () => {
  // A 50M+ token count cannot be a real single claude -p call — it is regex
  // noise from a garbled tail. Ledgering it would poison the daily rollup.
  expect(
    parseUsageFromTail(',"usage":{"input_tokens":50000001,"output_tokens":31}}'),
  ).toBeNull();
});

test("test_BF3_absurd_cost_rejects_to_null", () => {
  expect(
    parseUsageFromTail(',"total_cost_usd":1000.5,"usage":{"input_tokens":100,"output_tokens":3}}'),
  ).toBeNull();
});

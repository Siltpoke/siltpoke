// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Tolerant usage extraction from a failed `claude -p` run's captured stdout
 * tail.
 *
 * `--output-format json` reports errors on STDOUT, and the providers.ts failure
 * path keeps only the LAST 500 chars (`stdout tail: …` inside the thrown error
 * message). The result event carries `total_cost_usd` + `usage{…}` — but in a
 * truncated tail the JSON may be cut mid-object, so `JSON.parse` is the wrong
 * tool. Regex field extraction pulls whatever survived; anything missing fails
 * soft (null → caller falls back to the pre-flight estimate, never throws).
 */

/** Field-for-field the `BrainUsage` numbers a result event carries. */
export interface TailUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_cost_usd: number | null;
}

/** A matched `"key": <number>` occurrence with the positions the pairing
 * guard needs: `start` = match start, `numEnd` = index just past the number
 * (BEFORE its closing delimiter, so a `}` delimiter lands in any slice taken
 * from `numEnd` — that `}` is exactly the object-boundary evidence). */
interface ClosedNumber {
  value: number;
  start: number;
  numEnd: number;
}

/**
 * Last `"key": <number>` occurrence in `text`, or null. Two honesty guards:
 * - the number must be CLOSED by a JSON delimiter (`,` `}` `]`) — a number cut
 *   mid-digits at the tail boundary would silently parse to a wrong, smaller
 *   value (150000 → 2029), worse than no value;
 * - last occurrence wins — the result event is the final event in the stream,
 *   so the tail's last usage-bearing fragment is the authoritative one.
 */
function lastClosedNumber(
  text: string,
  key: string,
  pattern: string,
): ClosedNumber | null {
  const re = new RegExp(`"${key}"\\s*:\\s*(${pattern})\\s*[,}\\]]`, "g");
  let last: ClosedNumber | null = null;
  for (const m of text.matchAll(re)) {
    const numStr = m[1];
    if (numStr === undefined) continue;
    const n = Number(numStr);
    if (!Number.isFinite(n)) continue;
    const start = m.index ?? 0;
    // Keys carry no digits, so the first occurrence of numStr in m[0] IS the
    // value position.
    last = { value: n, start, numEnd: start + m[0].indexOf(numStr) + numStr.length };
  }
  return last;
}

const INT = "\\d+";
const FLOAT = "\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?";

/** BF3(c) magnitude sanity ceilings — GENEROUS upper bounds (real burns are
 * ~200k tokens / ~$2; a single `claude -p` call cannot approach these). A
 * parsed figure above them is regex noise from a garbled tail, not usage —
 * ledgering it would poison the daily rollup / budget gate. */
const MAX_TOKENS = 50_000_000;
const MAX_COST_USD = 1000;

/**
 * Extract what survived of the result event's usage from a (possibly
 * truncated) stdout tail. Returns null when NOTHING usable was found — the
 * caller then falls back to the pre-flight estimate (`basis: "estimated"`).
 * Partial extraction is fine: found token fields are real; missing ones are 0;
 * missing cost is null. Never throws.
 *
 * CONSTRAINT (BF3a): last-occurrence-wins is only sound for a SINGLE-result
 * stream — one `claude -p` invocation whose final event is the one result
 * event. Reusing this on a multi-turn / multi-result stream would silently
 * attribute only the last result's figures; such a caller needs real
 * object-boundary parsing, not this tail scraper.
 *
 * Hardening guards (review BF3):
 * - (b) cross-object pairing — the cost is kept only when at least one token
 *   field follows it with NO `}` in between (i.e. inside the same trailing
 *   object, matching the real result-event order `total_cost_usd` →
 *   `usage{…}`). A cost whose object closed before the token fields (e.g.
 *   `"total_cost_usd":0.001},{…"input_tokens":150000`) belongs to an earlier
 *   event → cost is dropped to null, tokens are kept. Conservative corollary:
 *   tokens-before-cost shapes also drop the cost.
 * - (c) magnitude sanity — any token count > 50M or cost > $1000 rejects the
 *   WHOLE parse to null (estimate fallback takes over).
 */
export function parseUsageFromTail(text: string): TailUsage | null {
  const cost = lastClosedNumber(text, "total_cost_usd", FLOAT);
  const input = lastClosedNumber(text, "input_tokens", INT);
  const output = lastClosedNumber(text, "output_tokens", INT);
  const cacheCreate = lastClosedNumber(text, "cache_creation_input_tokens", INT);
  const cacheRead = lastClosedNumber(text, "cache_read_input_tokens", INT);
  const tokenMatches = [input, output, cacheCreate, cacheRead];
  if (cost === null && tokenMatches.every((t) => t === null)) {
    return null;
  }
  // BF3(c) — magnitude sanity: an absurd figure means the tail was not the
  // result-event shape we understand; reject everything (estimate fallback).
  if (tokenMatches.some((t) => t !== null && t.value > MAX_TOKENS)) return null;
  if (cost !== null && cost.value > MAX_COST_USD) return null;
  // BF3(b) — cross-object pairing guard: keep the cost only when some token
  // field sits AFTER it in the SAME object (no `}` between — the slice starts
  // at numEnd, before the cost's own delimiter, so a `}` delimiter counts).
  let costValue: number | null = cost?.value ?? null;
  const presentTokens = tokenMatches.filter((t): t is ClosedNumber => t !== null);
  if (cost !== null && presentTokens.length > 0) {
    const paired = presentTokens.some(
      (t) => t.start > cost.numEnd && !text.slice(cost.numEnd, t.start).includes("}"),
    );
    if (!paired) costValue = null;
  }
  return {
    input_tokens: input?.value ?? 0,
    output_tokens: output?.value ?? 0,
    cache_creation_input_tokens: cacheCreate?.value ?? 0,
    cache_read_input_tokens: cacheRead?.value ?? 0,
    total_cost_usd: costValue,
  };
}

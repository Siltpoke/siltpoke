// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Brain subprocess failure classification — pure TS, never LLM.
 *
 * Classifies a failed `claude -p` spawn into one of four classes that
 * drive retry + circuit-breaker policy:
 *
 *   - throttle  → exactly 1 in-process retry (jittered)
 *   - resource  → 0 retries, breaker 15min → 60min
 *   - permanent → 0 retries, breaker latched until /siltpoke-wake or doctor re-verify
 *   - ambiguous → 0 retries (the paid-and-discarded risk class), breaker after 3 consecutive
 *
 * Marker regexes FROZEN against real captured evidence (2026-06-11):
 *   - 256× `exited with code 1` with EMPTY stderr tail → ambiguous (intended honest behavior)
 *   - 14× exit 143 (the 90s kill timer in brain.ts sending SIGTERM) → resource
 *   - `EAGAIN: resource temporarily unavailable, posix_spawn` + exit 137 → resource
 *   - NO rate-limit/overload markers were observed in ~/.siltpoke/logs/ or
 *     brain-calls.jsonl (all grep hits were hashes/timestamps/critique prose).
 *     Per the signed contingency the throttle set is the standard Anthropic
 *     API error shapes ONLY; everything unrecognized buckets to `ambiguous`,
 *     never `throttle`.
 *
 * The classifier examines BOTH stderr and stdout tails —
 * `claude -p` errors can land on stdout with --output-format json.
 */

export type FailureClass = "throttle" | "resource" | "permanent" | "ambiguous";

export interface BrainFailureInput {
  /** Subprocess exit code; null when the spawn itself failed. */
  exitCode: number | null;
  /** Captured stderr tail (may be empty — the historically dominant case). */
  stderr: string;
  /** Captured stdout tail (errors can land here with --output-format json). */
  stdout: string;
  /** Spawn-level error message (ENOENT / EAGAIN), when the process never started. */
  spawnError?: string;
}

// ── Frozen marker sets ───────────────────────────────────────────────────────

/** Permanent: deterministic, retrying never helps. Latched breaker. */
const PERMANENT_MARKERS: readonly RegExp[] = [
  /invalid api key/i,
  /please run \/login/i,
  /not logged in/i,
  /authentication[_ ]error/i,
  /unknown (option|argument|flag)/i,
  /credit balance is too low/i,
  // codex auth phrasing (track #7 T2, AC10) — ChatGPT-account login state.
  // Net-new alternatives only; /not logged in/i already covered above.
  /login required|codex login/i,
];

/**
 * Binary missing at spawn time — permanent until the binary is back on PATH.
 * Bun.spawn reports a missing executable as "Executable not found in $PATH"
 * (no ENOENT in the message); Node-style errors carry ENOENT. Match both.
 */
const BINARY_MISSING_MARKER = /ENOENT|executable not found/i;

/**
 * Throttle: standard Anthropic API rate-limit shapes. None observed in real
 * logs as of freezing (2026-06-11) — kept tight so nothing else can match.
 */
const THROTTLE_MARKERS: readonly RegExp[] = [
  /rate[ _-]?limit/i,
  /overloaded(_error)?/i,
  /too many requests/i,
  /\b429\b/,
  // codex quota phrasing (track #7 T2, AC10) — ChatGPT-plan quota, not $.
  // Net-new alternatives only; rate-limit already covered above.
  /usage limit|quota exceeded/i,
];

/** Resource: machine-level pressure. Observed: EAGAIN posix_spawn, exits 137/143. */
const RESOURCE_MARKERS: readonly RegExp[] = [
  /EAGAIN/,
  /resource temporarily unavailable/i,
  /posix_spawn/,
];
const RESOURCE_EXIT_CODES: ReadonlySet<number> = new Set([137, 143]);

function matchesAny(text: string, markers: readonly RegExp[]): boolean {
  return markers.some((re) => re.test(text));
}

/**
 * Classify a Brain (`claude -p`) failure. Pure function: exit code +
 * stderr/stdout tails + optional spawn error in, one of 4 classes out.
 *
 * Precedence: permanent > throttle > resource > ambiguous. Permanent wins
 * because retrying an auth/flag error burns money for nothing; throttle
 * beats resource because explicit markers are stronger evidence than an
 * exit code.
 */
export function classifyBrainFailure(input: BrainFailureInput): FailureClass {
  const spawnErr = input.spawnError ?? "";
  // Spawn never started: ENOENT = binary missing (permanent); EAGAIN = resource.
  if (spawnErr.length > 0) {
    if (BINARY_MISSING_MARKER.test(spawnErr)) return "permanent";
    if (matchesAny(spawnErr, RESOURCE_MARKERS)) return "resource";
  }

  const combined = `${input.stderr}\n${input.stdout}`;
  if (matchesAny(combined, PERMANENT_MARKERS)) return "permanent";
  if (matchesAny(combined, THROTTLE_MARKERS)) return "throttle";
  if (matchesAny(combined, RESOURCE_MARKERS)) return "resource";
  if (input.exitCode !== null && RESOURCE_EXIT_CODES.has(input.exitCode)) {
    return "resource";
  }

  // Everything else — including the observed empty-tail exit-1 majority —
  // is ambiguous: 0 retries. Do not loosen (signed contingency).
  return "ambiguous";
}

const RETRY_AFTER_PATTERNS: readonly RegExp[] = [
  /retry[-_]after[:\s]+(\d{1,4})/i,
  /retry after (\d{1,4})\s*(?:s|sec|second)/i,
  /"retry_after"\s*:\s*(\d{1,4})/,
];

/**
 * Extract a retry-after hint (in ms) from failure text, when parseable.
 * Values are interpreted as SECONDS (the HTTP Retry-After convention).
 * Returns null when no hint is present.
 */
export function parseRetryAfterMs(text: string): number | null {
  for (const re of RETRY_AFTER_PATTERNS) {
    const m = text.match(re);
    if (m?.[1] !== undefined) {
      const secs = Number.parseInt(m[1], 10);
      if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    }
  }
  return null;
}

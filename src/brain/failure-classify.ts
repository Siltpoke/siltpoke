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
 *   - permanent → 0 retries, breaker latched until /siltpoke:siltpoke-wake or doctor re-verify
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
 * ONE marker pair has been added since that freeze, on the same terms (a real
 * captured failure, not a guess): the Windows `.cmd` argv refusal
 * (`ERR_INVALID_ARG_VALUE`), measured 2026-09-24. It lives in its OWN set,
 * SPAWN_PERMANENT_MARKERS, checked against `spawnError` only — see that
 * declaration for why the field is as load-bearing as the pattern.
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
 * Permanent failures recognised ONLY on `spawnError` — the field set when the
 * process never started. Kept separate from PERMANENT_MARKERS on purpose, and
 * the reason is measured rather than theoretical.
 *
 * Windows argv refusal (defect `[26]`, measured on a real machine 2026-09-24):
 * npm's `claude` on Windows is `claude.cmd`, and the runtime refuses to pass a
 * parameter containing a cmd.exe special character to a `.bat`/`.cmd`
 * (CVE-2024-27980 hardening). The review prompt always contains one, so the
 * call fails identically every time — deterministic, which is what `permanent`
 * means here. It fell through to `ambiguous` before, whose breaker reopens
 * after 5 minutes, so the next commit spent another call on a failure that
 * could not succeed.
 *
 * WHY `spawnError` ONLY, and not the stderr/stdout tails like every marker
 * above. Two independent reasons, both load-bearing:
 *
 * 1. It is where the text actually IS. This is a spawn-time validation throw —
 *    the process never runs — so all four providers funnel it into
 *    `spawnError` with `exitCode: null` and EMPTY streams (brain.ts's
 *    spawn-catch, and its three mirrors). A marker checked against
 *    `stderr + stdout` never sees it. Measured: the production shape
 *    classified `ambiguous` while a hand-built stderr-shaped input — which
 *    production never produces — classified `permanent`. The first version of
 *    this fix shipped that hand-built shape as its test and was green.
 * 2. Model output can never reach this field. `classifierStdout` falls back to
 *    the raw stdout tail whenever the envelope does not parse, which is
 *    exactly the timeout case, and that tail carries assistant prose. Both
 *    patterns here are unanchored substrings of ordinary Node vocabulary — and
 *    `ERR_INVALID_ARG_VALUE` appears verbatim in this repo's own source and
 *    docs, so a review OF THIS FILE could quote it. brain.ts:195-201 records
 *    the same collision already happening once (`rate_limit_event` in the
 *    event stream matched the throttle marker and authorised a second PAID
 *    spawn), and states the rule this obeys: the markers stay frozen, what is
 *    FED to them is what changes. `permanent` latches the breaker until
 *    `/siltpoke:siltpoke-wake`, so a false match here silences the pet indefinitely.
 *
 * Consequence stated rather than hidden: a runtime that reports this refusal on
 * stderr from a process that DID start would not be caught. No such runtime is
 * known — the refusal is raised by the parent before any child exists.
 */
const SPAWN_PERMANENT_MARKERS: readonly RegExp[] = [
  /ERR_INVALID_ARG_VALUE/,
  /cmd\.exe special character/i,
];

/**
 * The one ERR_INVALID_ARG_VALUE that is NOT permanent: a NUL character in an
 * argv entry. It carries the same error class as the Windows refusal above but
 * says something different — this INPUT cannot be passed, not this machine
 * cannot review. Measured 2026-09-29 on macOS: one reviewed diff held a raw
 * NUL, the class marker above matched, the breaker latched, and every review on
 * that machine was skipped for two days (562 turns) with nothing saying so.
 * `nulSafe` now keeps NULs out of argv; this stays as the second line, so a
 * path that forgets to call it costs one skipped turn instead of all of them.
 */
const NUL_ARG_MARKER = /without null bytes/i;

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
    // Before the permanent markers: same error class, opposite meaning.
    if (NUL_ARG_MARKER.test(spawnErr)) return "ambiguous";
    // Checked here and nowhere else — see SPAWN_PERMANENT_MARKERS for why the
    // field matters as much as the pattern.
    if (matchesAny(spawnErr, SPAWN_PERMANENT_MARKERS)) return "permanent";
    // Checked here and nowhere else — see SPAWN_PERMANENT_MARKERS for why the
    // field matters as much as the pattern.
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

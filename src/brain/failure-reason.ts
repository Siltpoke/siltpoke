// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Turn a failed brain call into ONE human-readable sentence.
 *
 * WHY THIS EXISTS — audit defect `[4]`. The reason a review failed was being
 * lost on one side and mangled on the other, from the same root cause: nobody
 * owned the question "what do we TELL the user about this failure?".
 *
 *   - `src/brain/brain.ts` built its error message from `stderr` alone, but
 *     `claude -p --output-format json` writes the reason to STDOUT. The hook
 *     therefore logged `claude -p exited with code 1:` with nothing after the
 *     colon, for a failure whose cause (`Not logged in`) was sitting right
 *     there in the captured stdout.
 *   - `src/brain/brain-guarded.ts` recorded the excerpt as
 *     `spawnError + stderr + stdout` concatenated and tail-sliced, so the
 *     dashboard banner rendered the middle of a JSON envelope at the user:
 *     `e:{"success","api_error_status":null,"result":"Not logged in …`.
 *
 * This module is the single answer both now use. It deliberately does NOT
 * decide whether to SHOW anything — `hooks/stop.sh` is explicit that siltpoke
 * must never put an error into the user's Claude Code session, and the audit
 * did not argue with that. The silence was fine; throwing the reason away was
 * not.
 */
import { findResultEvent, normalizeStreamEnvelope } from "./envelope";

/** Everything known about a failed call. Mirrors `BrainError.failure`. */
export interface BrainFailureFacts {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  /** Set when the process never started at all. */
  spawnError?: string;
}

/** Keeps a reason from flooding a statusline or a one-line banner. */
const MAX_REASON = 500;

/**
 * A caller's cap, forced into a range where truncation actually truncates.
 *
 * `"abc".slice(-0)` is `"abc"`, not `""` — JS coerces `-0` to `0` and
 * `slice(0)` returns the whole string. So a `max` of 0 made `keepTail` return
 * the ENTIRE body, which is precisely the flooding this cap exists to prevent,
 * while `keepHead` at 0 returned an empty string and broke the never-empty
 * guarantee. Neither of today's two callers can pass 0, but this is an
 * exported parameter, so the guarantee is enforced rather than assumed.
 */
function usableMax(max: number): number {
  return Number.isFinite(max) && max >= 1 ? Math.floor(max) : MAX_REASON;
}

/** Collapse to a single line. No truncation — the callers below decide that. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A distilled reason is a SENTENCE, so it is cut from the end.
 *
 * Raw output is cut from the START instead (`keepTail`). The two directions
 * are deliberate and each was measured: an error payload's informative part is
 * at its end, behind a boilerplate preamble
 * (`tests/brain/brain-guarded.test.ts` pins that), while `Not logged in ·
 * Please run /login` is ruined by dropping its first words.
 */
function keepHead(text: string, max: number): string {
  return oneLine(text).slice(0, usableMax(max));
}

function keepTail(text: string, max: number): string {
  return oneLine(text).slice(-usableMax(max));
}

/**
 * What a stream of output turned out to be.
 *
 * `completed` is the case worth naming: the subprocess produced a WHOLE,
 * successful result event and the call still failed — a timeout kill after the
 * answer was already flushed is the realistic one (`brain.ts` kills at the
 * timeout, and `failure-classify.ts` treats exit 143 as resource-class). The
 * model's answer is emphatically not the reason the call failed, so it must
 * not be handed to the user as one, and the raw text must not be pasted either
 * — that would put the JSON envelope back on screen.
 */
type StreamReading =
  | { kind: "reason"; text: string }
  | { kind: "completed" }
  | { kind: "unreadable" };

/**
 * Read a `claude -p --output-format json` payload.
 *
 * `error` wins over `result`: when both are present the former is the failure
 * and the latter is whatever partial output preceded it.
 */
function readStream(text: string, max: number): StreamReading {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "unreadable" };
  let event: { result?: unknown; error?: unknown; is_error?: unknown };
  try {
    event = findResultEvent(normalizeStreamEnvelope(JSON.parse(trimmed)));
  } catch {
    return { kind: "unreadable" };
  }
  if (typeof event.error === "string" && event.error.trim().length > 0) {
    return { kind: "reason", text: keepHead(event.error, max) };
  }
  // `result` is only a failure reason when the event does not say otherwise.
  // An absent `is_error` stays eligible — plenty of payloads omit it, and the
  // classifier does not require it either.
  if (event.is_error === false) return { kind: "completed" };
  if (typeof event.result === "string" && event.result.trim().length > 0) {
    return { kind: "reason", text: keepHead(event.result, max) };
  }
  return { kind: "completed" };
}

/**
 * The best human-readable reason available, in order of how much it tells the
 * user. Never empty, and never ends on a dangling separator — the bare
 * `exited with code 1:` is the exact shape this replaces.
 */
export function explainBrainFailure(
  facts: BrainFailureFacts,
  max: number = MAX_REASON,
): string {
  if (facts.spawnError !== undefined && facts.spawnError.trim().length > 0) {
    return keepHead(facts.spawnError, max);
  }
  // stdout first: with `--output-format json` that is where the reason lives,
  // and stderr is routinely empty for exactly those failures.
  const readings = new Map<string, StreamReading>();
  for (const [name, stream] of [
    ["stdout", facts.stdout],
    ["stderr", facts.stderr],
  ] as const) {
    const reading = readStream(stream, max);
    readings.set(name, reading);
    if (reading.kind === "reason") return reading.text;
  }
  for (const [name, stream] of [
    ["stderr", facts.stderr],
    ["stdout", facts.stdout],
  ] as const) {
    // A stream that parsed as a complete, non-error envelope is skipped rather
    // than pasted: its raw form is the JSON this whole module exists to keep
    // off the screen.
    if (readings.get(name)?.kind === "completed") continue;
    const plain = keepTail(stream, max);
    if (plain.length > 0) return plain;
  }
  if ([...readings.values()].some((r) => r.kind === "completed")) {
    return `exit ${facts.exitCode ?? "?"} after the model had already answered`;
  }
  return `exit ${facts.exitCode ?? "?"}, no output`;
}

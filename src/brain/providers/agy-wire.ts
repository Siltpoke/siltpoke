// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * How the review reaches `agy`, and how its reply comes back — the wire layer.
 *
 * Holds the two pure prompt helpers (`mergeAgyPrompt`, `formatPrintTimeout`) that
 * have always been agy's wire format, the argv builder, plus the Windows stdin
 * path below. They live here rather than in agy.ts because with all of this
 * inline agy.ts landed 2 lines under the 400-line cap, and in this repo a file
 * that close to its cap gets split rather than re-pinned.
 *
 * ── The Windows path — over stdin instead of argv (the agy half of `[26]`) ──
 *
 * agy is the WORST case of the defect, not just another instance. It has no
 * `--system-prompt` flag and (in plain `-p` mode) no stdin path, so agy.ts's
 * `mergeAgyPrompt` puts the rubric AND the whole diff under review into ONE argv
 * entry, capped at 200,000 bytes. On Windows that entry cannot work:
 *  - an `agy` that resolves to a `.bat`/`.cmd` is refused outright for any
 *    argument containing a cmd.exe special character (CVE-2024-27980
 *    hardening) — the mechanism measured for `claude` in audit §36.3;
 *  - and even a native `agy.exe` is bounded by Windows' own documented
 *    ~32,767-character command line, which a rubric plus a real diff passes
 *    routinely. That bound is from the platform's documentation, NOT measured
 *    on the Windows box.
 * Neither failure has been reproduced on Windows — what was measured there is
 * the same argv shape failing for `claude`.
 *
 * THE WAY OUT, measured live on this machine 2026-09-26 (`agy 1.2.11`), exit 0:
 *
 *   agy -p= --input-format stream-json --output-format stream-json --sandbox \
 *       --print-timeout 90s   < one NDJSON line on stdin
 *
 * Three things about that command line were found by probing, not by reading:
 *  - `-p` must carry an ATTACHED empty value (`-p=`). Passing a bare `-p`
 *    followed by other flags makes agy take the next flag AS the prompt and
 *    refuse: `Error: -p took "--input-format" as its prompt`.
 *  - the NDJSON message is agy's OWN envelope, not Claude Code's. A
 *    claude-shaped `{"type":"user",…}` line is rejected with `stream input
 *    message is missing the "event" field`. The accepted shape is
 *    `{"event":"user","message":{"role":"user","content":[{"type":"text",…}]}}`.
 *  - `--input-format stream-json` REQUIRES `--output-format stream-json` (agy's
 *    own `--help`), so the reply arrives as an NDJSON event stream rather than
 *    bare text, and has to be parsed rather than read straight off stdout.
 *
 * WHY WIN32-ONLY, the same asymmetric-risk call `system-prompt-file.ts`
 * documents: the argv form has worked in production on macOS/Linux for months.
 *
 * NOT changed here, deliberately: the 200,000-byte abstain cap still applies on
 * Windows even though stdin has no argv limit. It is a defensive cap on what is
 * worth sending a reviewer, not only an argv workaround, and loosening it is a
 * separate question from making Windows work at all.
 */

import { BrainError } from "../brain";
import type { BrainFailureInput } from "../failure-classify";
import { nulSafe } from "../nul-safe";

/**
 * Merges the review rubric (`systemPrompt`) and the reviewed diff/code
 * (`contextBundle`) into the single string agy needs — agy has no
 * `--system-prompt`-equivalent flag (AGENTS.md is ignored in `-p` mode), so the
 * rubric and the content being reviewed travel together, whether that is in
 * argv or (on Windows) in one stdin message. The section headers give agy (and
 * any human reading a captured argv) an unambiguous split point rather than a
 * blind concatenation.
 */
export function mergeAgyPrompt(systemPrompt: string, contextBundle: string, plainReply = false): string {
  // The whole merged prompt rides argv[1], diff included — a NUL in either half
  // makes the spawn itself impossible (nul-safe.ts).
  // `plainReply` (dashboard chat, defect [49]): the review headings would tell
  // agy a conversation is a diff to be judged.
  return nulSafe(
    [
      plainReply ? "=== INSTRUCTIONS ===" : "=== SYSTEM PROMPT (Siltpoke review rubric) ===",
      systemPrompt,
      "",
      plainReply ? "=== CONVERSATION ===" : "=== CONTEXT (code/diff under review) ===",
      contextBundle,
    ].join("\n"),
  );
}

/**
 * `--print-timeout` wants a Go-style duration string ("3m", "90s", "1m30s").
 * Derived from timeoutMs so the wall-clock advertised to agy roughly matches
 * the external kill-timer in agy.ts (agy has no separate --timeout flag).
 */
export function formatPrintTimeout(timeoutMs: number): string {
  const totalSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m${seconds}s`;
}

/** The one NDJSON line agy's `stream-json` input format accepts per turn. */
export function agyStreamJsonInput(prompt: string): string {
  return `${JSON.stringify({
    event: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
  })}\n`;
}

/** Flags that replace the argv-borne prompt. `-p=` is the attached-empty form. */
const AGY_STREAM_JSON_FLAGS: readonly string[] = [
  "-p=",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
];

/**
 * The whole `agy` argv, bin first. Extracted from agy.ts's `spawnAgy` to keep
 * that function under the 50-LOC function pin — the pins only move down.
 *
 * `-p=` must stay the FIRST flag on the stream-json path: a bare `-p` made agy
 * read the next flag as its prompt, so anything inserted ahead of
 * `AGY_STREAM_JSON_FLAGS` would reproduce exactly the failure that constant
 * exists to avoid.
 */
export function buildAgyArgv(args: {
  prompt: string;
  streamJson: boolean;
  model?: string;
  printTimeout: string;
  logFilePath?: string;
}): string[] {
  // argv[0] MUST be the binary name — Bun.spawn treats it as the executable.
  // Omitting it made spawn try to exec "-p" (blind-ship bug from #247: the unit
  // test mocked spawnFn and asserted argv[0]==="-p", so no real spawn ever ran).
  // familyBinary("agy")==="agy"; hardcoded here to mirror codex.ts's "codex".
  const argv = args.streamJson
    ? ["agy", ...AGY_STREAM_JSON_FLAGS]
    : ["agy", "-p", args.prompt];
  if (args.model) argv.push("--model", args.model);
  argv.push("--print-timeout", args.printTimeout);
  // Spike (Task 1, committed 5e1b0227) proved `agy -p` WITHOUT --sandbox
  // autonomously browsed a sibling repo and RAN ITS TEST SUITE via pre-granted
  // permissions. --sandbox is therefore NEVER optional — it is hardcoded here,
  // not a caller-configurable option, and must survive every future edit.
  argv.push("--sandbox");
  // Per-call `--log-file` (Task 8 fix): a unique temp path private to THIS
  // subprocess. agy writes a `... Created conversation <uuid>` line there naming
  // exactly the conversation this call created — the reaper reads it for
  // UNAMBIGUOUS attribution (no cwd-cache race; see agy-reaper.ts). If the path
  // is unwritable agy silently falls back to default logging (Task 1 spike) —
  // the reaper then records nothing (safe: an un-recorded conversation is never
  // reaped).
  if (args.logFilePath) argv.push("--log-file", args.logFilePath);
  return argv;
}

interface AgyResultEvent {
  event?: string;
  result?: {
    status?: string;
    response?: string;
    error?: string;
  };
}

/**
 * Pull the reply text out of agy's `stream-json` output.
 *
 * The stream is NDJSON: an `init` event, a `step_update` per step (each carrying
 * a `text_delta`), then a terminal `result` event holding the whole reply in
 * `result.response`. The deltas are deliberately ignored — reassembling them
 * would be a second, drift-prone copy of something the terminal event already
 * states.
 *
 * `status` is gated as well as the exit code. agy's ERROR result did come with a
 * non-zero exit when probed, but an error envelope behind an exit 0 would
 * otherwise be read as a successful empty review, and a reviewer that returns
 * nothing looks exactly like a reviewer that found nothing.
 */
export function parseAgyStreamJson(
  stdout: string,
  ctx: { exitCode: number; stderr: string },
): string {
  // Every throw below carries a `BrainFailureInput`. Without one, `brain-guarded`
  // re-throws a BrainError untouched ("non-subprocess failures … out of
  // classifier scope", brain-guarded.ts:266-268) — so an error envelope behind
  // exit 0 would reach nobody's retry accounting and never latch the breaker.
  // That is the `[28]` shape on a new path, and these ARE subprocess failures:
  // the CLI is reporting its own.
  const failure = (): BrainFailureInput => ({
    exitCode: ctx.exitCode,
    stderr: ctx.stderr.slice(-500),
    stdout: stdout.slice(-500),
  });
  let last: AgyResultEvent["result"] | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: AgyResultEvent;
    try {
      ev = JSON.parse(trimmed) as AgyResultEvent;
    } catch {
      // Unparseable line — noise, never fatal (same tolerance codex.ts's
      // parseEvents applies to its own stream).
      continue;
    }
    if (ev.event === "result" && ev.result !== undefined) last = ev.result;
  }
  if (last === undefined) {
    throw new BrainError(
      "agy -p (stream-json) produced no result event",
      undefined,
      failure(),
    );
  }
  if (last.status !== "SUCCESS") {
    throw new BrainError(
      `agy -p (stream-json) reported ${last.status ?? "no status"}: ${last.error ?? "no error field"}`,
      undefined,
      failure(),
    );
  }
  if (typeof last.response !== "string" || last.response === "") {
    throw new BrainError(
      "agy -p (stream-json) result carried no response text",
      undefined,
      failure(),
    );
  }
  return last.response;
}

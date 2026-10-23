// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Agy adapter (track #7 T2) — cross-family Brain provider for `agy -p`
 * (Antigravity CLI headless mode). Mirrors codex.ts's spawn/kill-timer/
 * injected-spawnFn shape, but diverges where the spike (Task 1, committed
 * 5e1b0227) found agy's real behavior differs:
 *
 *  - argv-only: agy has no stdin path for the prompt — it rides argv[1],
 *    NOT piped stdin (unlike both claude -p and codex exec).
 *  - no `-C`/cwd flag: agy runs in `process.cwd()` and treats it as its
 *    workspace. It is spawned in a fresh EMPTY temp dir, never the reviewed
 *    repo (agy-cwd.ts) — `opts.cwd` is deliberately unused here.
 *  - `--sandbox` is NEVER optional (see spawnAgy below).
 *
 * Task 3 added `mergeAgyPrompt` + the pre-flight argv byte-size gate — agy
 * has no system-prompt flag AND no stdin path, so the rubric + context
 * bundle must ride ONE argv string; a merged prompt over the cap must
 * ABSTAIN (BrainError, never spawn, never truncate-and-review — truncating
 * would silently degrade critic quality).
 *
 * Task 4 (this revision) finishes `call()`'s response parsing:
 *  - Exit-code gate BEFORE any content is trusted: exit 2 is agy's
 *    documented flag/usage-error code (text on STDERR — Task 1 spike
 *    corrected earlier prior research that wrongly assumed stdout); any
 *    other non-zero exit is an unclassified "runtime error" defensive
 *    catch-all (the spike never reproduced a genuine one — agy silently
 *    falls back on a bad model/conversation/project and still exits 0).
 *  - `extractJsonString` fence-strip stays a DEFENSIVE fallback even though
 *    the spike's captured reply (`tests/fixtures/agy/brain-reply.json`) is
 *    bare clean JSON — a heavier model than the spike's low-effort default
 *    may fence its reply.
 *  - agy is quota-billed: `usage` is always all-zero + `total_cost_usd:
 *    null`; `servedModel` is the CONFIGURED `opts.model`, not run-attested
 *    (agy prints no run banner to recover it from, unlike codex's
 *    config.toml fallback).
 * See an internal design note Task 2/3/4.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapAgyConversations, recordAgyConversation } from "../agy-reaper";
import { BrainError, type CallBrainOptions, extractJsonString } from "../brain";
import { drainProcess, stopProcess } from "../drain-process";
import type { BrainFailureInput } from "../failure-classify";
import { type CallRawResult, FAMILY_ACCEPTS_MODEL, type ReviewerBrainProvider } from "../provider";
import { parseBrainOutput } from "../schema";
import {
  agyStreamJsonInput,
  buildAgyArgv,
  formatPrintTimeout,
  mergeAgyPrompt,
  parseAgyStreamJson,
} from "./agy-wire";
import { makeAgyCwd, removeAgyCwd } from "./agy-cwd";

// Re-exported because callers already import it from here — the helper moved to
// agy-wire.ts for the length cap, not to change any caller. `formatPrintTimeout`
// is deliberately NOT re-exported: nothing outside imports it, and a re-export
// with no consumer is dead weight that no gate would catch.
export { mergeAgyPrompt };

/** Same default as brain.ts's (unexported) claude -p timeout — agy -p has
 * comparable fixed overhead to claude -p (unlike codex's heavier ~120s). */
const DEFAULT_AGY_TIMEOUT_MS = 90_000;

/**
 * Pre-flight argv byte-size gate (Task 1 spike finding, committed 5e1b0227):
 * the spike swept 50KB→1MB and ALL sizes spawned successfully — 200KB is a
 * DEFENSIVE cap with headroom (ARG_MAX-safe on macOS), NOT an observed
 * failure threshold. A merged prompt over this cap must ABSTAIN — `call()`
 * returns a BrainError (`code: "agy_prompt_too_large"`) and never spawns.
 * NO truncate-and-review path: truncating the context and reviewing anyway
 * would silently degrade critic quality, which is worse than abstaining.
 */
export const AGY_PROMPT_MAX_BYTES = 200_000;

/**
 * Spawns `agy -p` with the given (already-merged) prompt. Returns the raw
 * exit code + stdout/stderr for the caller to interpret — no parsing here.
 * `streamJson` reports which wire form was actually used, so the caller reads
 * stdout the matching way instead of re-deriving the platform decision.
 */
/**
 * Start the subprocess, turning a spawn-level failure into the structured
 * BrainError the classifier reads. Extracted to keep `spawnAgy` under the 50-LOC
 * function pin (pins only move down), and to mirror codex.ts's `spawnCodex` and
 * ccfork-reviewer.ts's `spawnCcFork`, which exist for the same reason.
 */
function spawnAgyProcess(args: {
  spawnFn: typeof Bun.spawn;
  argv: string[];
  cwd: string | undefined;
  streamJson: boolean;
  // `stdin` is "pipe" on the stream-json path and "ignore" otherwise, so the
  // union is spelled out: it is what makes `proc.stdin` a value the caller has
  // to narrow instead of one it can assume.
}): Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe"> {
  try {
    return args.spawnFn(args.argv, {
      // agy takes the prompt as argv[1] — do NOT pipe contextBundle to stdin
      // (unlike claude -p / codex exec, which both read stdin). The one
      // exception is the win32 stream-json path, where argv cannot carry it and
      // stdin is the whole point.
      stdin: args.streamJson ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      cwd: args.cwd,
      // SILTPOKE_INTERNAL:"1" suppresses siltpoke's own Stop hook on this
      // subprocess (agy-stop.ts:152-159 anticipates exactly this provider);
      // without it, spawning agy as a reviewer would re-fire siltpoke's own Stop
      // hook on itself (infinite recursion risk).
      env: { ...process.env, SILTPOKE_INTERNAL: "1" },
    });
  } catch (err) {
    throw new BrainError(`agy -p spawn failed: ${err}`, err, {
      exitCode: null,
      stderr: "",
      stdout: "",
      spawnError: String(err),
    } satisfies BrainFailureInput);
  }
}

async function spawnAgy(
  prompt: string,
  opts: CallBrainOptions,
  spawnFn: typeof Bun.spawn,
  cwd: string,
  logFilePath?: string,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  streamJson: boolean;
}> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AGY_TIMEOUT_MS;

  // Defect `[26]`: on Windows the prompt cannot ride argv at all, so it moves to
  // stdin as one NDJSON line and the reply comes back as an event stream.
  const streamJson = (opts.platform ?? process.platform) === "win32";
  const argv = buildAgyArgv({
    prompt,
    streamJson,
    model: opts.model,
    printTimeout: formatPrintTimeout(timeoutMs),
    logFilePath,
  });

  const proc = spawnAgyProcess({ spawnFn, argv, cwd, streamJson });

  const killTimer = setTimeout(() => {
    try {
      stopProcess(proc);
    } catch {
      // ignore — process may already have exited
    }
  }, timeoutMs);

  let stdout: string;
  let stderr: string;
  let exitCode: number;
  let settled = false;
  try {
    if (streamJson) {
      // `stdin` is a writable pipe only on this path (`stdin: "ignore"` gives
      // nothing to write to), so it is narrowed rather than asserted. Absent
      // here it must be LOUD: silently skipping the write would leave agy
      // waiting on stdin until the kill-timer, i.e. a timeout standing in for
      // a wiring bug.
      const stdin = proc.stdin;
      if (stdin === undefined) {
        throw new BrainError(
          "agy -p (stream-json) was spawned without a writable stdin — the prompt has nowhere to go",
        );
      }
      // One NDJSON line, then EOF — agy reads stdin until it closes and runs a
      // turn per line, so leaving it open would hang until the kill-timer.
      stdin.write(agyStreamJsonInput(prompt));
      stdin.end();
    }
    // Defect [51]: bounded — a child holding the pipe cannot outlive the timeout.
    ({ stdout, stderr, exitCode } = await drainProcess(proc));
    settled = true;
  } finally {
    clearTimeout(killTimer);
    // Before this file took a stream-json path, nothing inside the try above
    // could throw, so cancelling the timer was the whole cleanup. Now two
    // things can (the stdin guard, and a write to a pipe agy already closed —
    // plausible on win32, where a flag error exits immediately). Cancelling the
    // timer on the way out of a throw would leave a real `agy --sandbox`
    // subprocess running with nobody draining it.
    if (!settled) {
      try {
        stopProcess(proc);
      } catch {
        // ignore — process may already have exited
      }
    }
  }

  return { exitCode, stdout, stderr, streamJson };
}

/**
 * Task 8 — best-effort conversation-DB bookkeeping, run from `callRaw`'s
 * `finally`. Extracted to keep that function under its length pin (pins only
 * move down); the behaviour is unchanged.
 *
 * Runs whether the call succeeded, exited non-zero, or (in `call()`) later fails
 * to parse/validate — agy persists a conversation DB regardless of what siltpoke
 * does with the reply. Each step is individually try/caught (on top of being
 * internally best-effort in agy-reaper.ts) so that even an unanticipated throw
 * here can NEVER mask or replace an exception already in flight from the caller's
 * try block, and can never turn a successful call into a failed one.
 *
 * `recordAgyConversation` reads OUR per-call `--log-file` — race-free attribution
 * (never the shared cwd cache). `reap` then prunes old siltpoke-owned DBs.
 * Finally the temp log is removed so per-call logs don't accumulate (best-effort;
 * if agy fell back to default logging the file may not exist, which
 * `rmSync(force)` tolerates).
 */
function runAgyReaperBookkeeping(agyLogFile: string): void {
  try {
    recordAgyConversation({ logFilePath: agyLogFile });
  } catch {
    // best-effort — must never affect the call's outcome
  }
  try {
    reapAgyConversations();
  } catch {
    // best-effort — must never affect the call's outcome
  }
  try {
    rmSync(agyLogFile, { force: true });
  } catch {
    // best-effort — must never affect the call's outcome
  }
}

/**
 * Primitive (single-brain #10 S2): pre-flight abstain gate → spawn + exit-code
 * gate → raw stdout text, NO schema, NO persona injection. The `finally`
 * reaper (Task 8) wraps the spawn HERE (not in `call()`) so it still runs
 * even when `call()`'s later parse/schema-validation layer throws on top of
 * a `callRaw` result — reaping must never depend on how the caller parses
 * the text.
 */
async function callRaw(opts: CallBrainOptions): Promise<CallRawResult> {
  const spawnFn = opts.spawnFn ?? Bun.spawn;
  const prompt = mergeAgyPrompt(opts.systemPrompt, opts.contextBundle, opts.plainReply);

  // Pre-flight abstain-gate (Task 3) — checked BEFORE spawnAgy is ever
  // called. Buffer.byteLength (not prompt.length) so multi-byte UTF-8
  // content is measured correctly — a char-length check would
  // under-count and let an over-cap prompt slip past the gate.
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes > AGY_PROMPT_MAX_BYTES) {
    // $0 failure — pre-spawn, no `failure` field (not a subprocess
    // failure; spawnFn is never invoked on this path).
    throw new BrainError(
      `agy -p: merged prompt too large (${promptBytes} bytes > ${AGY_PROMPT_MAX_BYTES} byte cap)`,
      undefined,
      undefined,
      "agy_prompt_too_large",
    );
  }

  // Everything from here on made a real `agy -p` attempt (spawnAgy is
  // about to run), so the Task 8 reaper bookkeeping in `finally` below
  // applies to this call regardless of how it resolves — success,
  // exit-code failure, or parse/schema failure. The pre-flight abstain
  // above never spawned anything, so it's excluded (nothing for agy to
  // have logged). `agyLogFile` is a per-call unique temp path passed via
  // `--log-file`; agy names the conversation IT created in that private
  // log, giving the reaper race-free attribution (agy-reaper.ts).
  const agyLogFile = join(
    tmpdir(),
    `siltpoke-agy-${process.pid}-${randomUUID()}.log`,
  );
  const agyCwd = makeAgyCwd();
  try {
    const { exitCode, stdout, stderr, streamJson } = await spawnAgy(
      prompt,
      opts,
      spawnFn,
      agyCwd,
      agyLogFile,
    );

    if (exitCode !== 0) {
      const failure: BrainFailureInput = {
        exitCode,
        stderr: stderr.slice(-500),
        stdout: stdout.slice(-500),
      };
      // Exit-code gate FIRST, always — never trust stdout content over a
      // non-zero exit. Classify for a readable LOG message only (this
      // never affects retry policy, which stays classifyBrainFailure's
      // job): exit 2 = agy's documented flag/usage-error code (Task 1
      // spike: text lands on STDERR); any other non-zero code is an
      // unclassified "runtime error" — a defensive catch-all, since the
      // spike never reproduced a genuine one (agy degrades gracefully on
      // bad model/conversation/project and still exits 0). Both stream
      // tails are captured for the LOG (failure.* + this message) —
      // never for the review: a BrainError never reaches the review
      // surface, since the hard-suppress path it feeds produces no
      // critique.
      const kind = exitCode === 2 ? "flag/usage error" : "runtime error";
      const detail = [stderr.slice(0, 500), stdout.slice(0, 500)]
        .filter((s) => s.length > 0)
        .join(" | ");
      throw new BrainError(
        `agy -p exited with code ${exitCode} (${kind})${detail ? `: ${detail}` : ""}`,
        undefined,
        failure,
      );
    }

    return {
      // On the win32 path stdout is an NDJSON event stream, so the reply text
      // has to be lifted out of the terminal result event; elsewhere stdout IS
      // the reply. Both feed the same downstream parse in `call()`.
      text: streamJson
        ? parseAgyStreamJson(stdout, { exitCode, stderr })
        : stdout,
      // agy is quota-billed (no per-call $ figure) — the spike's captured
      // reply carries no usable token-accounting fields, so usage is
      // always all-zero + cost null (unlike codex's normalizeUsage, which
      // has real fields to read).
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_cost_usd: null,
      },
      // Configured-not-attested (same provenance caveat as codex's
      // config.toml fallback) — agy's stdout carries no served-model field.
      servedModel: opts.model,
    };
  } finally {
    runAgyReaperBookkeeping(agyLogFile);
    removeAgyCwd(agyCwd);
  }
}

export function makeAgyProvider(): ReviewerBrainProvider {
  return {
    meta: {
      name: "agy",
      billing: "quota",
      genAiSystem: "google",
      acceptsModel: FAMILY_ACCEPTS_MODEL.agy,
    },
    callRaw,
    call: async (opts: CallBrainOptions) => {
      const raw = await callRaw(opts);

      // extractJsonString is a DEFENSIVE fallback — the Task 1 spike fixture
      // (tests/fixtures/agy/brain-reply.json) is bare clean JSON with no
      // fence, but a heavier model than the spike's low-effort default may
      // still fence its reply. Provider-tagged error messages (not the
      // shared brainOutputFromText generic ones) — review-path byte-identity
      // requirement, single-brain S2 fix.
      const innerText = extractJsonString(raw.text);
      let inner: unknown;
      try {
        inner = JSON.parse(innerText);
      } catch (err) {
        throw new BrainError(
          "agy -p produced no parseable JSON on stdout",
          err,
          undefined,
          undefined,
          raw.text,
        );
      }

      let output: ReturnType<typeof parseBrainOutput>;
      try {
        output = parseBrainOutput(inner);
      } catch (err) {
        throw new BrainError("agy response failed schema validation", err, undefined, undefined, inner);
      }

      return { output, usage: raw.usage, servedModel: raw.servedModel };
    },
  };
}

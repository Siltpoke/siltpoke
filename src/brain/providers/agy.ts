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
 *  - no `-C`/cwd flag: agy runs in `process.cwd()`, so the reviewed-repo
 *    cwd from CallBrainOptions must reach Bun.spawn's `cwd` option instead
 *    of an argv flag (an unknown flag makes agy exit 2).
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
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BrainError, extractJsonString, type CallBrainOptions } from "../brain";
import { parseBrainOutput } from "../schema";
import type { BrainFailureInput } from "../failure-classify";
import type { CallRawResult, ReviewerBrainProvider } from "../provider";
import { recordAgyConversation, reapAgyConversations } from "../agy-reaper";
import { resolveReviewerCwd } from "./reviewer-cwd";

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
 * Merges the review rubric (`systemPrompt`) and the reviewed diff/code
 * (`contextBundle`) into the single argv string agy requires — agy has no
 * `--system-prompt`-equivalent flag (AGENTS.md is ignored in `-p` mode) and
 * no stdin path (unlike claude -p / codex exec, which both accept the
 * context via a separate channel). The section headers give agy (and any
 * human reading a captured argv) an unambiguous split point between the
 * rubric and the content being reviewed, rather than a blind concatenation.
 */
export function mergeAgyPrompt(systemPrompt: string, contextBundle: string): string {
  return [
    "=== SYSTEM PROMPT (Siltpoke review rubric) ===",
    systemPrompt,
    "",
    "=== CONTEXT (code/diff under review) ===",
    contextBundle,
  ].join("\n");
}

/**
 * `--print-timeout` wants a Go-style duration string ("3m", "90s", "1m30s").
 * Derived from timeoutMs so the wall-clock advertised to agy roughly matches
 * the external kill-timer below (agy has no separate --timeout flag).
 */
export function formatPrintTimeout(timeoutMs: number): string {
  const totalSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m${seconds}s`;
}

/**
 * Spawns `agy -p` with the given (already-merged) prompt. Returns the raw
 * exit code + stdout/stderr for the caller to interpret — no parsing here.
 */
async function spawnAgy(
  prompt: string,
  opts: CallBrainOptions,
  spawnFn: typeof Bun.spawn,
  logFilePath?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AGY_TIMEOUT_MS;
  // brainContext.cwd defaults to "" when the hook payload lacks cwd (same
  // fallback rule codex.ts uses) — an empty cwd must still fall back, never
  // spawn with cwd: "". resolveReviewerCwd warns loudly instead of silently
  // falling back (Task 14 — latent hardening).
  const cwd = resolveReviewerCwd(opts);

  // argv[0] MUST be the binary name — Bun.spawn treats it as the executable.
  // Omitting it made spawn try to exec "-p" (blind-ship bug from #247: the unit
  // test mocked spawnFn and asserted argv[0]==="-p", so no real spawn ever ran).
  // familyBinary("agy")==="agy"; hardcoded here to mirror codex.ts's "codex".
  const argv = ["agy", "-p", prompt];
  if (opts.model) {
    argv.push("--model", opts.model);
  }
  argv.push("--print-timeout", formatPrintTimeout(timeoutMs));
  // Spike (Task 1, committed 5e1b0227) proved `agy -p` WITHOUT --sandbox
  // autonomously browsed a sibling repo and RAN ITS TEST SUITE via
  // pre-granted permissions. --sandbox is therefore NEVER optional — it is
  // hardcoded here, not a caller-configurable option, and must survive every
  // future edit to this file.
  argv.push("--sandbox");
  // Per-call `--log-file` (Task 8 fix): a unique temp path private to THIS
  // subprocess. agy writes a `... Created conversation <uuid>` line here
  // naming exactly the conversation this call created — the reaper reads it
  // for UNAMBIGUOUS attribution (no cwd-cache race; see agy-reaper.ts). If
  // the path is unwritable agy silently falls back to default logging (Task
  // 1 spike) — the reaper then simply records nothing (safe: an un-recorded
  // conversation is never reaped).
  if (logFilePath) {
    argv.push("--log-file", logFilePath);
  }

  const proc = (() => {
    try {
      return spawnFn(argv, {
        // agy takes the prompt as argv[1] — do NOT pipe contextBundle to
        // stdin (unlike claude -p / codex exec, which both read stdin).
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        cwd,
        // SILTPOKE_INTERNAL:"1" suppresses siltpoke's own Stop hook on this
        // subprocess (agy-stop.ts:152-159 anticipates exactly this provider,
        // without it, spawning agy as a reviewer would re-fire
        // siltpoke's own Stop hook on itself (infinite recursion risk).
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
  })();

  const killTimer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // ignore — process may already have exited
    }
  }, timeoutMs);

  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    stdout = await new Response(proc.stdout).text();
    stderr = await new Response(proc.stderr).text();
    exitCode = await proc.exited;
  } finally {
    clearTimeout(killTimer);
  }

  return { exitCode, stdout, stderr };
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
  const prompt = mergeAgyPrompt(opts.systemPrompt, opts.contextBundle);

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
  try {
    const { exitCode, stdout, stderr } = await spawnAgy(
      prompt,
      opts,
      spawnFn,
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
      text: stdout,
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
    // Task 8 — best-effort conversation-DB bookkeeping. Runs whether the
    // call above succeeded, exited non-zero, or (in `call()`) later fails
    // to parse/validate — agy persists a conversation DB regardless of
    // what siltpoke does with the reply. Each step is individually
    // try/caught (on top of being internally best-effort in
    // agy-reaper.ts) so that even an unanticipated throw here can NEVER
    // mask/replace an exception already in flight from the try block
    // above, and can never turn a successful call into a failed one.
    //
    // recordAgyConversation reads OUR per-call `--log-file` (agyLogFile)
    // — race-free attribution (never the shared cwd cache). reap then
    // prunes old siltpoke-owned DBs. Finally the temp log is removed so
    // per-call logs don't accumulate (best-effort; if agy fell back to
    // default logging the file may not exist, which rmSync(force) tolerates).
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
}

export function makeAgyProvider(): ReviewerBrainProvider {
  return {
    meta: { name: "agy", billing: "quota", genAiSystem: "google" },
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

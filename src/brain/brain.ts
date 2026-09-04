// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import type { BrainFailureInput } from "./failure-classify";
import { type BrainOutput, parseBrainOutput, describeSchemaIssues } from "./schema";

export interface CallBrainOptions {
  systemPrompt: string;
  contextBundle: string;
  model?: string;
  timeoutMs?: number;
  spawnFn?: typeof Bun.spawn;
  /**
   * Reviewed-repo cwd (track #7 T3) — the daemon's own process.cwd() is
   * frozen at daemon-launch time and is NOT the repo being reviewed. The
   * claude -p path ignores this (claude reads no cwd-relative args); the
   * codex adapter passes it to `-C` so `--skip-git-repo-check`-adjacent
   * repo-relative behavior targets the right tree.
   */
  cwd?: string;
}

export interface BrainUsage {
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number | null;
}

export interface BrainCallResult {
  output: BrainOutput;
  usage: BrainUsage;
  /**
   * Served model string (track #7 T3, AC7). Optional so unrelated callers
   * (chat/explain/etc — this field predates their migration) are unaffected;
   * populated by ReviewerBrainProvider.call() implementations.
   */
  servedModel?: string;
}

export interface BrainCallRawResult {
  output: unknown;
  usage: BrainUsage;
}

export class BrainError extends Error {
  /**
   * Structured subprocess-failure fields for the pure classifier.
   * Set ONLY at spawn/exit failure sites — schema
   * validation and JSON-parse failures leave it undefined (out of
   * classifier scope; they are not subprocess failures).
   */
  public readonly failure?: BrainFailureInput;
  /**
   * Machine-readable code for callers that need to branch on WHY a call
   * failed without parsing message text (track #7 T4 fixup) — lets a
   * quota-cap skip surface as an honest `skipped: "quota_cap"` telemetry
   * row instead of a generic HARD_SUPPRESS free-text reason. Set ONLY at
   * the one pre-spawn site that throws before any subprocess is spawned
   * (brain-guarded.ts's quota-cap check); a real spawn/classify failure —
   * including the throttle-retry's re-thrown enriched first error — never
   * carries this code. Optional, backward-compatible: existing BrainError
   * call sites that omit the 4th arg are unaffected.
   *
   * `"agy_prompt_too_large"` (track #7 T3): set ONLY at the agy provider's
   * pre-spawn argv byte-size gate (`agy.ts`'s `call()`, before `spawnAgy` is
   * ever invoked) — same "pre-spawn, no subprocess ran" shape as
   * `quota_cap`, so `failure` stays undefined on this code too.
   */
  public readonly code?: "quota_cap" | "agy_prompt_too_large";

  /**
   * The model's reply, as it arrived, when the failure was the reply being
   * REJECTED — a JSON-parse failure (the raw text) or a schema failure (the
   * parsed object). Set at those sites only.
   *
   * `undefined` — never `""` or `{}` — on a failure where no reply exists: a
   * spawn/exit/timeout failure. On a dashboard an empty string reads exactly
   * like "the model returned nothing", which is a different claim and a false
   * one. `failure`/`code` mark those cases and never co-occur with this.
   *
   * NOT "absent": `useDefineForClassFields` is on (tsconfig `target: ESNext`),
   * so the declaration defines the own property before the constructor body
   * runs. Measured: `"rawResponse" in new BrainError("x")` is `true` and
   * `Object.keys` lists it. A guarded assignment does not change that, so there
   * is none — read the VALUE, never the key's presence.
   *
   * SCOPE — the review path only, and that is not cosmetic: a consumer keying
   * off this field to decide "no reply existed" would be wrong about
   * `reflection.ts` and `summarizer.ts` if they did not set it, so they do.
   *
   * WHY IT IS A FIELD AND NOT IN THE MESSAGE. #647 keeps the message to
   * `path:code` precisely so reviewed source never lands in a log line, which
   * is also why the span input is redacted. This carries the reply on a channel
   * the trace writer can redact and clip (`tracer.setOutput` caps at 8 KB and
   * spills the rest), instead of on the string everything logs verbatim.
   */
  public readonly rawResponse?: unknown;

  constructor(
    message: string,
    public readonly cause?: unknown,
    failure?: BrainFailureInput,
    code?: "quota_cap" | "agy_prompt_too_large",
    rawResponse?: unknown,
  ) {
    super(message);
    this.name = "BrainError";
    this.failure = failure;
    this.code = code;
    this.rawResponse = rawResponse;
  }
}

/** Exported so span writers can record gen_ai.request.model honestly. */
export const DEFAULT_MODEL = "claude-haiku-4-5";
/**
 * The kill timer for one `claude -p` call, and the env var that moves it.
 *
 * The constant is unchanged — the knob defaults to exactly the value that has
 * always been in force, so its existence changes nothing on its own.
 *
 * It exists because the number could not be questioned without editing code.
 * `CallBrainOptions.timeoutMs` was a seam neither critic phase passed, and
 * nothing read an env var or config key, which is also the stated reason an
 * acceptance test sits skipped ("timeoutMs is never plumbed from config/env
 * through to CallBrainOptions on the critic seam"). Measured across
 * `~/.siltpoke/traces/` (n=3809): the critic call's median is 31.4s, its
 * uncapped tail reaches 87.8s, and 6% of calls end at 90.5–90.7s — the timer
 * firing, not a workload that lands there by coincidence. Whether those calls
 * would finish in 91s or in 400s decides whether raising the cap helps, and
 * that cannot be measured while the cap is a literal.
 */
export const DEFAULT_TIMEOUT_MS = 90_000;
export const BRAIN_TIMEOUT_ENV = "SILTPOKE_BRAIN_TIMEOUT_MS";
/** Sane band. Below this a call cannot finish; above it a hung subprocess
 *  outlives any session it belongs to. A typo (a missing or extra zero) lands
 *  outside and falls back rather than silently disabling the timer. */
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * Precedence: an explicit caller argument, then the env var, then the default.
 *
 * Explicit wins because a caller that passed a number decided deliberately
 * (`run-diff-summary`, test seams) and an environment set for one experiment
 * must not retune it behind its back. Anything unparseable or out of band
 * falls back to the default — never to `0` or `NaN`, which would respectively
 * kill every call instantly or never fire at all.
 */
export function resolveBrainTimeoutMs(explicitMs?: number): number {
  if (explicitMs !== undefined) return explicitMs;
  const raw = process.env[BRAIN_TIMEOUT_ENV];
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  // Integer only, and the whole string must be digits: `Number("12.5")` is a
  // finite 12.5 and `parseInt("1e5x")` is 1 — both would pass a laxer check
  // and set a timer nobody asked for.
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_TIMEOUT_MS;
  const ms = Number(raw.trim());
  if (ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS) return DEFAULT_TIMEOUT_MS;
  return ms;
}

// `claude -p --output-format json` stream shapes + the result-event parsing
// helpers below are shared verbatim with reflection.ts's callReflection,
// which drives the same `claude -p` CLI. Exported so reflection.ts imports
// them instead of keeping its own byte-identical copies.
export interface ResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  error?: string;
  total_cost_usd?: number;
  usage?: {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface ClaudeStreamEvent {
  type: string;
  [key: string]: unknown;
}

const FENCED_JSON = /```(?:json)?\s*([\s\S]*?)\s*```/;

export function extractJsonString(text: string): string {
  const match = text.match(FENCED_JSON);
  return match ? match[1]?.trim() : text.trim();
}

export function findResultEvent(events: ClaudeStreamEvent[]): ResultEvent {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === "result") return ev as unknown as ResultEvent;
  }
  throw new BrainError("claude -p stream contained no result event");
}

export function extractUsage(resultEvent: ResultEvent): BrainUsage {
  const u = resultEvent.usage ?? {};
  return {
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    total_cost_usd: resultEvent.total_cost_usd ?? null,
  };
}

/**
 * Shared spawn+collect for both brain call variants: runs `claude -p`, parses
 * the stream events, and returns the model's raw result text + usage. Callers
 * decide how to interpret the text (`callBrainRaw` JSON-parses it;
 * `callBrainText` returns it as-is). Never JSON-parses the inner result — that
 * is the caller's concern.
 */
export async function runBrainCall(
  opts: CallBrainOptions,
): Promise<{ resultText: string; usage: BrainUsage }> {
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = resolveBrainTimeoutMs(opts.timeoutMs);
  const spawn = opts.spawnFn ?? Bun.spawn;

  const proc = (() => {
    try {
      return spawn(
        [
          "claude",
          "-p",
          "--model",
          model,
          "--system-prompt",
          opts.systemPrompt,
          "--output-format",
          "json",
          "--no-session-persistence",
        ],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, SILTPOKE_INTERNAL: "1" },
        },
      );
    } catch (err) {
      // Spawn-level failure (ENOENT binary missing, EAGAIN process pressure):
      // carry the structured fields so the classifier sees the spawn error.
      throw new BrainError(`claude -p spawn failed: ${err}`, err, {
        exitCode: null,
        stderr: "",
        stdout: "",
        spawnError: String(err),
      });
    }
  })();

  proc.stdin.write(opts.contextBundle);
  proc.stdin.end();

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

  if (exitCode !== 0) {
    // Classifier examines BOTH tails — with --output-format json,
    // claude -p errors can land on stdout while stderr stays empty.
    throw new BrainError(
      `claude -p exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
      undefined,
      {
        exitCode,
        stderr: stderr.slice(-500),
        stdout: stdout.slice(-500),
      },
    );
  }

  let events: ClaudeStreamEvent[];
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) {
      throw new BrainError("claude -p stdout was not a JSON array");
    }
    events = parsed as ClaudeStreamEvent[];
  } catch (err) {
    if (err instanceof BrainError) throw err;
    throw new BrainError("claude -p stdout was not valid JSON", err);
  }

  const resultEvent = findResultEvent(events);

  if (resultEvent.is_error || !resultEvent.result) {
    throw new BrainError(
      `claude -p reported an error: ${resultEvent.error ?? resultEvent.subtype ?? "no result field"}`,
    );
  }

  return { resultText: resultEvent.result, usage: extractUsage(resultEvent) };
}

export async function callBrainRaw(
  opts: CallBrainOptions,
): Promise<BrainCallRawResult> {
  const { resultText, usage } = await runBrainCall(opts);
  const innerText = extractJsonString(resultText);

  let inner: unknown;
  try {
    inner = JSON.parse(innerText);
  } catch (err) {
    // `resultText`, not `innerText`: `extractJsonString` already tried to find
    // a JSON block, and when it fails the prose AROUND the block is the whole
    // diagnostic — an extraction fix has to be written against what the model
    // really sent, not against what the extractor managed to salvage.
    throw new BrainError(
      "Brain response was not valid JSON; possibly hallucinated prose around it",
      err,
      undefined,
      undefined,
      resultText,
    );
  }

  return { output: inner, usage };
}

/**
 * Plain-text variant of `callBrainRaw` — returns the model's raw result text
 * without JSON-parsing it. For prompts whose answer is a single line of prose
 * (e.g. a one-sentence recap), where forcing a strict-JSON envelope makes a
 * small model unreliable. The caller sanitizes the text itself.
 */
export async function callBrainText(
  opts: CallBrainOptions,
): Promise<{ text: string; usage: BrainUsage }> {
  const { resultText, usage } = await runBrainCall(opts);
  return { text: resultText.trim(), usage };
}

export async function callBrain(
  opts: CallBrainOptions,
): Promise<BrainCallResult> {
  const raw = await callBrainRaw(opts);
  let output: BrainOutput;
  try {
    output = parseBrainOutput(raw.output);
  } catch (err) {
    // The generic prefix is load-bearing: `audit-absence.ts` classifies this
    // failure by `reason.includes("failed schema validation")`. The detail is
    // appended, never substituted — same contract as the parse-raw site.
    // The reply itself, whole. Zod's `invalid_type` names the field but not the
    // value it received, so the message alone cannot tell you whether `file`
    // was a number, a null, or an object — and the fields AROUND the bad one
    // decide whether a per-field coercion could have salvaged the review.
    throw new BrainError(
      `Brain response failed schema validation${describeSchemaIssues(err)}`,
      err,
      undefined,
      undefined,
      raw.output,
    );
  }
  return { output, usage: raw.usage };
}

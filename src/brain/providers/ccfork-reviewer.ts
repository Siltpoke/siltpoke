// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * CC-fork reviewer factory — turns a Claude-Code-fork headless CLI (Qoder,
 * CodeBuddy) into a cross-family Brain reviewer provider. "CC-fork" = the
 * CLI/config SURFACE is a Claude-Code fork; the MODEL is not Anthropic
 * (Qwen/GLM/Kimi/DeepSeek for qoder; Gemini/GPT/DeepSeek for codebuddy) — a
 * genuinely cross-family reviewer.
 *
 * Simpler than agy.ts because the CC-fork surface is claude-like:
 *  - stdin carries the reviewed context (no argv size cap, no size-gate).
 *  - `--system-prompt` carries the rubric (like claude -p).
 *  - `-p --output-format json` yields a claude-SHAPED `type:"result"` event
 *    `{type:"result", is_error, result, usage, ...}` — but the WRAPPER differs
 *    per fork: qoder returns that as ONE object; codebuddy returns claude's
 *    full ARRAY of events with the result event last (verified live
 *    2026-07-11). `parseCcForkEnvelope` normalizes both, then we reuse
 *    extractJsonString + parseBrainOutput. Both a non-zero exit AND
 *    `is_error:true` / no result event are failures.
 *  - `--tools ""` disables all built-in tools (read-only reviewer posture).
 *  - No cross-family-honesty warn (no Claude model in either list), no reaper
 *    unless the spike found unbounded session growth (deferred, not here).
 * See an internal design note
 */
import {
  BrainError,
  extractJsonString,
  type BrainUsage,
  type CallBrainOptions,
} from "../brain";
import { parseBrainOutput } from "../schema";
import type { BrainFailureInput } from "../failure-classify";
import type { BrainProviderMeta, CallRawResult, ReviewerBrainProvider } from "../provider";
import { recordQoderSession, reapQoderSessions } from "../qoder-reaper";
import { resolveReviewerCwd } from "./reviewer-cwd";

/** Comparable fixed overhead to claude -p (unlike codex's heavier ~120s). */
const DEFAULT_CCFORK_TIMEOUT_MS = 90_000;

export interface CcForkReviewerConfig {
  name: "qoder" | "codebuddy";
  bin: string;
  genAiSystem: string;
  defaultTimeoutMs?: number;
  /** Full argv (bin first) EXCLUDING the reviewed context, which rides stdin.
   * `--model` is omitted when `model` is undefined (qoder rejects the literal
   * "default"; omitting lets the CLI use its account default). */
  buildArgv(args: { systemPrompt: string; model?: string }): string[];
}

interface CcForkEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  error?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Find the terminal `type:"result"` event in a claude-shaped array-of-events
 * stream (codebuddy). Searches from the end — the result event is last. */
function findCcForkResultEvent(events: unknown[]): CcForkEnvelope | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (typeof ev === "object" && ev !== null && (ev as CcForkEnvelope).type === "result") {
      return ev as CcForkEnvelope;
    }
  }
  return undefined;
}

/**
 * Parse a CC-fork `-o json` reply into its result event. Two real shapes,
 * despite the shared flag surface:
 *  - **qoder** returns a SINGLE object `{type:"result", …}`.
 *  - **codebuddy** returns claude's ARRAY of events `[…, {type:"result", …}]`
 *    (verified live 2026-07-11 — the account-429 that blocked the #249 fixture
 *    had masked this; #249's "same single envelope as qoder" assumption was
 *    wrong). The result event's inner fields are identical across both.
 * Throws BrainError on non-JSON, no result event, `is_error:true`, or a
 * missing `result` string — content is never trusted past any gate. Usage is
 * quota (cost always null; tokens best-effort, zeros when absent).
 */
export function parseCcForkEnvelope(
  stdout: string,
  name: string,
): { result: string; usage: BrainUsage } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new BrainError(`${name} -p produced no parseable JSON envelope on stdout`, err);
  }
  const env: CcForkEnvelope | undefined = Array.isArray(parsed)
    ? findCcForkResultEvent(parsed)
    : typeof parsed === "object" && parsed !== null && (parsed as CcForkEnvelope).type === "result"
      ? (parsed as CcForkEnvelope)
      : undefined;
  if (env === undefined) {
    throw new BrainError(`${name} -p returned a non-result envelope`);
  }
  if (env.is_error || typeof env.result !== "string") {
    throw new BrainError(
      `${name} -p reported an error: ${env.error ?? env.subtype ?? "no result field"}`,
    );
  }
  const u = env.usage ?? {};
  return {
    result: env.result,
    usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      total_cost_usd: null, // quota billing — never a fabricated dollar figure
    },
  };
}

/**
 * qoder-ONLY best-effort session reaper, invoked from callRaw's `finally`.
 * Every `qodercli -p` call persists an unbounded session under
 * `~/.qoder/projects/<cwd-key>/` (spike Step 4(d)); this records THIS call's
 * own `session_id` (parsed from its envelope on stdout — race-free per-call
 * attribution, see qoder-reaper.ts) and prunes old siltpoke-owned sessions.
 * codebuddy is deliberately NOT gated in: its `~/.codebuddy` session growth
 * was never characterized by a spike, so it stays out of scope (no reaper on
 * an un-characterized store). Each step is individually try/caught (on top of
 * being internally best-effort in qoder-reaper.ts) so an unanticipated throw
 * here can NEVER mask an exception already in flight from callRaw's try, nor
 * turn a successful call into a failure.
 */
function runQoderSessionReaper(configName: string, stdout: string): void {
  if (configName !== "qoder") return;
  try {
    recordQoderSession({ stdout });
  } catch {
    // best-effort — must never affect the call's outcome
  }
  try {
    reapQoderSessions();
  } catch {
    // best-effort — must never affect the call's outcome
  }
}

export function makeCcForkReviewerProvider(config: CcForkReviewerConfig): ReviewerBrainProvider {
  const callRaw = async (opts: CallBrainOptions): Promise<CallRawResult> => {
    const spawnFn = opts.spawnFn ?? Bun.spawn;
    const timeoutMs = opts.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_CCFORK_TIMEOUT_MS;
    // brainContext.cwd defaults to "" when the hook payload lacks cwd — an
    // empty cwd must fall back, never spawn with cwd: "". resolveReviewerCwd
    // warns loudly instead of silently falling back (Task 14 — latent
    // hardening).
    const cwd = resolveReviewerCwd(opts);
    const argv = config.buildArgv({ systemPrompt: opts.systemPrompt, model: opts.model });

    const proc = (() => {
      try {
        return spawnFn(argv, {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          cwd,
          // Recursion guard — these CLIs are also hosts; their own Stop hook
          // could re-fire siltpoke's review on this subprocess.
          env: { ...process.env, SILTPOKE_INTERNAL: "1" },
        });
      } catch (err) {
        throw new BrainError(`${config.bin} -p spawn failed: ${err}`, err, {
          exitCode: null,
          stderr: "",
          stdout: "",
          spawnError: String(err),
        } satisfies BrainFailureInput);
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

    try {
      // Exit-code gate FIRST — never trust stdout content over a non-zero exit.
      if (exitCode !== 0) {
        const failure: BrainFailureInput = {
          exitCode,
          stderr: stderr.slice(-500),
          stdout: stdout.slice(-500),
        };
        const detail = [stderr.slice(0, 500), stdout.slice(0, 500)].filter((s) => s.length > 0).join(" | ");
        throw new BrainError(
          `${config.bin} -p exited with code ${exitCode}${detail ? `: ${detail}` : ""}`,
          undefined,
          failure,
        );
      }

      // Envelope gate SECOND (is_error / non-result / missing result all throw).
      const { result, usage } = parseCcForkEnvelope(stdout, config.name);

      // servedModel = configured (configured-not-attested, same as codex/agy).
      return { text: result, usage, servedModel: opts.model };
    } finally {
      // Best-effort qoder session bookkeeping — extracted so callRaw's own
      // control flow stays flat. Runs whether the call above returned,
      // exited non-zero, or threw on the envelope gate (qoder persists a
      // session regardless of what siltpoke does with the reply).
      runQoderSessionReaper(config.name, stdout);
    }
  };
  return {
    meta: {
      name: config.name,
      billing: "quota",
      genAiSystem: config.genAiSystem,
    },
    callRaw,
    call: async (opts: CallBrainOptions) => {
      const raw = await callRaw(opts);

      // extractJsonString is a defensive fence-strip — a heavier model may
      // fence its reply. Provider-tagged error messages (`${config.name}`,
      // not the shared brainOutputFromText generic ones) — review-path
      // byte-identity requirement, single-brain S2 fix.
      const innerText = extractJsonString(raw.text);
      let inner: unknown;
      try {
        inner = JSON.parse(innerText);
      } catch (err) {
        throw new BrainError(`${config.name} response was not valid JSON`, err, undefined, undefined, raw.text);
      }
      let output: ReturnType<typeof parseBrainOutput>;
      try {
        output = parseBrainOutput(inner);
      } catch (err) {
        throw new BrainError(`${config.name} response failed schema validation`, err, undefined, undefined, inner);
      }

      return { output, usage: raw.usage, servedModel: raw.servedModel };
    },
  };
}

/** Qoder (`qodercli`) — Alibaba/Qwen family. */
export function makeQoderProvider(): ReviewerBrainProvider {
  return makeCcForkReviewerProvider({
    name: "qoder",
    bin: "qodercli",
    genAiSystem: "alibaba",
    buildArgv: ({ systemPrompt, model }) => {
      const argv = [
        "qodercli",
        "-p",
        "--system-prompt",
        systemPrompt,
        "--output-format",
        "json",
        // Read-only reviewer posture — empty variadic disables all built-in tools.
        "--tools",
        "",
      ];
      if (model) argv.push("--model", model);
      return argv;
    },
  });
}

/** CodeBuddy (`codebuddy`) — Tencent family. `codebuddy --help` mirrors qoder's
 * flag surface: `-p`, `--output-format json`, `--system-prompt <prompt>`,
 * `--tools ""` (read-only posture), `--model <id>`. Its `--model` menu
 * (gemini-3.1-pro / gpt-5.5 / deepseek-v3-2-volc / glm-5.0 / kimi-k2.5) has
 * ZERO Claude-family entries, so it's structurally cross-family — no honesty
 * warn needed. The flags match qoder but the `--output-format json` WRAPPER
 * does NOT: codebuddy emits claude's array-of-events (result event last),
 * where qoder emits a single result object. #249 shipped assuming they
 * matched (built blind — the account 429 blocked a real fixture); the live
 * smoke on 2026-07-11 (credits restored) caught the divergence, fixed in
 * `parseCcForkEnvelope`. Real fixture: `tests/fixtures/codebuddy/`. */
export function makeCodeBuddyProvider(): ReviewerBrainProvider {
  return makeCcForkReviewerProvider({
    name: "codebuddy",
    bin: "codebuddy",
    genAiSystem: "tencent",
    buildArgv: ({ systemPrompt, model }) => {
      const argv = [
        "codebuddy",
        "-p",
        "--system-prompt",
        systemPrompt,
        "--output-format",
        "json",
        // Read-only reviewer posture — empty variadic disables all built-in tools.
        "--tools",
        "",
      ];
      if (model) argv.push("--model", model);
      return argv;
    },
  });
}

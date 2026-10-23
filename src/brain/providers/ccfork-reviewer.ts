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
  type BrainUsage,
  type CallBrainOptions,
  extractJsonString,
} from "../brain";
import { drainProcess, stopProcess } from "../drain-process";
import type { BrainFailureInput } from "../failure-classify";
import {
  type BrainProviderMeta,
  type CallRawResult,
  FAMILY_ACCEPTS_MODEL,
  type ReviewerBrainProvider,
} from "../provider";
import { reapQoderSessions, recordQoderSession } from "../qoder-reaper";
import { parseBrainOutput } from "../schema";
import { systemPromptArgs } from "../system-prompt-file";
import { resolveReviewerCwd } from "./reviewer-cwd";

/** Comparable fixed overhead to claude -p (unlike codex's heavier ~120s). */
const DEFAULT_CCFORK_TIMEOUT_MS = 90_000;

export interface CcForkReviewerConfig {
  name: "qoder" | "codebuddy";
  bin: string;
  genAiSystem: string;
  defaultTimeoutMs?: number;
  /**
   * Does this CLI accept `--system-prompt-file`? Declared per fork, never
   * inferred from the family (defect `[26]`).
   *
   * `codebuddy` is true because its `--help` was read on a real machine and
   * lists the flag.
   *
   * `qoder` is true as of 2026-09-26, and the evidence is NOT its `--help`,
   * which does not mention the flag at all. `qodercli` 1.1.1's own bundle
   * declares it and hides it:
   *
   *   .addOption(new pT("--system-prompt-file <path>").hideHelp())
   *
   * sitting in the same option chain as `--system-prompt <text>`. Confirmed
   * against the running binary: passing `--system-prompt-file <path>` gets as
   * far as the model (it then fails on the account's credit limit, error_code
   * 118), exactly like the documented `--system-prompt`, while a flag that does
   * not exist makes qodercli print its usage and exit 1. So the flip is a
   * measurement, not the family guess this field was created to prevent.
   *
   * Still NOT established: that the flag DELIVERS the prompt to the model. The
   * credit limit blocks any real turn, so this shares codebuddy's grade — the
   * CLI's own declared interface, never exercised end-to-end, never on Windows.
   */
  supportsSystemPromptFile: boolean;
  /** Full argv (bin first) EXCLUDING the reviewed context, which rides stdin.
   * `systemPromptArgs` is the already-built fragment — either
   * `--system-prompt <text>` or `--system-prompt-file <path>`; the caller owns
   * that choice and the temp file's lifetime.
   * `--model` is omitted when `model` is undefined (qoder rejects the literal
   * "default"; omitting lets the CLI use its account default). */
  buildArgv(args: { systemPromptArgs: readonly string[]; model?: string }): string[];
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

/**
 * Spawn the fork's CLI, converting a spawn-level failure into the structured
 * BrainError the classifier reads.
 *
 * Extracted to keep `callRaw` under its length pin; `cleanup` runs here because
 * this throw leaves before the caller's `finally` is armed, and defect `[26]`'s
 * temp file must not linger.
 */
function spawnCcFork(args: {
  spawnFn: typeof Bun.spawn;
  argv: string[];
  cwd: string | undefined;
  bin: string;
  cleanup: () => void;
}): Bun.Subprocess<"pipe", "pipe", "pipe"> {
  try {
    return args.spawnFn(args.argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: args.cwd,
      // Recursion guard — these CLIs are also hosts; their own Stop hook could
      // re-fire siltpoke's review on this subprocess.
      env: { ...process.env, SILTPOKE_INTERNAL: "1" },
    });
  } catch (err) {
    args.cleanup();
    throw new BrainError(`${args.bin} -p spawn failed: ${err}`, err, {
      exitCode: null,
      stderr: "",
      stdout: "",
      spawnError: String(err),
    } satisfies BrainFailureInput);
  }
}

/**
 * argv plus the temp-file lifetime that may come with it (defect `[26]`): on
 * Windows the system prompt moves out of argv into a file, and whoever builds
 * the argv also owns deleting that file.
 */
function buildArgvWithPrompt(
  config: CcForkReviewerConfig,
  opts: CallBrainOptions,
): { argv: string[]; cleanup: () => void } {
  const promptArgs = systemPromptArgs(opts.systemPrompt, {
    supportsFile: config.supportsSystemPromptFile,
    platform: opts.platform,
  });
  return {
    argv: config.buildArgv({ systemPromptArgs: promptArgs.args, model: opts.model }),
    cleanup: promptArgs.cleanup,
  };
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
    const { argv, cleanup } = buildArgvWithPrompt(config, opts);

    const proc = spawnCcFork({ spawnFn, argv, cwd, bin: config.bin, cleanup });

    let stdout: string;
    let stderr: string;
    let exitCode: number;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Inside the try: a throw from the stdin write used to land between the
      // spawn's cleanup and this finally, leaking the prompt file (defect
      // `[26]`'s temp file) once per review. Mirrors brain.ts.
      proc.stdin.write(opts.contextBundle);
      proc.stdin.end();

      killTimer = setTimeout(() => {
        try {
          stopProcess(proc);
        } catch {
          // ignore — process may already have exited
        }
      }, timeoutMs);

      // Defect [51]: bounded — a child holding the pipe cannot outlive the timeout.
      ({ stdout, stderr, exitCode } = await drainProcess(proc));
    } finally {
      if (killTimer !== undefined) clearTimeout(killTimer);
      cleanup();
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
      // Both ccfork builds push `--model` in buildArgv when a model is set
      // (omitted when undefined — qoder rejects the literal).
      acceptsModel: FAMILY_ACCEPTS_MODEL[config.name],
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

/** Qoder (`qodercli`) — Alibaba/Qwen family. `--system-prompt-file` is a real but
 * `.hideHelp()`-ed option in qodercli 1.1.1; see `supportsSystemPromptFile`. */
export function makeQoderProvider(): ReviewerBrainProvider {
  return makeCcForkReviewerProvider({
    name: "qoder",
    bin: "qodercli",
    genAiSystem: "alibaba",
    supportsSystemPromptFile: true,
    buildArgv: ({ systemPromptArgs, model }) => {
      const argv = [
        "qodercli",
        "-p",
        ...systemPromptArgs,
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
    supportsSystemPromptFile: true,
    buildArgv: ({ systemPromptArgs, model }) => {
      const argv = [
        "codebuddy",
        "-p",
        ...systemPromptArgs,
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

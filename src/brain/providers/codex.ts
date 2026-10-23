// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Codex adapter (track #7 T2) — cross-family Brain provider for `codex exec`.
 *
 * Mirrors brain.ts's runBrainCall shape (spawnFn seam, external kill-timer,
 * BrainError-on-failure) but parses codex's `--json` JSONL event stream
 * instead of claude -p's single result envelope. See spec §2 + Revision
 * pass items 1-3:
 * an internal design note
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrainCallResult,
  BrainError,
  type BrainUsage,
  type CallBrainOptions,
  extractJsonString,
} from "../brain";
import { drainProcess, stopProcess } from "../drain-process";
import type { BrainFailureInput } from "../failure-classify";
import { type CallRawResult, FAMILY_ACCEPTS_MODEL, type ReviewerBrainProvider } from "../provider";
import { parseBrainOutput } from "../schema";
import {
  type DeveloperInstructionsArgs,
  developerInstructionsArgs,
} from "./codex-instructions";
import { codexSandboxArgs } from "./codex-sandbox";
import {
  schemaFilePath,
  stripNulls,
  toOpenAiStrictSchema,
} from "./codex-schema";
import { codexToolCalls, type ToolCallRecord } from "../tool-calls";
import { resolveReviewerCwd } from "./reviewer-cwd";

// Re-exported because a test already imports it from here; the schema helpers
// moved to codex-schema.ts for the 400-line cap, not to change any caller.
export { toOpenAiStrictSchema };

/** codex has no native wall-clock timeout; fixed overhead is higher than
 * claude -p's, so the external kill-timer default is longer (spec §2). */
const DEFAULT_CODEX_TIMEOUT_MS = 120_000;
/** Revision-pass item 1: argv-size guard, well under macOS's ~256KB/arg. */
const MAX_SYSTEM_PROMPT_CHARS = 200_000;
/** The --json stream carries no model field and suppresses the human
 * banner on stderr (live-verified 2026-07-07: stderr is empty). The banner
 * parse stays as an opportunistic first source in case a future codex build
 * emits it; the practical source is the config.toml fallback below. */
const MODEL_BANNER_RE = /^model:\s*(\S.*)$/m;
/** `~/.codex/config.toml` `model = "..."` — when no model is chosen in Siltpoke
 * no `-m` is passed, so the configured model IS what the run serves. Provenance caveat:
 * this is the CONFIGURED model, not run-attested; OpenAI can still rotate
 * what the name maps to server-side. */
const CODEX_CONFIG_MODEL_RE = /^model\s*=\s*"([^"]+)"/m;

interface CodexUsageRaw {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexEvent {
  type: string;
  item?: { id?: string; type?: string; text?: string };
  usage?: CodexUsageRaw;
  error?: { message?: string };
  message?: string;
}

/** Parse stdout line-by-line, tolerating blank/unparseable/unknown-type
 * lines (revision-pass item 3 — never crash on stream drift). */
function parseEvents(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as CodexEvent);
    } catch {
      // unparseable line — ignore, treat as noise
    }
  }
  return events;
}

function lastAgentMessage(events: CodexEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === "item.completed" && ev.item?.type === "agent_message") {
      return ev.item.text;
    }
  }
  return undefined;
}

/** Prefers the canonical `turn.failed` shape; falls back to a top-level
 * `error` event only when no `turn.failed` is present. */
function turnFailedMessage(events: CodexEvent[]): string | undefined {
  const failed = events.find((ev) => ev.type === "turn.failed");
  if (failed) return failed.error?.message ?? "";
  const err = events.find((ev) => ev.type === "error");
  if (err) return err.message ?? "";
  return undefined;
}

/** AC6: codex `input_tokens` is INCLUSIVE of `cached_input_tokens` —
 * normalize to the Anthropic-shaped exclusive BrainUsage. Missing usage
 * (AC contingency) => zeros, never fabricated. */
function normalizeUsage(events: CodexEvent[]): BrainUsage {
  const raw = events.find((ev) => ev.type === "turn.completed")?.usage;
  if (!raw) {
    return {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_cost_usd: null,
    };
  }
  const cached = raw.cached_input_tokens ?? 0;
  const inputTotal = raw.input_tokens ?? 0;
  return {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    // Clamp: cached > total would mean the inclusive-subset assumption broke
    // upstream — never let a negative count reach the ledger.
    input_tokens: Math.max(0, inputTotal - cached),
    // output_tokens is INCLUSIVE of reasoning_output_tokens (live-verified
    // 2026-07-07: output 63 = reasoning 56 + ~7 visible) — use as-is.
    output_tokens: raw.output_tokens ?? 0,
    total_cost_usd: null, // quota billing — never a dollar figure
  };
}

function servedModelFromStderr(stderr: string): string | undefined {
  return stderr.match(MODEL_BANNER_RE)?.[1]?.trim();
}

/** Fallback servedModel source — see CODEX_CONFIG_MODEL_RE provenance note. */
export function readCodexConfigModel(home: string = homedir()): string | undefined {
  try {
    const path = join(home, ".codex", "config.toml");
    if (!existsSync(path)) return undefined;
    // Top level only: a `model =` under `[profiles.x]` is not the default.
    const topLevel = readFileSync(path, "utf8").split(/^\s*\[/m)[0] ?? "";
    return topLevel.match(CODEX_CONFIG_MODEL_RE)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Spawn `codex exec`, converting a spawn-level failure into the structured
 * BrainError the classifier reads.
 *
 * Extracted to keep `runCodexCall` under its length pin — the pins only move
 * down — and to mirror ccfork-reviewer.ts's `spawnCcFork`, which exists for the
 * same reason. `instructions.cleanup()` runs HERE because this throw leaves
 * before the caller's `finally` is armed, and defect `[26]`'s profile file must
 * not linger in the user's `$CODEX_HOME`.
 */
function spawnCodex(args: {
  spawnFn: typeof Bun.spawn;
  cwd: string;
  /** `-m <model>` when a model was chosen for this role, else empty. */
  modelArgs: readonly string[];
  /** `--output-schema <path>`, or empty when the caller wants prose (chat). */
  schemaArgs: readonly string[];
  instructions: DeveloperInstructionsArgs;
  platform: NodeJS.Platform | undefined;
}): Bun.Subprocess<"pipe", "pipe", "pipe"> {
  const { instructions } = args;
  try {
    return args.spawnFn(
      [
        "codex",
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        ...codexSandboxArgs(args.cwd, args.platform),
        "-C",
        args.cwd,
        ...args.modelArgs,
        ...instructions.args,
        ...args.schemaArgs,
        "-",
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        // SILTPOKE_INTERNAL:"1" is inherited by this child process's own
        // hooks (recursion suppression, AC4) — but ONLY the hooks that
        // actually check it. Live-observed residual risk (track #7 T4
        // validator): a spawned codex turn's SessionStart hook
        // (handle-session-start.ts) has NO SILTPOKE_INTERNAL guard and
        // will rewrite {cwd}/.siltpoke/baseline.json for the reviewed
        // repo — the fix is tracked as deferred work. Third-party user
        // hooks configured in the user's OWN codex config also still
        // fire inside this brain call (this env var only suppresses
        // SILTPOKE's own hooks via shouldFire's recursion_guard — it is
        // not a sandbox and cannot suppress hooks siltpoke doesn't own).
        env: {
          ...process.env,
          SILTPOKE_INTERNAL: "1",
          // `--profile` is resolved against the CHILD's $CODEX_HOME, and a
          // profile file codex cannot find is ignored SILENTLY — so the
          // directory we wrote to has to be the one it reads. In production
          // this is the value it would have resolved to anyway; it is pinned
          // here so the two can never drift apart (defect `[26]`).
          ...(instructions.codexHome === undefined
            ? {}
            : { CODEX_HOME: instructions.codexHome }),
        },
      },
    );
  } catch (err) {
    instructions.cleanup();
    throw new BrainError(`codex exec spawn failed: ${err}`, err, {
      exitCode: null,
      stderr: "",
      stdout: "",
      spawnError: String(err),
    });
  }
}

async function runCodexCall(
  opts: CallBrainOptions,
  configHome?: string,
): Promise<{ resultText: string; usage: BrainUsage; servedModel?: string; toolCalls: ToolCallRecord[] }> {
  if (opts.systemPrompt.length >= MAX_SYSTEM_PROMPT_CHARS) {
    // $0 failure — pre-spawn, no `failure` field (not a subprocess failure).
    throw new BrainError(
      "codex exec: system prompt too large (>= 200_000 chars)",
    );
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
  const spawn = opts.spawnFn ?? Bun.spawn;
  // The schema IS the review verdict's shape; forced on a chat it would make
  // codex answer a person with review JSON (defect [49]).
  const schemaArgs = opts.plainReply ? [] : ["--output-schema", schemaFilePath()];
  // The daemon's own process.cwd() is frozen at launch time and is NOT the
  // repo under review (T3 deferred item) — prefer the caller-supplied
  // reviewed-repo cwd; fall back for direct/manual callers that omit it.
  // brainContext.cwd defaults to "" when the hook payload lacks cwd — an
  // empty -C must fall back too, never spawn `-C ""`. resolveReviewerCwd
  // warns loudly instead of silently falling back (Task 14 — latent
  // hardening).
  const cwd = resolveReviewerCwd(opts);
  // Defect `[26]`: on Windows the rubric moves out of argv into a codex profile
  // file, and whoever built the argv owns deleting it (see codex-instructions.ts).
  const instructions = developerInstructionsArgs(opts.systemPrompt, {
    platform: opts.platform,
    codexHome: configHome === undefined ? undefined : join(configHome, ".codex"),
  });

  const proc = spawnCodex({
    spawnFn: spawn,
    cwd,
    // A model codex lists for this account (`codex debug models`) is accepted
    // under ChatGPT auth; one it does not list is refused with a 400
    // (probed 2026-10-16: `-m gpt-5.6-luna` answered, `-m gpt-5` was refused).
    modelArgs: opts.model ? ["-m", opts.model] : [],
    schemaArgs,
    instructions,
    platform: opts.platform,
  });

  let stdout: string;
  let stderr: string;
  let exitCode: number;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Inside the try: a throw from the stdin write would otherwise land between
    // the spawn's cleanup and this finally, leaking the profile file once per
    // review — the same leak already fixed in ccfork-reviewer.ts and brain.ts.
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
    instructions.cleanup();
  }

  const events = parseEvents(stdout);
  const failedMessage = turnFailedMessage(events);
  const servedModel =
    servedModelFromStderr(stderr) ?? (opts.model || undefined) ?? readCodexConfigModel(configHome);

  if (failedMessage !== undefined || exitCode !== 0) {
    const combinedStderr = [failedMessage, stderr].filter(Boolean).join("\n");
    const failure: BrainFailureInput = {
      exitCode,
      stderr: combinedStderr.slice(-500),
      stdout: stdout.slice(-500),
    };
    throw new BrainError(
      `codex exec exited with code ${exitCode}${failedMessage ? `: ${failedMessage}` : ""}`,
      undefined,
      failure,
    );
  }

  const resultText = lastAgentMessage(events);
  if (resultText === undefined) {
    throw new BrainError("codex exec produced no agent_message event");
  }

  return { resultText, usage: normalizeUsage(events), servedModel, toolCalls: codexToolCalls(events) };
}

export function makeCodexProvider(deps?: {
  /** Test seam — home dir for the ~/.codex/config.toml servedModel fallback. */
  configHome?: string;
}): ReviewerBrainProvider {
  const callRaw = async (opts: CallBrainOptions): Promise<CallRawResult> => {
    const { resultText, usage, servedModel, toolCalls } = await runCodexCall(
      opts,
      deps?.configHome,
    );
    return { text: resultText, usage, servedModel, toolCalls };
  };
  return {
    meta: {
      name: "codex",
      billing: "quota",
      genAiSystem: "openai",
      acceptsModel: FAMILY_ACCEPTS_MODEL.codex,
    },
    callRaw,
    call: async (
      opts: CallBrainOptions,
    ): Promise<BrainCallResult & { servedModel?: string }> => {
      const raw = await callRaw(opts);

      // Same parseBrainOutput zod gate as claude (AC3) — --output-schema
      // improves conformance, zod stays the enforcement point.
      const innerText = extractJsonString(raw.text);
      let inner: unknown;
      try {
        inner = JSON.parse(innerText);
      } catch (err) {
        throw new BrainError(
          "codex response was not valid JSON; possibly hallucinated prose around it",
          err,
          undefined,
          undefined,
          raw.text,
        );
      }

      let output: ReturnType<typeof parseBrainOutput>;
      try {
        // stripNulls: strict-schema optionals arrive as null; zod expresses
        // optionality as absence.
        output = parseBrainOutput(stripNulls(inner));
      } catch (err) {
        throw new BrainError("codex response failed schema validation", err, undefined, undefined, inner);
      }

      return { output, usage: raw.usage, servedModel: raw.servedModel, toolCalls: raw.toolCalls };
    },
  };
}

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
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  BrainError,
  extractJsonString,
  type BrainCallResult,
  type BrainUsage,
  type CallBrainOptions,
} from "../brain";
import { brainOutputSchema, parseBrainOutput } from "../schema";
import type { BrainFailureInput } from "../failure-classify";
import type { CallRawResult, ReviewerBrainProvider } from "../provider";
import { atomicWrite } from "../../utils/atomic-write";
import { resolveReviewerCwd } from "./reviewer-cwd";

/** codex has no native wall-clock timeout; fixed overhead is higher than
 * claude -p's, so the external kill-timer default is longer (spec §2). */
const DEFAULT_CODEX_TIMEOUT_MS = 120_000;
/** Revision-pass item 1: argv-size guard, well under macOS's ~256KB/arg. */
const MAX_SYSTEM_PROMPT_CHARS = 200_000;
/** Revision-pass item 2: content-hash filename, write-once idempotent rewrite. */
const SCHEMA_CACHE_DIR = join(tmpdir(), "siltpoke-codex-schemas");
/** The --json stream carries no model field and suppresses the human
 * banner on stderr (live-verified 2026-07-07: stderr is empty). The banner
 * parse stays as an opportunistic first source in case a future codex build
 * emits it; the practical source is the config.toml fallback below. */
const MODEL_BANNER_RE = /^model:\s*(\S.*)$/m;
/** `~/.codex/config.toml` `model = "..."` — under ChatGPT auth we never pass
 * `-m`, so the configured model IS what the run serves. Provenance caveat:
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

/**
 * OpenAI strict structured-output requires EVERY property listed in
 * `required` (optionals must instead union with null) — live-verified
 * 2026-07-07: raw z.toJSONSchema output got 400 invalid_json_schema
 * ("Missing 'line'"). Recursively: required := all keys; previously-optional
 * properties get a null branch. The adapter strips those nulls back out
 * before zod parsing (stripNulls below), so brainOutputSchema is untouched.
 */
export function toOpenAiStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toOpenAiStrictSchema);
  if (typeof node !== "object" || node === null) return node;
  const obj = { ...(node as Record<string, unknown>) };
  for (const key of Object.keys(obj)) {
    if (key !== "properties") obj[key] = toOpenAiStrictSchema(obj[key]);
  }
  if (obj.type === "object" && typeof obj.properties === "object" && obj.properties !== null) {
    const props: Record<string, unknown> = {};
    const previouslyRequired = new Set(
      Array.isArray(obj.required) ? (obj.required as string[]) : [],
    );
    for (const [key, value] of Object.entries(obj.properties as Record<string, unknown>)) {
      const strict = toOpenAiStrictSchema(value);
      props[key] = previouslyRequired.has(key)
        ? strict
        : { anyOf: [strict, { type: "null" }] };
    }
    obj.properties = props;
    obj.required = Object.keys(props);
  }
  return obj;
}

/** Strip null-valued keys (the strict-schema optionals) before zod parsing —
 * brainOutputSchema expresses optionality as absence, not null.
 * COUPLING: safe only while brainOutputSchema has zero .nullable() fields
 * (true today — final-pass review 2026-07-07); a future nullable field would
 * be silently dropped here. Revisit this pair together. */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null) continue;
    out[k] = stripNulls(v);
  }
  return out;
}

/** zod v4 native JSON-Schema for --output-schema (no new dependency — spec §2),
 * post-processed to OpenAI strict shape. Lazily computed once per process;
 * the schema is invariant at runtime, so re-hashing + rewriting per call
 * would be pure wasted sync IO. */
let cachedSchemaPath: string | undefined;
function schemaFilePath(): string {
  if (cachedSchemaPath && existsSync(cachedSchemaPath)) return cachedSchemaPath;
  const json = JSON.stringify(toOpenAiStrictSchema(z.toJSONSchema(brainOutputSchema)));
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 16);
  const path = join(SCHEMA_CACHE_DIR, `${hash}.json`);
  if (!existsSync(path)) atomicWrite(path, json);
  cachedSchemaPath = path;
  return path;
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
    return readFileSync(path, "utf8").match(CODEX_CONFIG_MODEL_RE)?.[1];
  } catch {
    return undefined;
  }
}

async function runCodexCall(
  opts: CallBrainOptions,
  configHome?: string,
): Promise<{ resultText: string; usage: BrainUsage; servedModel?: string }> {
  if (opts.systemPrompt.length >= MAX_SYSTEM_PROMPT_CHARS) {
    // $0 failure — pre-spawn, no `failure` field (not a subprocess failure).
    throw new BrainError(
      "codex exec: system prompt too large (>= 200_000 chars)",
    );
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
  const spawn = opts.spawnFn ?? Bun.spawn;
  const schemaPath = schemaFilePath();
  // The daemon's own process.cwd() is frozen at launch time and is NOT the
  // repo under review (T3 deferred item) — prefer the caller-supplied
  // reviewed-repo cwd; fall back for direct/manual callers that omit it.
  // brainContext.cwd defaults to "" when the hook payload lacks cwd — an
  // empty -C must fall back too, never spawn `-C ""`. resolveReviewerCwd
  // warns loudly instead of silently falling back (Task 14 — latent
  // hardening).
  const cwd = resolveReviewerCwd(opts);

  const proc = (() => {
    try {
      return spawn(
        [
          "codex",
          "exec",
          "--json",
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "-C",
          cwd,
          "-c",
          `developer_instructions=${opts.systemPrompt}`,
          "--output-schema",
          schemaPath,
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
          env: { ...process.env, SILTPOKE_INTERNAL: "1" },
        },
      );
    } catch (err) {
      throw new BrainError(`codex exec spawn failed: ${err}`, err, {
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

  const events = parseEvents(stdout);
  const failedMessage = turnFailedMessage(events);
  const servedModel =
    servedModelFromStderr(stderr) ?? readCodexConfigModel(configHome);

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

  return { resultText, usage: normalizeUsage(events), servedModel };
}

export function makeCodexProvider(deps?: {
  /** Test seam — home dir for the ~/.codex/config.toml servedModel fallback. */
  configHome?: string;
}): ReviewerBrainProvider {
  const callRaw = async (opts: CallBrainOptions): Promise<CallRawResult> => {
    const { resultText, usage, servedModel } = await runCodexCall(
      opts,
      deps?.configHome,
    );
    return { text: resultText, usage, servedModel };
  };
  return {
    meta: { name: "codex", billing: "quota", genAiSystem: "openai" },
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

      return { output, usage: raw.usage, servedModel: raw.servedModel };
    },
  };
}

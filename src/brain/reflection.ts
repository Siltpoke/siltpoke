// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import {
  parseReflectionOutput,
  type ReflectionOutput,
} from "./reflection-schema";
import { BrainError, type BrainUsage } from "./brain";

export const REFLECTION_SYSTEM_PROMPT = `You are Siltpoke in REFLECTION mode.

You previously wrote a code-review critique. A human user just dismissed it
with a reason explaining why it was wrong. Your job is to reflect on the
mistake and extract ONE generalizable rule that would prevent this class of
error in the future.

You will receive:
- The full critique you wrote (verbatim).
- The user's dismiss reason.

You will output ONE JSON object and nothing else (no prose, no markdown).
Schema:

{
  "reflection": string,           // 1-2 sentences, first person, what you got wrong
  "learned_rule": string,         // 1 sentence, imperative, generalizable (e.g. "Before flagging NULL handling, grep for existing null checks in the same file.")
  "rule_category": string,        // kebab-case tag (e.g. "null_check", "import_path", "test_isolation")
  "confidence": "high" | "medium" | "low",
  "applies_to_file_types": string[] // e.g. ["py"] or ["ts","tsx"] or []
}

Rules:
- Output exactly one rule. Do not list multiple.
- Use "high" confidence ONLY when the dismiss reason makes the failure mode obvious and the rule generalizes cleanly. Default to "medium".
- The rule must be specific enough to act on but general enough to apply to future similar critiques. Do not echo the user's words verbatim.
- Do not apologize, do not explain at length. Be terse and operational.`;

export interface CallReflectionOptions {
  critiqueBody: string;
  userReason: string;
  fileContext?: string;
  model?: string;
  timeoutMs?: number;
  spawnFn?: typeof Bun.spawn;
}

export interface ReflectionCallResult {
  output: ReflectionOutput;
  usage: BrainUsage;
}

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_TIMEOUT_MS = 60_000;

interface ResultEvent {
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

interface ClaudeStreamEvent {
  type: string;
  [key: string]: unknown;
}

const FENCED_JSON = /```(?:json)?\s*([\s\S]*?)\s*```/;

function extractJsonString(text: string): string {
  const match = text.match(FENCED_JSON);
  return match ? match[1]?.trim() : text.trim();
}

function findResultEvent(events: ClaudeStreamEvent[]): ResultEvent {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === "result") return ev as unknown as ResultEvent;
  }
  throw new BrainError("claude -p stream contained no result event");
}

function extractUsage(resultEvent: ResultEvent): BrainUsage {
  const u = resultEvent.usage ?? {};
  return {
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    total_cost_usd: resultEvent.total_cost_usd ?? null,
  };
}

function buildContextBundle(opts: CallReflectionOptions): string {
  const parts = [
    "<critique_you_wrote>",
    opts.critiqueBody.trim(),
    "</critique_you_wrote>",
    "",
    "<user_dismiss_reason>",
    opts.userReason.trim(),
    "</user_dismiss_reason>",
  ];
  if (opts.fileContext && opts.fileContext.trim().length > 0) {
    parts.push(
      "",
      "<file_context>",
      opts.fileContext.trim(),
      "</file_context>",
    );
  }
  parts.push(
    "",
    "Reflect now. Output ONLY the JSON object specified in the system prompt.",
  );
  return parts.join("\n");
}

export async function callReflection(
  opts: CallReflectionOptions,
): Promise<ReflectionCallResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawn = opts.spawnFn ?? Bun.spawn;

  const proc = spawn(
    [
      "claude",
      "-p",
      "--model",
      model,
      "--system-prompt",
      REFLECTION_SYSTEM_PROMPT,
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

  proc.stdin.write(buildContextBundle(opts));
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
    throw new BrainError(
      `claude -p exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
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

  const innerText = extractJsonString(resultEvent.result);

  let inner: unknown;
  try {
    inner = JSON.parse(innerText);
  } catch (err) {
    throw new BrainError(
      "Reflection response was not valid JSON; possibly hallucinated prose around it",
      err,
    );
  }

  let output: ReflectionOutput;
  try {
    output = parseReflectionOutput(inner);
  } catch (err) {
    throw new BrainError("Reflection response failed schema validation", err);
  }

  return { output, usage: extractUsage(resultEvent) };
}

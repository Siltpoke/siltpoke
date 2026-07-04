// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { parseBrainOutput, type BrainOutput } from "./schema";
import type { BrainFailureInput } from "./failure-classify";

export interface CallBrainOptions {
  systemPrompt: string;
  contextBundle: string;
  model?: string;
  timeoutMs?: number;
  spawnFn?: typeof Bun.spawn;
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

  constructor(
    message: string,
    public readonly cause?: unknown,
    failure?: BrainFailureInput,
  ) {
    super(message);
    this.name = "BrainError";
    this.failure = failure;
  }
}

/** Exported so span writers can record gen_ai.request.model honestly. */
export const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_TIMEOUT_MS = 90_000;

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

export function extractJsonString(text: string): string {
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

/**
 * Shared spawn+collect for both brain call variants: runs `claude -p`, parses
 * the stream events, and returns the model's raw result text + usage. Callers
 * decide how to interpret the text (`callBrainRaw` JSON-parses it;
 * `callBrainText` returns it as-is). Never JSON-parses the inner result — that
 * is the caller's concern.
 */
async function runBrainCall(
  opts: CallBrainOptions,
): Promise<{ resultText: string; usage: BrainUsage }> {
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    throw new BrainError(
      "Brain response was not valid JSON; possibly hallucinated prose around it",
      err,
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
    throw new BrainError("Brain response failed schema validation", err);
  }
  return { output, usage: raw.usage };
}

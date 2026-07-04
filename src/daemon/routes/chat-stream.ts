// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { ChatMessage } from "../../chat/schema";

export interface StreamUsage {
  input_tokens: number;
  output_tokens: number;
}

/** Classified failure causes — mirrors chatMessageSchema.error_reason. */
export type StreamErrorReason = "timeout" | "spawn_failed" | "empty_exit";

export type StreamEvent =
  | { type: "message_start"; message_id: string; model: string }
  | { type: "content_block_delta"; text: string }
  | { type: "message_stop"; usage: StreamUsage; full_text: string }
  | {
      type: "error";
      /** Short human-readable message (also what legacy clients render). */
      error: string;
      /** Present when the failure was classified by the generator. */
      reason?: StreamErrorReason;
      /**
       * Server-side channel only: capped subprocess stderr for the daemon
       * log. The route MUST strip this before the SSE wire and before any
       * persistence — the store carries only reason + short message.
       */
      stderr_tail?: string;
      /**
       * Usage from a `result` event that arrived before the process died —
       * the route ledgers it even though the turn failed.
       */
      usage?: StreamUsage;
    };

export interface StreamChatOptions {
  transcript: string;
  systemPrompt?: string;
  model?: string;
  timeoutMs?: number;
  spawnFn?: typeof Bun.spawn;
  /**
   * Cooperative cancel — on abort the subprocess is killed, reading stops,
   * and the generator yields nothing further (no message_stop, no error);
   * the caller owns cancelled-turn persistence.
   */
  signal?: AbortSignal;
  /**
   * Test seam — when provided, replaces the real Anthropic call with a
   * canned event sequence. Each yielded event is forwarded verbatim.
   */
  fakeEvents?: AsyncIterable<StreamEvent>;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_TIMEOUT_MS = 60_000;

interface ClaudeStreamEvent {
  type: string;
  [key: string]: unknown;
}

interface DeltaPayload {
  delta?: { text?: string };
}

interface MessageMeta {
  message?: { id?: string; model?: string };
}

/**
 * `claude -p --output-format stream-json` (CLI 2.x) emits the assistant turn as
 * a whole `assistant` event whose `message.content[]` carries the text block(s)
 * — NOT incremental `content_block_delta` events. This is the shape we parse for
 * the reply text.
 */
interface AssistantPayload {
  message?: {
    id?: string;
    model?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
}

interface ResultUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface ResultEnd {
  type: "result";
  usage?: ResultUsage;
  /** The final assembled assistant text (authoritative fallback). */
  result?: string;
}

const STDERR_CAP = 8 * 1024;

/** Live-subprocess handles returned by `startClaudeSession`. */
interface ProcSession {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  /** Mutated by the kill timer / abort listener while the read loop runs. */
  flags: { timedOut: boolean; aborted: boolean };
  /** Resolves with the capped stderr tail once the child's stderr closes. */
  stderrTail: Promise<string>;
  /** Clears the kill timer + abort listener. Call once reading ends. */
  teardown: () => void;
}

/**
 * Spawns `claude -p`, writes the transcript to stdin, and arms the watchdog
 * (kill timer + abort listener) and the concurrent stderr drain. Spawn
 * failures return a classified error event instead of throwing — the caller
 * yields it (an exception escaping the generator would lose the reason).
 */
function startClaudeSession(
  opts: StreamChatOptions,
  model: string,
  timeoutMs: number,
): { ok: true; session: ProcSession } | { ok: false; failure: StreamEvent } {
  const spawn = opts.spawnFn ?? Bun.spawn;
  const args = [
    "claude",
    "-p",
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--no-session-persistence",
  ];
  if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);

  const spawnFailure = (msg: string): { ok: false; failure: StreamEvent } => ({
    ok: false,
    failure: {
      type: "error",
      error: `could not start claude: ${msg}`.slice(0, 300),
      reason: "spawn_failed",
    },
  });

  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SILTPOKE_INTERNAL: "1" },
    });
  } catch (err) {
    return spawnFailure(err instanceof Error ? err.message : String(err));
  }

  // kill() may race the process's own exit (ESRCH / already dead) — log at
  // debug and continue teardown; the exit accounting still resolves.
  const killProc = () => {
    try {
      proc.kill();
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: contingency requires a DEBUG-level log here — error/warn would over-promote a benign kill-vs-exit race.
      console.debug(
        `[chat-stream] kill raced process exit (ignored): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  try {
    proc.stdin.write(opts.transcript);
    proc.stdin.end();
  } catch (err) {
    // Spawn SUCCEEDED — a live child exists. Kill it before reporting the
    // failure, or it outlives the spawn_failed return as an orphan.
    killProc();
    return spawnFailure(err instanceof Error ? err.message : String(err));
  }

  const flags = { timedOut: false, aborted: false };
  const killTimer = setTimeout(() => {
    flags.timedOut = true;
    killProc();
  }, timeoutMs);
  const onAbort = () => {
    flags.aborted = true;
    killProc();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  // Drain stderr concurrently (never awaited mid-stream: a full pipe would
  // deadlock the child). Capped — only a tail is ever logged, never stored.
  const stderrTail: Promise<string> = (async () => {
    const s = proc.stderr as unknown;
    if (!s || typeof s !== "object" || !("getReader" in s)) return "";
    try {
      const reader = (s as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let out = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (out.length < STDERR_CAP) out += dec.decode(value, { stream: true });
      }
      return out.slice(0, STDERR_CAP);
    } catch {
      return "";
    }
  })();

  return {
    ok: true,
    session: {
      proc,
      flags,
      stderrTail,
      teardown: () => {
        clearTimeout(killTimer);
        opts.signal?.removeEventListener("abort", onAbort);
      },
    },
  };
}

/** Everything the read loop + exit accounting observed, for classification. */
export interface OutcomeInputs {
  timedOut: boolean;
  timeoutMs: number;
  exitCode: number;
  /** Message of an exception thrown while reading stdout (null = clean read). */
  readErrorMsg: string | null;
  /** The assembled assistant reply (streamed buffer, or the result event's text). */
  fullText: string;
  /** A `result` frame — `claude -p`'s own completion marker — was parsed. */
  sawResult: boolean;
  sawUsage: boolean;
  usage: StreamUsage;
  stderrTail: string;
}

/**
 * Pure 4-way terminal classification: message_stop | timeout | spawn_failed |
 * empty_exit.
 *
 * Order: a kill-timer that fired does NOT discard a COMPLETE reply — when the
 * `result` frame arrived AND the reply has text, the turn is a success even
 * though stdout never closed on its own (the process hung after finishing).
 * Timeout applies only when the completion marker never came (deltas-only
 * hang, or nothing at all). Below that: text presence beats a non-zero exit
 * (a reply that arrived is a reply); the exit code disambiguates
 * spawn_failed vs empty_exit.
 */
export function classifyOutcome(o: OutcomeInputs): StreamEvent {
  const hasText = o.fullText.trim().length > 0;
  const fail = (reason: StreamErrorReason, message: string): StreamEvent => ({
    type: "error",
    error: message.slice(0, 300),
    reason,
    ...(o.stderrTail.length > 0 ? { stderr_tail: o.stderrTail } : {}),
    ...(o.sawUsage ? { usage: o.usage } : {}),
  });

  if (o.timedOut && !(o.sawResult && hasText)) {
    return fail("timeout", `claude -p timed out after ${o.timeoutMs}ms`);
  }
  if (!hasText && o.readErrorMsg !== null) {
    return fail("spawn_failed", `claude -p stream read failed: ${o.readErrorMsg}`);
  }
  if (!hasText && o.exitCode !== 0) {
    return fail("spawn_failed", `claude -p exited with code ${o.exitCode} and produced no reply`);
  }
  if (!hasText) {
    return fail("empty_exit", "claude -p exited 0 with no assistant text");
  }
  return { type: "message_stop", usage: o.usage, full_text: o.fullText };
}

/** Reply-in-progress accumulator for the stdout parse loop. */
interface ParseState {
  messageId: string;
  messageModel: string;
  /** Text accumulated from streamed deltas / assistant blocks. */
  buffer: string;
  /** The result event's authoritative final text (fallback for `buffer`). */
  resultText: string;
  usage: StreamUsage;
  sawUsage: boolean;
  /** A `result` frame — `claude -p`'s own completion marker — was parsed. */
  sawResult: boolean;
  startedEmitted: boolean;
}

/**
 * Translates one parsed `claude -p` stream-json event into zero or more wire
 * events, accumulating reply text / usage / completion flags into `state`.
 */
function translateClaudeEvent(ev: ClaudeStreamEvent, state: ParseState): StreamEvent[] {
  if (!state.startedEmitted && (ev.type === "message_start" || ev.type === "system")) {
    const meta = ev as unknown as MessageMeta;
    state.messageId = meta.message?.id ?? state.messageId;
    state.messageModel = meta.message?.model ?? state.messageModel;
    state.startedEmitted = true;
    return [{ type: "message_start", message_id: state.messageId, model: state.messageModel }];
  }

  if (ev.type === "content_block_delta") {
    const payload = ev as unknown as DeltaPayload;
    const text = payload.delta?.text ?? "";
    if (text.length === 0) return [];
    state.buffer += text;
    return [{ type: "content_block_delta", text }];
  }

  // `claude -p` stream-json emits the reply as a whole `assistant` event
  // (message.content[] text blocks), not incremental deltas. Surface each
  // text block as a delta so the UI renders it + accumulate into buffer.
  if (ev.type === "assistant") {
    const payload = ev as unknown as AssistantPayload;
    if (!state.messageId && payload.message?.id) state.messageId = payload.message.id;
    const out: StreamEvent[] = [];
    for (const block of payload.message?.content ?? []) {
      const text = block.type === "text" ? (block.text ?? "") : "";
      if (text.length === 0) continue;
      state.buffer += text;
      out.push({ type: "content_block_delta", text });
    }
    return out;
  }

  if (ev.type === "result") {
    const r = ev as unknown as ResultEnd;
    state.sawResult = true;
    if (typeof r.result === "string") state.resultText = r.result;
    if (r.usage) {
      state.sawUsage = true;
      state.usage = {
        input_tokens: r.usage.input_tokens ?? 0,
        output_tokens: r.usage.output_tokens ?? 0,
      };
    }
  }
  return [];
}

/**
 * Streams a chat turn. Wraps `claude -p --output-format stream-json` and
 * translates Anthropic-style events to the simplified SSE wire shape the
 * CLI / web client expects. When `fakeEvents` is provided, the real
 * subprocess is skipped (used in tests).
 */
export async function* streamChat(
  opts: StreamChatOptions,
): AsyncGenerator<StreamEvent, void, void> {
  if (opts.fakeEvents) {
    for await (const ev of opts.fakeEvents) yield ev;
    return;
  }

  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const started = startClaudeSession(opts, model, timeoutMs);
  if (!started.ok) {
    yield started.failure;
    return;
  }
  const { proc, flags, stderrTail, teardown } = started.session;

  const state: ParseState = {
    messageId: "",
    messageModel: model,
    buffer: "",
    resultText: "",
    usage: { input_tokens: 0, output_tokens: 0 },
    sawUsage: false,
    sawResult: false,
    startedEmitted: false,
  };
  let readErrorMsg: string | null = null;

  try {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      if (flags.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      for (;;) {
        const newlineAt = pending.indexOf("\n");
        if (newlineAt < 0) break;
        const line = pending.slice(0, newlineAt).trim();
        pending = pending.slice(newlineAt + 1);
        if (line.length === 0) continue;
        let ev: ClaudeStreamEvent;
        try {
          ev = JSON.parse(line) as ClaudeStreamEvent;
        } catch {
          continue;
        }
        for (const out of translateClaudeEvent(ev, state)) yield out;
      }
    }
  } catch (err) {
    // Classified below (never escapes the generator as a raw exception).
    readErrorMsg = err instanceof Error ? err.message : String(err);
  } finally {
    teardown();
  }

  // Exit accounting — the exit code disambiguates spawn_failed vs empty_exit.
  // Runtime-tolerant of test doubles without `exited` (treated as exit 0).
  let exitCode = 0;
  try {
    const exited = (proc as { exited?: Promise<number> }).exited;
    exitCode = typeof exited?.then === "function" ? ((await exited) ?? 0) : 0;
  } catch {
    exitCode = 1;
  }
  const stderr = await stderrTail;

  // Abort: the caller repudiated the turn — yield nothing further (no
  // message_stop, no error); it owns cancelled-turn persistence.
  if (flags.aborted) return;

  // Prefer the streamed/accumulated buffer; fall back to the result event's
  // authoritative text if no text blocks were surfaced as deltas.
  yield classifyOutcome({
    timedOut: flags.timedOut,
    timeoutMs,
    exitCode,
    readErrorMsg,
    fullText: state.buffer || state.resultText,
    sawResult: state.sawResult,
    sawUsage: state.sawUsage,
    usage: state.usage,
    stderrTail: stderr,
  });
}

/** Event fields that exist for the server only (daemon log / ledger) and must
 * never be serialized onto the SSE wire, regardless of caller discipline. */
const SERVER_ONLY_EVENT_FIELDS = ["stderr_tail"] as const;

/**
 * Serializes a stream event into SSE wire format (event:/data: pair).
 * Server-only fields are stripped HERE, at the wire boundary — so even a
 * naive `formatSseEvent(ev)` passthrough of an error event cannot leak them.
 */
export function formatSseEvent(ev: StreamEvent): string {
  const { type, ...rest } = ev;
  const wire: Record<string, unknown> = { ...rest };
  for (const field of SERVER_ONLY_EVENT_FIELDS) delete wire[field];
  return `event: ${type}\ndata: ${JSON.stringify(wire)}\n\n`;
}

/**
 * Context-exclusion chokepoint: every transcript sent to the model passes
 * through this filter. Drops (a) assistant turns whose status is non-ok,
 * (b) assistant turns with empty/whitespace content (covers pre-migration
 * rows that predate the status field), and (c) the user turn immediately
 * preceding a `cancelled` assistant turn (the user repudiated that message).
 * User turns before `failed` turns are KEPT — the backend failed, not them.
 */
export function filterContextHistory(history: ChatMessage[]): ChatMessage[] {
  return history.filter((m, i) => {
    if (m.role === "assistant") {
      if ((m.status ?? "ok") !== "ok") return false;
      if (m.content.trim().length === 0) return false;
    }
    if (m.role === "user") {
      const next = history[i + 1];
      if (next?.role === "assistant" && next.status === "cancelled") return false;
    }
    return true;
  });
}

/**
 * Builds a transcript string for `claude -p` stdin from a session's history
 * plus the new user message. Format: per-message lines tagged by role.
 * History is filtered through `filterContextHistory` — failed/cancelled/empty
 * turns never reach the model.
 */
export function buildTranscript(history: ChatMessage[], newMessage: string): string {
  const lines: string[] = [];
  for (const m of filterContextHistory(history)) {
    if (m.role === "system") {
      lines.push(`[system] ${m.content}`);
    } else if (m.role === "assistant") {
      lines.push(`[assistant] ${m.content}`);
    } else if (m.role === "user") {
      lines.push(`[user] ${m.content}`);
    } else {
      lines.push(`[tool_result] ${m.content}`);
    }
  }
  lines.push(`[user] ${newMessage}`);
  return lines.join("\n\n");
}

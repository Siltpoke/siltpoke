/**
 * chat-stream parser tests — exercise the REAL spawn→parse path (not fakeEvents).
 *
 * Regression guard for the live-smoke bug (2026-06-23): `claude -p
 * --output-format stream-json` (CLI 2.x) emits the reply as a whole `assistant`
 * event (message.content[] text blocks) + a `result` event, NOT incremental
 * `content_block_delta` events. The parser previously only read deltas, so it
 * captured usage but produced full_text:"" — every real chat turn surfaced
 * the (since-retired) raw empty-stream fallback line. Mock-stream e2e bypassed
 * this path entirely, so only live smoke caught it.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../src/chat/schema";
import {
  buildTranscript,
  formatSseEvent,
  type StreamChatOptions,
  type StreamEvent,
  streamChat,
} from "../../src/daemon/routes/chat-stream";

interface FakeProcOpts {
  /** stdout lines enqueued at start (each newline-terminated). */
  lines?: string[];
  /** stderr chunks enqueued at start. */
  stderrChunks?: string[];
  /** Exit code reported when the stream ends on its own (default 0). */
  exitCode?: number;
  /** Keep stdout open after the lines — only kill() ends the stream. */
  hang?: boolean;
}

/** A Bun.spawn stand-in with exit accounting + kill semantics. */
function fakeProc(opts: FakeProcOpts): {
  spawnFn: typeof Bun.spawn;
  killed: () => boolean;
} {
  let killed = false;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  let outCtrl!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      outCtrl = c;
      for (const line of opts.lines ?? []) c.enqueue(enc.encode(`${line}\n`));
      if (!opts.hang) {
        c.close();
        resolveExit(opts.exitCode ?? 0);
      }
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of opts.stderrChunks ?? []) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  const proc = {
    stdin: { write() {}, end() {} },
    stdout,
    stderr,
    exited,
    kill() {
      killed = true;
      try {
        outCtrl.close();
      } catch {
        // stream already closed
      }
      resolveExit(143);
    },
  };
  return {
    spawnFn: (() => proc) as unknown as typeof Bun.spawn,
    killed: () => killed,
  };
}

/** Back-compat helper for the parser tests: clean exit-0 stream. */
function fakeSpawn(lines: string[]): typeof Bun.spawn {
  return fakeProc({ lines }).spawnFn;
}

async function collectWith(
  extra: Partial<StreamChatOptions> & { spawnFn: typeof Bun.spawn },
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of streamChat({ transcript: "hi", ...extra })) {
    out.push(ev);
  }
  return out;
}

async function collect(lines: string[]): Promise<StreamEvent[]> {
  return collectWith({ spawnFn: fakeSpawn(lines) });
}

type ErrorEvent = Extract<StreamEvent, { type: "error" }>;

function findError(events: StreamEvent[]): ErrorEvent | undefined {
  return events.find((e): e is ErrorEvent => e.type === "error");
}

describe("chat-stream parser — claude -p stream-json (CLI 2.x)", () => {
  test("extracts reply text from an `assistant` event's content blocks", async () => {
    const events = await collect([
      JSON.stringify({ type: "system", subtype: "init", message: { id: "msg_1", model: "claude-sonnet-4-6" } }),
      JSON.stringify({ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "你好，朋友！" }] } }),
      JSON.stringify({ type: "result", subtype: "success", result: "你好，朋友！", usage: { input_tokens: 3, output_tokens: 11 } }),
    ]);

    const delta = events.find((e) => e.type === "content_block_delta");
    expect(delta).toEqual({ type: "content_block_delta", text: "你好，朋友！" });

    const stop = events.find((e) => e.type === "message_stop");
    expect(stop).toMatchObject({ type: "message_stop", full_text: "你好，朋友！" });
    // The exact regression: full_text must NOT be empty when only assistant/result events arrive.
    expect((stop as Extract<StreamEvent, { type: "message_stop" }>).full_text.length).toBeGreaterThan(0);
    expect((stop as Extract<StreamEvent, { type: "message_stop" }>).usage.output_tokens).toBe(11);
  });

  test("falls back to the `result` event text when no assistant content blocks surface", async () => {
    const events = await collect([
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "result", subtype: "success", result: "fallback reply", usage: { input_tokens: 1, output_tokens: 2 } }),
    ]);
    const stop = events.find((e) => e.type === "message_stop");
    expect(stop).toMatchObject({ type: "message_stop", full_text: "fallback reply" });
  });

  test("still handles incremental content_block_delta events (Messages-API shape)", async () => {
    const events = await collect([
      JSON.stringify({ type: "message_start", message: { id: "m", model: "x" } }),
      JSON.stringify({ type: "content_block_delta", delta: { text: "ab" } }),
      JSON.stringify({ type: "content_block_delta", delta: { text: "cd" } }),
      JSON.stringify({ type: "result", usage: { input_tokens: 1, output_tokens: 2 } }),
    ]);
    const stop = events.find((e) => e.type === "message_stop");
    expect(stop).toMatchObject({ full_text: "abcd" });
  });

  test("multiple assistant text blocks accumulate in order", async () => {
    const events = await collect([
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "one " }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "two" }] } }),
      JSON.stringify({ type: "result", result: "one two", usage: { input_tokens: 1, output_tokens: 2 } }),
    ]);
    const stop = events.find((e) => e.type === "message_stop");
    expect(stop).toMatchObject({ full_text: "one two" });
  });
});

describe("chat-stream exit classification", () => {
  const resultLine = (text: string) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: text,
      usage: { input_tokens: 3, output_tokens: 7 },
    });

  test("timeout: killed by the timer → error(reason=timeout), no message_stop", async () => {
    const { spawnFn, killed } = fakeProc({ hang: true });
    const events = await collectWith({ spawnFn, timeoutMs: 20 });
    expect(killed()).toBe(true);
    const err = findError(events);
    expect(err?.reason).toBe("timeout");
    expect(err?.error).toContain("timed out");
    expect(events.find((e) => e.type === "message_stop")).toBeUndefined();
  });

  test("spawn throw → error(reason=spawn_failed) yielded, not an escaped exception", async () => {
    const spawnFn = (() => {
      throw new Error("ENOENT: claude not found");
    }) as unknown as typeof Bun.spawn;
    const events = await collectWith({ spawnFn });
    const err = findError(events);
    expect(err?.reason).toBe("spawn_failed");
    expect(err?.error).toContain("ENOENT");
    expect(events.find((e) => e.type === "message_stop")).toBeUndefined();
  });

  test("stdin write throws after a successful spawn → spawn_failed AND the live process is killed (no leak)", async () => {
    // Spawn SUCCEEDS (a live child exists) but writing the transcript to its
    // stdin throws — the child must be killed before the failure is reported,
    // or it outlives the spawn_failed return as a zombie.
    let killed = false;
    const proc = {
      stdin: {
        write() {
          throw new Error("EPIPE: stdin closed");
        },
        end() {},
      },
      stdout: new ReadableStream<Uint8Array>({ start() {} }),
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(143),
      kill() {
        killed = true;
      },
    };
    const spawnFn = (() => proc) as unknown as typeof Bun.spawn;
    const events = await collectWith({ spawnFn });
    const err = findError(events);
    expect(err?.reason).toBe("spawn_failed");
    expect(events.find((e) => e.type === "message_stop")).toBeUndefined();
    expect(killed).toBe(true);
  });

  test("non-zero exit with no output → error(reason=spawn_failed) carrying stderr tail", async () => {
    const { spawnFn } = fakeProc({
      lines: [],
      exitCode: 1,
      stderrChunks: ["auth expired: run claude login"],
    });
    const events = await collectWith({ spawnFn });
    const err = findError(events);
    expect(err?.reason).toBe("spawn_failed");
    expect(err?.stderr_tail).toContain("auth expired");
    expect(events.find((e) => e.type === "message_stop")).toBeUndefined();
  });

  test("exit 0 with no assistant text → error(reason=empty_exit)", async () => {
    const { spawnFn } = fakeProc({
      lines: [JSON.stringify({ type: "system", subtype: "init" })],
      exitCode: 0,
    });
    const events = await collectWith({ spawnFn });
    const err = findError(events);
    expect(err?.reason).toBe("empty_exit");
    expect(events.find((e) => e.type === "message_stop")).toBeUndefined();
  });

  test("non-zero exit WITH text still succeeds (classification order)", async () => {
    const { spawnFn } = fakeProc({ lines: [resultLine("partial ok")], exitCode: 1 });
    const events = await collectWith({ spawnFn });
    expect(findError(events)).toBeUndefined();
    expect(events.find((e) => e.type === "message_stop")).toMatchObject({
      full_text: "partial ok",
    });
  });

  test("stderr tail is capped at 8KB", async () => {
    const { spawnFn } = fakeProc({
      lines: [],
      exitCode: 1,
      stderrChunks: ["x".repeat(20_000)],
    });
    const events = await collectWith({ spawnFn });
    const err = findError(events);
    expect(err?.stderr_tail?.length ?? 0).toBeGreaterThan(0);
    expect(err?.stderr_tail?.length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(8 * 1024);
  });

  test("usage that arrived before the kill rides the error event", async () => {
    const { spawnFn, killed } = fakeProc({ lines: [resultLine("")], hang: true });
    const events = await collectWith({ spawnFn, timeoutMs: 20 });
    expect(killed()).toBe(true);
    const err = findError(events);
    expect(err?.reason).toBe("timeout");
    expect(err?.usage).toEqual({ input_tokens: 3, output_tokens: 7 });
  });

  test("no usage before the kill → error event carries no usage", async () => {
    const { spawnFn } = fakeProc({ hang: true });
    const events = await collectWith({ spawnFn, timeoutMs: 20 });
    expect(findError(events)?.usage).toBeUndefined();
  });

  test("abort: kills the subprocess and yields nothing further", async () => {
    const { spawnFn, killed } = fakeProc({ hang: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const events = await collectWith({ spawnFn, signal: ac.signal, timeoutMs: 5_000 });
    expect(killed()).toBe(true);
    expect(findError(events)).toBeUndefined();
    expect(events.find((e) => e.type === "message_stop")).toBeUndefined();
  });

  test("abort after the stream completed is a no-op (turn stays ok)", async () => {
    const { spawnFn } = fakeProc({ lines: [resultLine("done fine")] });
    const ac = new AbortController();
    const events = await collectWith({ spawnFn, signal: ac.signal });
    ac.abort();
    expect(events.find((e) => e.type === "message_stop")).toMatchObject({
      full_text: "done fine",
    });
    expect(findError(events)).toBeUndefined();
  });
});

describe("timeout after a COMPLETE reply is a success (F1)", () => {
  test("full text + result frame arrived, then the process hangs → message_stop, no error", async () => {
    const { spawnFn, killed } = fakeProc({
      lines: [
        JSON.stringify({
          type: "assistant",
          message: { id: "msg_1", content: [{ type: "text", text: "full reply" }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "full reply",
          usage: { input_tokens: 3, output_tokens: 7 },
        }),
      ],
      hang: true,
    });
    const events = await collectWith({ spawnFn, timeoutMs: 20 });
    // The watchdog still fired and killed the hung process…
    expect(killed()).toBe(true);
    // …but the reply completed (result frame = claude -p's own completion
    // marker), so the turn is a SUCCESS, not a timeout.
    expect(findError(events)).toBeUndefined();
    expect(events.find((e) => e.type === "message_stop")).toMatchObject({
      type: "message_stop",
      full_text: "full reply",
      usage: { input_tokens: 3, output_tokens: 7 },
    });
  });

  test("deltas-only hang (no result frame) is still a timeout failure", async () => {
    const { spawnFn, killed } = fakeProc({
      lines: [JSON.stringify({ type: "content_block_delta", delta: { text: "partial…" } })],
      hang: true,
    });
    const events = await collectWith({ spawnFn, timeoutMs: 20 });
    expect(killed()).toBe(true);
    const err = findError(events);
    expect(err?.reason).toBe("timeout");
    expect(events.find((e) => e.type === "message_stop")).toBeUndefined();
  });

  test("result frame with EMPTY text then hang is still a timeout failure (no complete reply)", async () => {
    const { spawnFn } = fakeProc({
      lines: [
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "",
          usage: { input_tokens: 3, output_tokens: 7 },
        }),
      ],
      hang: true,
    });
    const events = await collectWith({ spawnFn, timeoutMs: 20 });
    const err = findError(events);
    expect(err?.reason).toBe("timeout");
    // pre-kill usage still rides the error event
    expect(err?.usage).toEqual({ input_tokens: 3, output_tokens: 7 });
  });
});

describe("formatSseEvent — server-only field stripping (F3)", () => {
  test("an error event carrying stderr_tail serializes WITHOUT the stderr_tail key", () => {
    const frame = formatSseEvent({
      type: "error",
      error: "claude -p exited with code 1 and produced no reply",
      reason: "spawn_failed",
      stderr_tail: "STDERR_BLOB_F3 auth token material",
    });
    expect(frame).toContain("event: error");
    expect(frame).not.toContain("STDERR_BLOB_F3");
    const data = JSON.parse(frame.split("data: ")[1] as string) as Record<string, unknown>;
    expect("stderr_tail" in data).toBe(false);
    expect(data.reason).toBe("spawn_failed");
    expect(data.error).toContain("exited with code 1");
  });

  test("non-error events pass through unchanged (message_stop keeps usage + full_text)", () => {
    const frame = formatSseEvent({
      type: "message_stop",
      usage: { input_tokens: 1, output_tokens: 2 },
      full_text: "hi",
    });
    const data = JSON.parse(frame.split("data: ")[1] as string) as Record<string, unknown>;
    expect(data).toEqual({ usage: { input_tokens: 1, output_tokens: 2 }, full_text: "hi" });
  });
});

describe("buildTranscript context exclusion", () => {
  function msg(over: Partial<ChatMessage> & { role: ChatMessage["role"]; content: string }): ChatMessage {
    return {
      id: `m-${Math.random().toString(36).slice(2, 10)}`,
      session_id: "s-fixture",
      ts: "2026-07-02T00:00:00Z",
      model: null,
      tokens: null,
      fts_skip: false,
      claude_session_id: null,
      ...over,
    };
  }

  const history: ChatMessage[] = [
    msg({ role: "user", content: "keep-q1" }),
    msg({ role: "assistant", content: "keep-a1" }),
    // pre-migration empty row: no status field, empty content
    msg({ role: "assistant", content: "" }),
    // whitespace-only content counts as empty
    msg({ role: "assistant", content: "   \n " }),
    // failed turn: its user question stays (backend's fault, not the message's)
    msg({ role: "user", content: "keep-q2-before-failed" }),
    msg({ role: "assistant", content: "", status: "failed", error_reason: "timeout" }),
    // cancelled turn: the user repudiated the question — both go
    msg({ role: "user", content: "drop-q3-before-cancelled" }),
    msg({ role: "assistant", content: "drop-partial-answer", status: "cancelled" }),
    msg({ role: "user", content: "keep-q4" }),
    msg({ role: "assistant", content: "keep-a4", status: "ok" }),
  ];

  test("excludes non-ok + empty assistant turns; drops user turn before cancelled only", () => {
    const t = buildTranscript(history, "new question");

    expect(t).toContain("[user] keep-q1");
    expect(t).toContain("[assistant] keep-a1");
    expect(t).toContain("[user] keep-q2-before-failed");
    expect(t).toContain("[user] keep-q4");
    expect(t).toContain("[assistant] keep-a4");
    expect(t).toContain("[user] new question");

    expect(t).not.toContain("drop-partial-answer");
    expect(t).not.toContain("drop-q3-before-cancelled");
    // no empty assistant lines survive (pre-migration rows + failed rows)
    expect(t).not.toMatch(/\[assistant\]\s*(\n|$)/);
  });

  test("all-clean history is unchanged", () => {
    const clean = [
      msg({ role: "user", content: "hi" }),
      msg({ role: "assistant", content: "hello" }),
    ];
    expect(buildTranscript(clean, "next")).toBe(
      "[user] hi\n\n[assistant] hello\n\n[user] next",
    );
  });
});

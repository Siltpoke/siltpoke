/**
 * chat-stream-hardening-server.acceptance.test.ts — ACCEPTANCE tests for the
 * chat-stream-hardening track's server-side hardening.
 *
 *
 * SCOPE — server exit-reason plumbing + persistence branching:
 *   Timeout: timeout-killed `claude -p` → persisted failed turn (reason timeout)
 *        + SSE error event carrying the reason (no silent empty message_stop).
 *   Spawn failure: spawn failure / non-zero exit with no output → reason spawn_failed.
 *   Empty exit: exit 0 with no assistant text → reason empty_exit.
 *   Stderr handling: stderr goes to the server log (console.error → daemon log); the JSONL
 *        line stores ONLY the reason enum + short message, never raw stderr.
 *   Transcript assembly: excludes non-ok + empty historical turns
 *        (pre-migration empty rows, failed rows, cancelled rows + their user q).
 *   Ledger gating: ledger entry only when real usage came back; timeout with no usage
 *        ledgers nothing; usage-before-kill IS ledgered.
 *
 * ACCEPTANCE BOUNDARY — outside-observable behavior only:
 *   • Behavior observed at the ROUTE level (in-process Hono app + REAL
 *     mountChatRoutes) — the wire (SSE body), the store (chats/*.jsonl read
 *     raw off disk), the ledger (usage-events.jsonl), and the daemon log
 *     (console.error spy — the launchd unit redirects daemon stderr to
 *     ~/.siltpoke/logs/daemon.err, so console.error IS the observable path).
 *   • The timeout/spawn-failure/empty-exit/ledger-gating cases drive the REAL
 *     streamChat through the streamFactory seam with a fake Bun.spawn only —
 *     classification code is fully exercised.
 *   • The transcript-assembly case observes the transcript HANDED TO the
 *     stream (captured opts), plus the messages API passthrough the error
 *     cards depend on.
 *
 * Anti-vacuous discipline:
 *   • Every "error event present" assertion is paired with "message_stop
 *     ABSENT" (the old bug was a silent empty message_stop).
 *   • The stderr-handling case asserts the stderr marker string IS in the log
 *     spy AND is NOT in the raw JSONL bytes AND is NOT on the SSE wire.
 *   • The no-ledger case asserts the ledger file does not exist at all,
 *     in the same home where the positive control produces exactly 1 line.
 *
 * Run: bun test tests/acceptance/chat-stream-hardening-server.acceptance.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { type ChatIndex, openIndex } from "../../src/chat/fts5-index";
import { appendMessage } from "../../src/chat/jsonl-store";
import type { ChatMessage } from "../../src/chat/schema";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import {
  type StreamChatOptions,
  type StreamEvent,
  streamChat,
} from "../../src/daemon/routes/chat-stream";

// ── harness ──────────────────────────────────────────────────────────────────

const TEST_SECRET = "test-secret";

const ELIGIBLE_PROJECT = async () => ({
  project_id: null,
  proj_hash: null,
  project_root: null,
  display_name: null,
  source: "explicit" as const,
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function freshHome(): { home: string; idx: ChatIndex } {
  const home = mkdtempSync(join(tmpdir(), "silt-hr-"));
  const idx = openIndex(home);
  cleanups.push(() => {
    idx.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, idx };
}

function appWith(
  home: string,
  idx: ChatIndex,
  streamFactory: (opts: StreamChatOptions) => AsyncGenerator<StreamEvent, void, void>,
): Hono {
  const app = new Hono();
  mountChatRoutes(app, { homeBase: home, resolveProject: ELIGIBLE_PROJECT, index: idx, streamFactory, secret: TEST_SECRET });
  return app;
}

async function post(app: Hono, body: Record<string, unknown>): Promise<{ sid: string; sse: string }> {
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  const sid = res.headers.get("X-Siltpoke-Session-Id") ?? "";
  return { sid, sse: await res.text() };
}

/** Reads the persisted assistant row (last line) RAW off disk. */
function lastJsonlRow(home: string, sid: string): Record<string, unknown> {
  const raw = readFileSync(join(home, "chats", `${sid}.jsonl`), "utf8").trim();
  const lines = raw.split("\n");
  return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
}

function rawJsonl(home: string, sid: string): string {
  return readFileSync(join(home, "chats", `${sid}.jsonl`), "utf8");
}

function ledgerLines(home: string): Record<string, unknown>[] {
  const p = join(home, "usage-events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ── fake Bun.spawn (drives the REAL streamChat) ──────────────────────────────

interface FakeProcOpts {
  lines?: string[];
  stderrChunks?: string[];
  exitCode?: number;
  /** keep stdout open — only the kill timer ends the stream (timeout path). */
  hang?: boolean;
}

function fakeProc(opts: FakeProcOpts): typeof Bun.spawn {
  let outCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  const enc = new TextEncoder();
  const proc = {
    stdin: { write() {}, end() {} },
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        outCtrl = c;
        for (const line of opts.lines ?? []) c.enqueue(enc.encode(`${line}\n`));
        if (!opts.hang) {
          c.close();
          resolveExit(opts.exitCode ?? 0);
        }
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of opts.stderrChunks ?? []) c.enqueue(enc.encode(chunk));
        c.close();
      },
    }),
    exited,
    kill() {
      try {
        outCtrl.close();
      } catch {
        // already closed
      }
      resolveExit(143);
    },
  };
  return (() => proc) as unknown as typeof Bun.spawn;
}

/** streamFactory that runs the REAL streamChat over a fake subprocess. */
function realStreamWith(spawnFn: typeof Bun.spawn, timeoutMs = 40) {
  return (opts: StreamChatOptions) => streamChat({ ...opts, spawnFn, timeoutMs });
}

const RESULT_WITH_USAGE = JSON.stringify({
  type: "result",
  subtype: "success",
  result: "",
  usage: { input_tokens: 11, output_tokens: 22 },
});

// ── timeout ──────────────────────────────────────────────────────────────────

describe("timeout-killed claude -p", () => {
  test("persists failed turn (reason timeout) + SSE error event, no message_stop", async () => {
    const { home, idx } = freshHome();
    const app = appWith(home, idx, realStreamWith(fakeProc({ hang: true })));

    const { sid, sse } = await post(app, { message: "hello?" });

    // wire: classified error, and NOT a silent empty message_stop
    expect(sse).toContain("event: error");
    expect(sse).toContain('"reason":"timeout"');
    expect(sse).not.toContain("event: message_stop");

    // store: failed assistant turn with the reason enum
    const row = lastJsonlRow(home, sid);
    expect(row.role).toBe("assistant");
    expect(row.status).toBe("failed");
    expect(row.error_reason).toBe("timeout");
    expect(row.content).toBe("");
  });
});

// ── spawn failure / non-zero exit with no output ────────────────────────────

describe("spawn_failed", () => {
  test("spawn throw → persisted + wire reason spawn_failed", async () => {
    const { home, idx } = freshHome();
    const throwingSpawn = (() => {
      throw new Error("ENOENT: no such file: claude");
    }) as unknown as typeof Bun.spawn;
    const app = appWith(home, idx, realStreamWith(throwingSpawn));

    const { sid, sse } = await post(app, { message: "hi" });

    expect(sse).toContain('"reason":"spawn_failed"');
    expect(sse).not.toContain("event: message_stop");
    const row = lastJsonlRow(home, sid);
    expect(row.status).toBe("failed");
    expect(row.error_reason).toBe("spawn_failed");
  });

  test("non-zero exit with no output → reason spawn_failed", async () => {
    const { home, idx } = freshHome();
    const app = appWith(
      home,
      idx,
      realStreamWith(fakeProc({ lines: [], exitCode: 1, stderrChunks: ["login required"] })),
    );

    const { sid, sse } = await post(app, { message: "hi" });

    expect(sse).toContain('"reason":"spawn_failed"');
    expect(sse).not.toContain("event: message_stop");
    expect(lastJsonlRow(home, sid).error_reason).toBe("spawn_failed");
  });
});

// ── empty exit ───────────────────────────────────────────────────────────────

describe("exit 0 with no assistant text", () => {
  test("persisted + wire reason empty_exit", async () => {
    const { home, idx } = freshHome();
    const app = appWith(
      home,
      idx,
      realStreamWith(fakeProc({ lines: [JSON.stringify({ type: "system", subtype: "init" })], exitCode: 0 })),
    );

    const { sid, sse } = await post(app, { message: "hi" });

    expect(sse).toContain('"reason":"empty_exit"');
    expect(sse).not.toContain("event: message_stop");
    const row = lastJsonlRow(home, sid);
    expect(row.status).toBe("failed");
    expect(row.error_reason).toBe("empty_exit");
  });
});

// ── stderr to the log, never the store or the wire ──────────────────────────

describe("stderr handling", () => {
  test("stderr lands in the daemon log (console.error) with the session id; store + wire carry only reason + short message", async () => {
    const { home, idx } = freshHome();
    const STDERR_MARKER = "STDERR_BLOB_e4d909c290d0fb1c auth token expired at gateway";
    const app = appWith(
      home,
      idx,
      realStreamWith(fakeProc({ lines: [], exitCode: 1, stderrChunks: [STDERR_MARKER] })),
    );

    const logged: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    let sid = "";
    let sse = "";
    try {
      ({ sid, sse } = await post(app, { message: "hi" }));
    } finally {
      console.error = origErr;
    }

    // observable log line: session-id prefixed, carries the stderr tail
    const line = logged.find((l) => l.includes(STDERR_MARKER));
    expect(line).toBeDefined();
    expect(line).toContain(sid);

    // the store carries ONLY the enum + short message — never the blob
    expect(rawJsonl(home, sid)).not.toContain(STDERR_MARKER);
    const row = lastJsonlRow(home, sid);
    expect(typeof row.error_message).toBe("string");
    expect((row.error_message as string).length).toBeLessThanOrEqual(300);

    // the wire is sanitized too
    expect(sse).not.toContain(STDERR_MARKER);
  });
});

// ── transcript assembly exclusion ────────────────────────────────────────────

function fixtureMsg(
  sid: string,
  over: Partial<ChatMessage> & { role: ChatMessage["role"]; content: string },
): ChatMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2, 10)}`,
    session_id: sid,
    ts: "2026-07-01T00:00:00Z",
    model: null,
    tokens: null,
    fts_skip: false,
    claude_session_id: null,
    ...over,
  };
}

describe("historical non-ok / empty turns never reach the model", () => {
  test("fixture with pre-migration empty + failed + cancelled rows", async () => {
    const { home, idx } = freshHome();
    const sid = "s-fixture";
    const rows: (Partial<ChatMessage> & { role: ChatMessage["role"]; content: string })[] = [
      { role: "user", content: "keep-q1" },
      { role: "assistant", content: "keep-a1" },
      // pre-migration empty row (no status field at all)
      { role: "assistant", content: "" },
      // failed row — its user question is KEPT
      { role: "user", content: "keep-q2" },
      { role: "assistant", content: "", status: "failed", error_reason: "timeout" },
      // cancelled row — its user question is DROPPED with it
      { role: "user", content: "drop-q3" },
      { role: "assistant", content: "drop-partial", status: "cancelled" },
    ];
    for (const r of rows) await appendMessage(home, sid, fixtureMsg(sid, r));

    // capture the transcript the route hands to the stream
    let seenTranscript = "";
    const app = appWith(home, idx, async function* (opts) {
      seenTranscript = opts.transcript;
      yield {
        type: "message_stop",
        usage: { input_tokens: 1, output_tokens: 1 },
        full_text: "fine",
      } as StreamEvent;
    });

    await post(app, { session_id: sid, message: "new-q" });

    expect(seenTranscript).toContain("[user] keep-q1");
    expect(seenTranscript).toContain("[assistant] keep-a1");
    expect(seenTranscript).toContain("[user] keep-q2");
    expect(seenTranscript).toContain("[user] new-q");
    expect(seenTranscript).not.toContain("drop-partial");
    expect(seenTranscript).not.toContain("drop-q3");
    // no empty assistant line survives (pre-migration + failed rows)
    expect(seenTranscript).not.toMatch(/\[assistant\]\s*(\n|$)/);
  });

  test("messages API passes status/error fields through for the error cards", async () => {
    const { home, idx } = freshHome();
    const sid = "s-api";
    await appendMessage(home, sid, fixtureMsg(sid, { role: "user", content: "q" }));
    await appendMessage(
      home,
      sid,
      fixtureMsg(sid, {
        role: "assistant",
        content: "",
        status: "failed",
        error_reason: "timeout",
        error_message: "claude -p timed out after 60000ms",
      }),
    );

    const app = appWith(home, idx, async function* () {});
    const res = await app.request(`/api/chat/sessions/${sid}/messages`);
    const { messages } = (await res.json()) as {
      messages: Record<string, unknown>[];
    };
    // plain rows keep the old lean shape
    expect(messages[0]).toEqual({ role: "user", text: "q" });
    // failed rows expose the fields the error card needs
    expect(messages[1]).toMatchObject({
      role: "assistant",
      text: "",
      status: "failed",
      error_reason: "timeout",
      error_message: "claude -p timed out after 60000ms",
    });
  });
});

// ── ledger only on real usage ────────────────────────────────────────────────

describe("cost ledger gating", () => {
  test("timeout with NO usage → no ledger entry at all", async () => {
    const { home, idx } = freshHome();
    const app = appWith(home, idx, realStreamWith(fakeProc({ hang: true })));

    await post(app, { message: "hi" });

    expect(existsSync(join(home, "usage-events.jsonl"))).toBe(false);
    expect(ledgerLines(home)).toHaveLength(0);
  });

  test("usage that arrived BEFORE the kill is ledgered even though the turn failed", async () => {
    const { home, idx } = freshHome();
    const app = appWith(
      home,
      idx,
      realStreamWith(fakeProc({ lines: [RESULT_WITH_USAGE], hang: true })),
    );

    const { sid } = await post(app, { message: "hi" });

    // turn is still failed…
    expect(lastJsonlRow(home, sid).status).toBe("failed");
    // …but the paid usage is honestly ledgered
    const lines = ledgerLines(home);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "chat", session_id: sid });
  });

  test("timeout AFTER a complete reply: success — message_stop on the wire, ok turn persisted with the text, ledger entry present", async () => {
    const { home, idx } = freshHome();
    const app = appWith(
      home,
      idx,
      realStreamWith(
        fakeProc({
          lines: [
            JSON.stringify({
              type: "assistant",
              message: { content: [{ type: "text", text: "complete answer" }] },
            }),
            JSON.stringify({
              type: "result",
              subtype: "success",
              result: "complete answer",
              usage: { input_tokens: 11, output_tokens: 22 },
            }),
          ],
          hang: true, // reply fully arrived, then the process hangs → kill timer fires
        }),
      ),
    );

    const { sid, sse } = await post(app, { message: "hi" });

    // wire: normal success terminal — NOT a timeout error
    expect(sse).toContain("event: message_stop");
    expect(sse).not.toContain("event: error");

    // store: ok turn with the text the user watched stream in (lean shape)
    const row = lastJsonlRow(home, sid);
    expect(row.content).toBe("complete answer");
    expect(row.status).toBeUndefined();
    expect(row.tokens).toEqual({ input: 11, output: 22 });

    // ledger: the paid usage is recorded
    const lines = ledgerLines(home);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "chat", session_id: sid });
  });

  test("deltas-only hang (no result frame) stays a timeout failure (boundary case)", async () => {
    const { home, idx } = freshHome();
    const app = appWith(
      home,
      idx,
      realStreamWith(
        fakeProc({
          lines: [JSON.stringify({ type: "content_block_delta", delta: { text: "partial…" } })],
          hang: true,
        }),
      ),
    );

    const { sid, sse } = await post(app, { message: "hi" });

    expect(sse).toContain('"reason":"timeout"');
    expect(sse).not.toContain("event: message_stop");
    const row = lastJsonlRow(home, sid);
    expect(row.status).toBe("failed");
    expect(row.error_reason).toBe("timeout");
    expect(row.content).toBe("");
  });

  test("positive control: a successful turn still ledgers exactly one entry", async () => {
    const { home, idx } = freshHome();
    const app = appWith(
      home,
      idx,
      realStreamWith(
        fakeProc({
          lines: [
            JSON.stringify({
              type: "assistant",
              message: { content: [{ type: "text", text: "hello!" }] },
            }),
            JSON.stringify({
              type: "result",
              subtype: "success",
              result: "hello!",
              usage: { input_tokens: 5, output_tokens: 9 },
            }),
          ],
        }),
      ),
    );

    const { sid, sse } = await post(app, { message: "hi" });

    expect(sse).toContain("event: message_stop");
    const row = lastJsonlRow(home, sid);
    expect(row.status).toBeUndefined(); // success rows keep the lean pre-migration shape
    expect(row.content).toBe("hello!");
    expect(ledgerLines(home)).toHaveLength(1);
  });
});

// ── disconnect persistence guard ─────────────────────────────────────────────

/** Polls the session JSONL until the assistant row (2nd line) lands. */
async function pollLastRow(home: string, sid: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(join(home, "chats", `${sid}.jsonl`), "utf8").trim();
      const lines = raw.split("\n").filter(Boolean);
      if (lines.length >= 2) return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
    } catch {
      // file not written yet
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("assistant row never persisted");
}

describe("client disconnect during a failing stream", () => {
  // Cancel wiring: the SSE body's cancel() is now the disconnect→abort
  // signal, and cancelled classification beats a reducer throw — so this row
  // persists as status "cancelled" (no error fields), not "failed". The core
  // claim is unchanged: persistence still runs after the client is gone and
  // a catch-path enqueue throws.
  test("stream throws AFTER the client cancelled the SSE body → cancelled row still persisted (catch-path enqueue must not abort persistence)", async () => {
    const { home, idx } = freshHome();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Factory that throws only after the test has disconnected the client —
    // so the catch-path error enqueue hits a cancelled controller and throws.
    const app = appWith(home, idx, async function* () {
      await gate;
      throw new Error("backend exploded mid-stream");
    });

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(200);
    const sid = res.headers.get("X-Siltpoke-Session-Id") ?? "";
    expect(sid.length).toBeGreaterThan(0);

    // Client disconnects: cancel the SSE body → subsequent enqueues throw.
    await res.body?.cancel();
    release();

    // Persistence must still run after the (throwing) catch-path enqueue.
    const row = await pollLastRow(home, sid);
    expect(row).toMatchObject({ role: "assistant", status: "cancelled", content: "" });
    // Cancelled beats the throw-failure: a user disconnect is never
    // persisted as a failed turn, so no error fields ride the row.
    expect(row.error_message).toBeUndefined();
    expect(row.error_reason).toBeUndefined();
  });
});

// ── unclassified-failure sanitation ──────────────────────────────────────────

describe("unclassified stream throw: raw exception text is daemon-log-only", () => {
  test("route-catch failure → generic error_message persisted; raw text absent from JSONL bytes and the wire, present in the daemon log", async () => {
    const { home, idx } = freshHome();
    // A raw JS exception message carrying internals (paths / codes) that must
    // never reach the store or the wire — same containment as stderr_tail.
    const RAW_MARKER = "raw_exception_canary_9b1f";
    const RAW_MSG = `ENOENT /Users/nobody/.secrets/${RAW_MARKER} split mid-frame`;
    const app = appWith(home, idx, async function* () {
      throw new Error(RAW_MSG);
    });

    const logged: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    let sid = "";
    let sse = "";
    try {
      ({ sid, sse } = await post(app, { message: "hi" }));
    } finally {
      console.error = origErr;
    }

    // store: status-only failed turn (no reason enum) with the GENERIC message
    const row = lastJsonlRow(home, sid);
    expect(row.status).toBe("failed");
    expect(row.error_reason).toBeUndefined();
    expect(row.error_message).toBe("unexpected stream failure");
    // raw exception text never reaches the JSONL bytes or the SSE wire…
    expect(rawJsonl(home, sid)).not.toContain(RAW_MARKER);
    expect(sse).not.toContain(RAW_MARKER);
    expect(sse).toContain("unexpected stream failure");
    // …but IS observable in the daemon log (positive control — same
    // console.error discipline as stderr tails).
    expect(logged.find((l) => l.includes(RAW_MARKER))).toBeDefined();
  });
});

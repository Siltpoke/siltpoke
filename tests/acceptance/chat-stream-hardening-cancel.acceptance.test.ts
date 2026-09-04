/**
 * ACCEPTANCE tests for the server legs of the chat-stream-hardening track
 * (cancel wiring; the client legs live in the island + SSR markup tests):
 *   Cancel (server half): cancelling the SSE response body kills the `claude -p`
 *        subprocess — observable well before the 60s timeout (tests run with
 *        timeoutMs = 60_000 and finish in milliseconds). Proven on the fake
 *        spawn (kill() call observability) AND on a REAL subprocess (pid gone).
 *   Persistence: a stopped turn persists with status "cancelled" — partial assistant
 *        text stored on the row (never displayed / re-fed), tokens null when
 *        no usage arrived, the user question preserved as the preceding row —
 *        and the NEXT turn's assembled transcript excludes both.
 *   Disconnect: browser disconnect == the same cancel path. Both disconnect signals
 *        are exercised: (a) response-body cancel() — what Bun fires when the
 *        socket dies; (b) the raw Request AbortSignal. Neither persists an
 *        ok-status empty turn, neither ledgers unpaid usage, neither waits 60s.
 *
 * ACCEPTANCE BOUNDARY — outside-observable behavior only: the ROUTE (in-process
 * Hono app + REAL mountChatRoutes), the store (chats/*.jsonl raw off disk), the
 * ledger (usage-events.jsonl), the subprocess (kill observability / live pid).
 *
 * Anti-vacuous discipline:
 *   • Every cancel assertion first proves the stream was LIVE (first SSE frame
 *     read before cancelling) — cancelling a dead stream proves nothing.
 *   • "cancelled" rows are asserted as status === "cancelled" AND paired with
 *     status !== ok/failed negatives (the pre-hardening bug shapes: an abort with no
 *     text misclassified as empty_exit failed; an abort with partial deltas
 *     fell into the SUCCESS branch and poisoned future context).
 *   • The F1-parity boundary is pinned: an abort AFTER message_stop was reduced
 *     (complete reply) stays an OK turn — a late disconnect never discards a
 *     complete, paid-for answer.
 *
 * Run: bun test tests/acceptance/chat-stream-hardening-cancel.acceptance.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { type ChatIndex, openIndex } from "../../src/chat/fts5-index";
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

/** POSTs a chat message and returns the LIVE response (body not consumed). */
async function postLive(
  app: Hono,
  body: Record<string, unknown>,
  init?: { signal?: AbortSignal },
): Promise<{ res: Response; sid: string }> {
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
    body: JSON.stringify(body),
    ...(init?.signal ? { signal: init.signal } : {}),
  });
  expect(res.status).toBe(200);
  const sid = res.headers.get("X-Siltpoke-Session-Id") ?? "";
  expect(sid.length).toBeGreaterThan(0);
  return { res, sid };
}

function jsonlRows(home: string, sid: string): Record<string, unknown>[] {
  const raw = readFileSync(join(home, "chats", `${sid}.jsonl`), "utf8").trim();
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Polls until the assistant row (2nd+ line) lands; persistence runs after the
 * client is gone, so tests must wait for it rather than the response end. */
async function pollRows(
  home: string,
  sid: string,
  minRows = 2,
  timeoutMs = 3_000,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const rows = jsonlRows(home, sid);
      if (rows.length >= minRows) return rows;
    } catch {
      // file not written yet
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("assistant row never persisted");
}

/**
 * Read the SSE body until `needle` shows up, and hand back everything read.
 *
 * Replaces a `pollUntil` whose body fired `void reader.read().then(...)` —
 * unawaited — and then checked an accumulator the callback had not written to
 * yet. Two defects in that shape, one of them able to fail a run that had
 * already succeeded:
 *
 *   1. **Lost wakeup.** The chunk could land between the loop's last `cond()`
 *      and the deadline, so the append happened, the condition became true,
 *      and the loop threw anyway because nothing looked again. Awaiting the
 *      read removes the window by construction: there is no callback that can
 *      run after the last check, because the check IS after the read.
 *   2. **A read per tick.** One `read()` was issued every 10ms for the whole
 *      budget — up to ~300 concurrent reads on one reader for a stream with
 *      two chunks. Awaiting issues exactly one read per chunk consumed.
 *
 * Whether either of these caused the CI failure of 2026-08-10 is NOT known:
 * that run's assertion detail did not survive into the log, and the test has
 * never reproduced locally (5/5 green). What IS known is that the old failure
 * message — "condition never became true" — names nothing, which is why the
 * question could not be settled. This one reports the needle it wanted, how
 * long it waited, and what was actually on the wire, so the next occurrence
 * explains itself instead of costing another round of guessing.
 */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs = 3_000,
): Promise<string> {
  const dec = new TextDecoder();
  const started = Date.now();
  let wire = "";
  let reads = 0;
  while (!wire.includes(needle)) {
    const waited = Date.now() - started;
    if (waited >= timeoutMs) {
      throw new Error(
        `never saw ${JSON.stringify(needle)} on the wire after ${waited}ms and ${reads} read(s). ` +
          `Wire so far (${wire.length} chars): ${JSON.stringify(wire.slice(0, 400))}`,
      );
    }
    // The read is raced against the remaining budget so a stream that goes
    // quiet cannot hang the suite — but a SLOW stream simply waits, which is
    // the behaviour a loaded CI runner needs and the polling version denied it.
    const chunk = await Promise.race([
      reader.read().then((r) => {
        reads += 1;
        return r;
      }),
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs - waited)),
    ]);
    if (chunk === null) continue;
    if (chunk.done) break;
    if (chunk.value) wire += dec.decode(chunk.value, { stream: true });
  }
  if (!wire.includes(needle)) {
    throw new Error(
      `stream ended before ${JSON.stringify(needle)} appeared, after ${reads} read(s). ` +
        `Wire (${wire.length} chars): ${JSON.stringify(wire.slice(0, 400))}`,
    );
  }
  return wire;
}

async function pollUntil(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition never became true");
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

// ── fake Bun.spawn with kill observability (drives the REAL streamChat) ─────

interface FakeProcHandle {
  spawn: typeof Bun.spawn;
  kills: { count: number };
}

/** A hanging fake subprocess: stdout stays open until kill() closes it. */
function hangingProc(lines: string[] = []): FakeProcHandle {
  let outCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  const kills = { count: 0 };
  const enc = new TextEncoder();
  const proc = {
    stdin: { write() {}, end() {} },
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        outCtrl = c;
        for (const line of lines) c.enqueue(enc.encode(`${line}\n`));
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
    exited,
    kill() {
      kills.count += 1;
      try {
        outCtrl.close();
      } catch {
        // already closed
      }
      resolveExit(143);
    },
  };
  return { spawn: (() => proc) as unknown as typeof Bun.spawn, kills };
}

/** streamFactory running the REAL streamChat with the REAL 60s default-scale
 * timeout — cancellation, not the kill timer, must end these streams. */
function realStreamWith(spawnFn: typeof Bun.spawn) {
  return (opts: StreamChatOptions) => streamChat({ ...opts, spawnFn, timeoutMs: 60_000 });
}

const DELTA_LINE = JSON.stringify({
  type: "content_block_delta",
  delta: { text: "partial answer the user stopp" },
});

// ── Cancel (server half) — cancel kills the subprocess, well before timeout ──

describe("cancelling the SSE body kills the subprocess", () => {
  test("fake spawn: body cancel → kill() observed fast, cancelled row persisted", async () => {
    const { home, idx } = freshHome();
    const fake = hangingProc();
    const app = appWith(home, idx, realStreamWith(fake.spawn));

    const t0 = Date.now();
    const { res, sid } = await postLive(app, { message: "stop me" });
    const reader = res.body!.getReader();
    // Prove the stream is LIVE before cancelling (message_start frame).
    const first = await reader.read();
    expect(first.done).toBe(false);

    await reader.cancel();

    await pollUntil(() => fake.kills.count > 0);
    expect(fake.kills.count).toBeGreaterThanOrEqual(1);

    const rows = await pollRows(home, sid);
    expect(rows[rows.length - 1]).toMatchObject({ role: "assistant", status: "cancelled" });
    // "well before the 60s timeout": the whole exchange ran with
    // timeoutMs=60_000 and completed in test time.
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("REAL subprocess: body cancel → live pid gone (no 60s zombie)", async () => {
    const { home, idx } = freshHome();
    let pid = 0;
    // Wrap seam: spawn a REAL long-lived process (sleep 30) with the exact
    // pipe wiring streamChat asks for; capture its pid for liveness probes.
    const wrapSpawn = ((_cmds: string[], opts: object) => {
      const p = Bun.spawn(["sleep", "30"], opts as Parameters<typeof Bun.spawn>[1]);
      pid = p.pid;
      return p;
    }) as unknown as typeof Bun.spawn;
    const app = appWith(home, idx, realStreamWith(wrapSpawn));

    const { res, sid } = await postLive(app, { message: "stop me" });
    const reader = res.body!.getReader();
    await reader.read(); // stream live
    expect(pid).toBeGreaterThan(0);
    // Positive control: the process IS alive before cancel (signal 0 probe).
    expect(() => process.kill(pid, 0)).not.toThrow();

    await reader.cancel();

    // The pid must disappear promptly — ESRCH from the signal-0 probe.
    await pollUntil(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });

    const rows = await pollRows(home, sid);
    expect(rows[rows.length - 1]).toMatchObject({ role: "assistant", status: "cancelled" });
  });
});

// ── Cancelled persistence + context exclusion ────────────────────────────────

describe("stopped turn persists as cancelled; never re-enters context", () => {
  test("partial deltas + cancel → cancelled row (NOT ok/failed) with partial text, tokens null, user question preserved", async () => {
    const { home, idx } = freshHome();
    const fake = hangingProc([DELTA_LINE]);
    const app = appWith(home, idx, realStreamWith(fake.spawn));

    const { res, sid } = await postLive(app, { message: "the question I cancelled" });
    const reader = res.body!.getReader();
    // Read until the partial delta is on the wire — the abort must arrive
    // AFTER partial text accumulated (the pre-hardening success-branch poisoning shape).
    await readUntil(reader, "partial answer");
    await reader.cancel();

    const rows = await pollRows(home, sid);
    expect(rows).toHaveLength(2);
    // user message association preserved (positional: immediately preceding)
    expect(rows[0]).toMatchObject({ role: "user", content: "the question I cancelled" });
    const row = rows[1]!;
    expect(row.status).toBe("cancelled");
    // the pre-hardening bug shapes must NOT appear:
    expect(row.status).not.toBe("failed"); // not empty_exit-misclassified
    expect(row.error_reason).toBeUndefined();
    // partial text is stored on the row (honesty) — display/context layers hide it
    expect(row.content).toBe("partial answer the user stopp");
    // no usage arrived → tokens honest-null + nothing ledgered
    expect(row.tokens).toBeNull();
    expect(ledgerLines(home)).toHaveLength(0);
  });

  test("next turn's assembled transcript excludes the cancelled user question AND the partial text", async () => {
    const { home, idx } = freshHome();
    const fake = hangingProc([DELTA_LINE]);

    // Turn 1: cancel mid-stream (same flow as above).
    const app1 = appWith(home, idx, realStreamWith(fake.spawn));
    const { res, sid } = await postLive(app1, { message: "cancelled question" });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await pollRows(home, sid);

    // Turn 2: capture the transcript the route hands to the stream.
    let seenTranscript = "";
    const app2 = appWith(home, idx, async function* (opts) {
      seenTranscript = opts.transcript;
      yield {
        type: "message_stop",
        usage: { input_tokens: 1, output_tokens: 1 },
        full_text: "fine",
      } as StreamEvent;
    });
    const { res: res2 } = await postLive(app2, { session_id: sid, message: "next question" });
    await res2.text();

    expect(seenTranscript).toContain("[user] next question");
    expect(seenTranscript).not.toContain("cancelled question");
    expect(seenTranscript).not.toContain("partial answer");
  });

  test("F1-parity boundary: abort AFTER message_stop was reduced → complete reply stays an OK turn", async () => {
    const { home, idx } = freshHome();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Factory yields a COMPLETE turn, then holds the stream open so the test
    // can abort deterministically after message_stop but before stream end.
    const app = appWith(home, idx, async function* () {
      yield { type: "content_block_delta", text: "complete answer" } as StreamEvent;
      yield {
        type: "message_stop",
        usage: { input_tokens: 5, output_tokens: 9 },
        full_text: "complete answer",
      } as StreamEvent;
      await gate;
    });

    const { res, sid } = await postLive(app, { message: "q" });
    const reader = res.body!.getReader();
    await readUntil(reader, "message_stop");
    // Disconnect AFTER the complete reply arrived, then let the stream end.
    await reader.cancel();
    release();

    const rows = await pollRows(home, sid);
    const row = rows[rows.length - 1]!;
    // A complete, paid-for reply is never discarded by a late disconnect.
    expect(row.status).toBeUndefined();
    expect(row.content).toBe("complete answer");
    // Wait for the ledger separately — `pollRows` only settles the ROW, and the
    // ledger is written AFTER it, further down the same stream callback
    // (`src/daemon/routes/chat.ts:1444`). Asserting straight off `pollRows`
    // assumes the two land together. They do not; the gap is just narrow.
    //
    // Measured rather than reasoned. A probe reading the ledger at the instant
    // `pollRows` returns — exactly what the bare assertion used to read — came
    // back `1` on **18/18** unloaded runs, and `0` on **5 of 18** with ten
    // spinners saturating the CPU. That is the CI failure of 2026-08-24
    // (`Expected length: 1 / Received length: 0`) reproduced on demand, and all
    // five of those loaded runs pass with this poll in front of the assertion.
    // The other two ledger assertions in this file (below) already poll first.
    await pollUntil(() => ledgerLines(home).length === 1);
    expect(ledgerLines(home)).toHaveLength(1);
  });
});

// ── F1 fixup — disconnect racing the terminal batch ─────────────────────────
//
// The confirmed race: `claude -p` often flushes its terminal assistant/result
// lines in ONE stdout chunk, so the terminal events can be reduced AFTER the
// client already disconnected. Every emit then hits a cancelled controller and
// throws. An emit failure is a WIRE delivery problem, never a turn-outcome
// problem — the completed, billed reply must persist as an OK turn.

describe("F1 fixup — terminal batch reduced after disconnect stays an OK turn", () => {
  test("message_stop arrives after the client disconnected → OK turn with full text + tokens + ledger, never failed / content discarded", async () => {
    const { home, idx } = freshHome();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // The terminal event is held until AFTER the test cancels the SSE reader —
    // so its own wire emit is the first enqueue on the dead controller.
    const app = appWith(home, idx, async function* () {
      yield { type: "content_block_delta", text: "the full billed answer" } as StreamEvent;
      await gate;
      yield {
        type: "message_stop",
        usage: { input_tokens: 7, output_tokens: 13 },
        full_text: "the full billed answer",
      } as StreamEvent;
    });

    const { res, sid } = await postLive(app, { message: "q" });
    const reader = res.body!.getReader();
    // Prove the stream is LIVE and the reply text already streamed in.
    await readUntil(reader, "the full billed answer");
    // Disconnect BEFORE the terminal batch is emitted, then let it flow.
    await reader.cancel();
    release();

    const rows = await pollRows(home, sid);
    const row = rows[rows.length - 1]!;
    // the race's mislabel shape, pinned as negatives:
    expect(row.status).not.toBe("failed");
    expect(row.error_message).toBeUndefined();
    expect(row.error_reason).toBeUndefined();
    // a complete, paid-for reply is an OK turn (F1-parity: aborted && sawStop)
    expect(row.status).toBeUndefined();
    expect(row.content).toBe("the full billed answer");
    expect(row.tokens).toEqual({ input: 7, output: 13 });
    // the ledger write lands AFTER the row (persistence order) — poll for it
    await pollUntil(() => ledgerLines(home).length === 1);
    expect(ledgerLines(home)).toHaveLength(1);
  });

  test("post-disconnect batch of [delta, message_stop]: the reducer keeps reducing past the first dead-wire emit", async () => {
    const { home, idx } = freshHome();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // BOTH terminal events emit onto a dead wire; the message_stop AFTER the
    // first throwing emit must still be reduced (sawStop/usage/text finish).
    const app = appWith(home, idx, async function* () {
      yield { type: "content_block_delta", text: "part one" } as StreamEvent;
      await gate;
      yield { type: "content_block_delta", text: " part two" } as StreamEvent;
      yield {
        type: "message_stop",
        usage: { input_tokens: 3, output_tokens: 5 },
        full_text: "part one part two",
      } as StreamEvent;
    });

    const { res, sid } = await postLive(app, { message: "q" });
    const reader = res.body!.getReader();
    await readUntil(reader, "part one");
    await reader.cancel();
    release();

    const rows = await pollRows(home, sid);
    const row = rows[rows.length - 1]!;
    expect(row.status).toBeUndefined();
    expect(row.content).toBe("part one part two");
    expect(row.tokens).toEqual({ input: 3, output: 5 });
    // the ledger write lands AFTER the row (persistence order) — poll for it
    await pollUntil(() => ledgerLines(home).length === 1);
    expect(ledgerLines(home)).toHaveLength(1);
  });
});

// ── Browser disconnect drives the SAME cancel path ───────────────────────────

describe("disconnect (tab close) kills the subprocess via the cancel path", () => {
  test("response-body cancel with NO partial text → cancelled row, NOT an ok/failed empty turn, no ledger, no 60s wait", async () => {
    const { home, idx } = freshHome();
    const fake = hangingProc();
    const app = appWith(home, idx, realStreamWith(fake.spawn));

    const t0 = Date.now();
    const { res, sid } = await postLive(app, { message: "tab closes now" });
    const reader = res.body!.getReader();
    await reader.read(); // stream live
    await reader.cancel(); // what Bun fires when the socket dies

    await pollUntil(() => fake.kills.count > 0);
    const rows = await pollRows(home, sid);
    const row = rows[rows.length - 1]!;
    // the exact pre-hardening misclassification shapes, pinned as negatives:
    expect(row.status).toBe("cancelled");
    expect(row.status).not.toBe("failed"); // an abort is NOT empty_exit
    expect(row.error_reason).toBeUndefined();
    expect(row.content).toBe("");
    expect(row.tokens).toBeNull();
    expect(ledgerLines(home)).toHaveLength(0);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("raw Request AbortSignal leg: aborting the request signal kills the subprocess + persists cancelled", async () => {
    const { home, idx } = freshHome();
    const fake = hangingProc();
    const app = appWith(home, idx, realStreamWith(fake.spawn));

    const ac = new AbortController();
    const { res, sid } = await postLive(app, { message: "signal abort" }, { signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read(); // stream live
    ac.abort();

    await pollUntil(() => fake.kills.count > 0);
    const rows = await pollRows(home, sid);
    expect(rows[rows.length - 1]).toMatchObject({
      role: "assistant",
      status: "cancelled",
      content: "",
    });
    expect(ledgerLines(home)).toHaveLength(0);
    // drain: the stream closes on its own after cancellation (no hang)
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  });
});


// ── The reader helper itself ────────────────────────────────────────────────
//
// A test helper that can fail a run which actually succeeded is worse than no
// helper: it spends a CI slot and a person's afternoon on a defect that is not
// in the product. These pin the two properties the old `pollUntil(() => { void
// reader.read().then(...) })` shape did not have.

describe("readUntil — the SSE reader helper", () => {
  /** A stream whose chunks are already queued: every `read()` resolves without
   *  waiting on anything, which is what makes the lost-wakeup case below
   *  deterministic rather than a race the test would sometimes lose. */
  const readyStream = (...chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    }).getReader();

  /** The shape this helper replaced, kept verbatim so the comparison below is
   *  against the real thing rather than a paraphrase of it. */
  async function oldPollingRead(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    needle: string,
    timeoutMs: number,
  ): Promise<{ threw: boolean; wire: string }> {
    const dec = new TextDecoder();
    let wire = "";
    try {
      await pollUntil(() => {
        void reader.read().then((r) => {
          if (r.value) wire += dec.decode(r.value, { stream: true });
        });
        return wire.includes(needle);
      }, timeoutMs);
      return { threw: false, wire };
    } catch {
      return { threw: true, wire };
    }
  }

  test("the old shape throws with the answer already in hand — the lost wakeup, reproduced", async () => {
    // Deterministic by construction, not by timing luck. The chunk is already
    // queued, so `read()` resolves on the first microtask turn — during the
    // loop's 10ms sleep, i.e. AFTER that iteration's `cond()` had already
    // returned false. The budget is one tick, so the loop then exits on the
    // deadline and throws. Nothing is racing: a `setTimeout(10)` cannot fire
    // before 10ms, and an already-queued chunk cannot arrive later than the
    // first turn.
    const { threw, wire } = await oldPollingRead(readyStream("message_stop\n"), "message_stop", 10);

    expect(threw).toBe(true);
    // The condition it reported as "never became true" WAS true: the data is
    // sitting in the accumulator the loop stopped looking at.
    expect(wire).toContain("message_stop");
  });

  test("readUntil returns that same stream's content instead of throwing", async () => {
    // Same stream, same one-tick budget. The only variable changed is the
    // helper, which is what makes this a control rather than an anecdote.
    const wire = await readUntil(readyStream("message_stop\n"), "message_stop", 10);
    expect(wire).toContain("message_stop");
  });

  test("it joins chunks and stops at the needle rather than draining the stream", async () => {
    const wire = await readUntil(readyStream("partial ", "answer\n", "trailing"), "answer");
    expect(wire).toBe("partial answer\n");
  });

  test("a stream that goes quiet reports what it wanted, how long it waited, and what it got", async () => {
    // The old message was "condition never became true", which names neither
    // the needle nor the wire — the reason the 2026-08-10 CI failure could not
    // be diagnosed from its log at all.
    const quiet = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("event: open\n"));
      },
    }).getReader();

    const err = await readUntil(quiet, "message_stop", 40).then(
      () => null,
      (e: Error) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("message_stop");
    expect(err?.message).toContain("event: open");
    expect(err?.message).toMatch(/after \d+ms/);
  });

  test("a stream that ends early says so, rather than blaming the clock", () => {
    // Distinct from the timeout above: nothing is coming, and reporting a
    // timeout for a closed stream would send the next reader looking for a
    // slow server that does not exist.
    return readUntil(readyStream("event: open\n"), "message_stop", 500).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e: Error) => {
        expect(e.message).toContain("stream ended before");
        expect(e.message).toContain("message_stop");
      },
    );
  });
});

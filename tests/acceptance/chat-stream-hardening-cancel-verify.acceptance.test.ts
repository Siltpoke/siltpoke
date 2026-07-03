/**
 * chat-stream-hardening-cancel-verify.acceptance.test.ts — an independent acceptance
 * test for the Stop button + cancel wiring, derived from the acceptance criteria.
 *
 * Coverage:
 *  - Stop control visible while streaming on both surfaces; activating it
 *        aborts the client fetch AND the server kills `claude -p` (process
 *        gone well before the 60s timeout).
 *  - stopped turn persisted status:"cancelled" (user msg association
 *        preserved); neither the cancelled user message nor partial assistant
 *        text appears in the NEXT turn's assembled transcript.
 *  - quiet non-error stopped marker (no apology / error styling);
 *        composer ready immediately.
 *  - browser disconnect mid-stream → server kills subprocess via the same
 *        path; no 60s zombie; no ok-status empty turn persisted.
 *
 * Oracle levels used:
 *  - Server: REAL route (mountChatRoutes on a Hono app) driving the REAL
 *    streamChat generator with a fake Bun.spawn (kill-observability) — plus
 *    one REAL-subprocess variant (`sleep 60`, signal-0 ESRCH probe). Disk is
 *    read RAW (chats/*.jsonl, usage-events.jsonl) — no store API self-grading.
 *  - Transcript leg: THREE real route turns in one session (ok → cancelled →
 *    ok), asserting on the bytes written to the fake subprocess's STDIN on
 *    turn 3 (one level below the streamFactory boundary).
 *  - Client: real island factories with injected fetch whose SSE body errors
 *    with AbortError on signal abort (mirrors real fetch cancellation).
 *  - SSR: rendered HTML of FloatingChat() / Chat().
 *
 * Run: bun test tests/acceptance/chat-stream-hardening-cancel-verify.acceptance.test.ts
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
import { FloatingChat } from "../../src/web/_shared/FloatingChat";
import { makeChatStreamData } from "../../src/web/client/islands/chat-stream";
import { makeFloatingChatData } from "../../src/web/client/islands/floating-chat";
import {
  CHAT_ERROR_COPY,
  CHAT_ERROR_FALLBACK_COPY,
  CHAT_STOPPED_MARKER,
} from "../../src/web/client/lib/chat-error-copy";
import { Chat } from "../../src/web/screens/Chat";

// ═══════════════════════════════ shared harness ══════════════════════════════

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tmpHome(): { home: string; idx: ChatIndex } {
  const home = mkdtempSync(join(tmpdir(), "silt-t5v-"));
  const idx = openIndex(home);
  cleanups.push(() => {
    idx.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, idx };
}

function mountApp(
  home: string,
  idx: ChatIndex,
  streamFactory: (opts: StreamChatOptions) => AsyncGenerator<StreamEvent, void, void>,
): Hono {
  const app = new Hono();
  mountChatRoutes(app, { homeBase: home, index: idx, streamFactory });
  return app;
}

async function post(
  app: Hono,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ res: Response; sid: string }> {
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type") ?? "").toContain("text/event-stream");
  const sid = res.headers.get("X-Siltpoke-Session-Id") ?? "";
  expect(sid).not.toBe("");
  return { res, sid };
}

function rowsOnDisk(home: string, sid: string): Record<string, unknown>[] {
  const p = join(home, "chats", `${sid}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function ledgerOnDisk(home: string): Record<string, unknown>[] {
  const p = join(home, "usage-events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Persistence runs server-side AFTER the client is gone — poll for it. */
async function waitFor<T>(
  probe: () => T | null,
  what: string,
  timeoutMs = 4_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = probe();
    if (got !== null) return got;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function waitForRows(
  home: string,
  sid: string,
  n: number,
): Promise<Record<string, unknown>[]> {
  return waitFor(() => {
    const rows = rowsOnDisk(home, sid);
    return rows.length >= n ? rows : null;
  }, `${n} persisted rows for ${sid}`);
}

/** Reads SSE frames off the live response until `needle` appears (or the
 * stream ends). Returns everything read so far — the pre-cancel wire. */
async function readWireUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
): Promise<string> {
  const dec = new TextDecoder();
  let wire = "";
  const deadline = Date.now() + 4_000;
  while (!wire.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`never saw "${needle}" on the wire`);
    const { value, done } = await reader.read();
    if (done) break;
    wire += dec.decode(value, { stream: true });
  }
  return wire;
}

// ── fake Bun.spawn (drives the REAL streamChat) ──────────────────────────────

interface ProcScript {
  /** claude stream-json lines emitted on stdout at start. */
  lines?: string[];
  /** true → stdout closes after lines (normal completion); false → held open
   * until kill() (a hung/in-flight turn). */
  complete?: boolean;
}

interface FakeSpawnHandle {
  spawn: typeof Bun.spawn;
  /** kill() invocations across all spawned procs. */
  kills: number[];
  /** transcript bytes written to each spawned proc's stdin, in spawn order. */
  stdins: string[];
}

/** Scripted fake Bun.spawn: each call consumes the next ProcScript. Captures
 * stdin writes + kill() calls; kill() closes stdout and resolves `exited`. */
function fakeSpawn(scripts: ProcScript[]): FakeSpawnHandle {
  const kills: number[] = [];
  const stdins: string[] = [];
  let calls = 0;
  const spawn = ((_cmd: string[], _opts: object) => {
    const script = scripts[calls] ?? {};
    const procIdx = calls;
    calls += 1;
    stdins.push("");
    const enc = new TextEncoder();
    let outCtrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((r) => {
      resolveExit = r;
    });
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        outCtrl = c;
        for (const line of script.lines ?? []) c.enqueue(enc.encode(`${line}\n`));
        if (script.complete) {
          c.close();
          outCtrl = null;
          resolveExit(0);
        }
      },
    });
    return {
      pid: 999_000 + procIdx,
      stdin: {
        write(chunk: string) {
          stdins[procIdx] += chunk;
        },
        end() {},
      },
      stdout,
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      exited,
      kill() {
        kills.push(procIdx);
        try {
          outCtrl?.close();
        } catch {
          // already closed
        }
        resolveExit(143);
      },
    };
  }) as unknown as typeof Bun.spawn;
  return { spawn, kills, stdins };
}

/** Real streamChat through the injected spawn, with the REAL 60s timeout —
 * only cancellation (never the kill timer) may end these streams fast. */
function realStream(spawn: typeof Bun.spawn) {
  return (opts: StreamChatOptions) => streamChat({ ...opts, spawnFn: spawn, timeoutMs: 60_000 });
}

const PARTIAL = "half an answer nobody wants n";
const partialDeltaLine = JSON.stringify({
  type: "content_block_delta",
  delta: { text: PARTIAL },
});
function okTurnLines(text: string, usage = { input_tokens: 3, output_tokens: 7 }): string[] {
  return [
    JSON.stringify({
      type: "assistant",
      message: { id: "m-ok", content: [{ type: "text", text }] },
    }),
    JSON.stringify({ type: "result", usage, result: text }),
  ];
}

// ═════════════════════════ stop kills the subprocess ═══════════════════

describe("server — cancelling the live SSE body kills claude -p (fake spawn)", () => {
  test("mid-stream cancel: kill() lands fast, cancelled row on disk, no 60s wait", async () => {
    const { home, idx } = tmpHome();
    const fake = fakeSpawn([{ lines: [partialDeltaLine], complete: false }]);
    const app = mountApp(home, idx, realStream(fake.spawn));

    const started = Date.now();
    const { res, sid } = await post(app, { message: "please stop this" });
    const reader = res.body!.getReader();
    // Liveness gate — the abort must hit a LIVE stream (partial delta seen).
    const preCancelWire = await readWireUntil(reader, PARTIAL);
    expect(fake.kills).toHaveLength(0); // positive control: not dead yet

    await reader.cancel();

    await waitFor(() => (fake.kills.length > 0 ? true : null), "subprocess kill()");
    const rows = await waitForRows(home, sid, 2);
    const last = rows[rows.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(last.status).toBe("cancelled");
    // No error frame ever crossed the wire for a user stop (wire honesty).
    expect(preCancelWire).not.toContain("event: error");
    // Well before the 60s timeout the stream was armed with.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("REAL subprocess: cancel → pid gone (signal-0 ESRCH), no zombie", async () => {
    const { home, idx } = tmpHome();
    let pid = 0;
    const spawnReal = ((_cmd: string[], opts: object) => {
      const p = Bun.spawn(["sleep", "60"], opts as Parameters<typeof Bun.spawn>[1]);
      pid = p.pid;
      cleanups.push(() => {
        try {
          p.kill();
        } catch {
          // already gone — the point of the test
        }
      });
      return p;
    }) as unknown as typeof Bun.spawn;
    const app = mountApp(home, idx, realStream(spawnReal));

    const started = Date.now();
    const { res, sid } = await post(app, { message: "kill the real one" });
    const reader = res.body!.getReader();
    await reader.read(); // route's own message_start → stream is live
    expect(pid).toBeGreaterThan(0);
    // Positive control: alive BEFORE the cancel.
    expect(() => process.kill(pid, 0)).not.toThrow();

    await reader.cancel();

    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return null; // still alive
      } catch {
        return true; // ESRCH — gone
      }
    }, "real subprocess to die");
    expect(Date.now() - started).toBeLessThan(5_000);
    const rows = await waitForRows(home, sid, 2);
    expect(rows[rows.length - 1]!.status).toBe("cancelled");
  });
});

// ═══════════ cancelled persistence + next-turn context exclusion ══════

describe("server — cancelled turn persisted honestly, never re-fed", () => {
  test("partial text + cancel: status cancelled (not ok / not failed), user q preserved, tokens null, ledger empty", async () => {
    const { home, idx } = tmpHome();
    const fake = fakeSpawn([{ lines: [partialDeltaLine], complete: false }]);
    const app = mountApp(home, idx, realStream(fake.spawn));

    const { res, sid } = await post(app, { message: "question I walked away from" });
    const reader = res.body!.getReader();
    await readWireUntil(reader, PARTIAL); // abort AFTER partial text accrued
    await reader.cancel();

    const rows = await waitForRows(home, sid, 2);
    expect(rows).toHaveLength(2);
    // association preserved: the user question is the immediately preceding row
    expect(rows[0]!.role).toBe("user");
    expect(rows[0]!.content).toBe("question I walked away from");
    expect(rows[1]!.session_id).toBe(sid);
    const turn = rows[1]!;
    // the two prior misclassification shapes, pinned as explicit negatives:
    expect(turn.status).toBe("cancelled"); // NOT absent (= ok) — partial text must not become an ok turn
    expect(turn.error_reason).toBeUndefined(); // NOT empty_exit / failed
    expect(turn.error_message).toBeUndefined();
    expect(turn.content).toBe(PARTIAL); // stored for honesty
    expect(turn.tokens).toBeNull(); // no usage arrived → honest null
    expect(ledgerOnDisk(home)).toHaveLength(0); // nothing paid → nothing ledgered
  });

  test("3-turn session: turn-3 STDIN keeps the ok turn, drops the cancelled question AND the partial text", async () => {
    const { home, idx } = tmpHome();
    const fake = fakeSpawn([
      { lines: okTurnLines("the ocean looks blue because of scattering"), complete: true },
      { lines: [partialDeltaLine], complete: false },
      { lines: okTurnLines("second fine answer"), complete: true },
    ]);
    const app = mountApp(home, idx, realStream(fake.spawn));

    // Turn 1 — completes normally (positive control for context inclusion).
    const { res: r1, sid } = await post(app, { message: "why is the ocean blue" });
    await r1.text();
    await waitForRows(home, sid, 2);

    // Turn 2 — cancelled mid-stream via the REAL route path.
    const { res: r2 } = await post(app, { session_id: sid, message: "the repudiated question" });
    const reader = r2.body!.getReader();
    await readWireUntil(reader, PARTIAL);
    await reader.cancel();
    const rowsAfter2 = await waitForRows(home, sid, 4);
    expect(rowsAfter2[3]!.status).toBe("cancelled"); // seed really is a cancelled row

    // Turn 3 — capture what reaches the subprocess's stdin.
    const { res: r3 } = await post(app, { session_id: sid, message: "and why is the sky blue" });
    await r3.text();
    await waitForRows(home, sid, 6);

    const stdin3 = fake.stdins[2] ?? "";
    expect(stdin3.length).toBeGreaterThan(0);
    // prior ok turn present (both sides)
    expect(stdin3).toContain("[user] why is the ocean blue");
    expect(stdin3).toContain("the ocean looks blue because of scattering");
    // the new question present
    expect(stdin3).toContain("[user] and why is the sky blue");
    // the cancelled user question and its partial text NEVER re-enter context
    expect(stdin3).not.toContain("the repudiated question");
    expect(stdin3).not.toContain(PARTIAL);
  });

  test("parity edge: abort AFTER message_stop → complete reply stays ok + ledgered", async () => {
    const { home, idx } = tmpHome();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    cleanups.push(() => release());
    const app = mountApp(home, idx, async function* () {
      yield { type: "content_block_delta", text: "a complete paid answer" } as StreamEvent;
      yield {
        type: "message_stop",
        usage: { input_tokens: 11, output_tokens: 22 },
        full_text: "a complete paid answer",
      } as StreamEvent;
      await held; // keeps the stream open so the cancel lands after the stop
    });

    const { res, sid } = await post(app, { message: "late disconnect" });
    const reader = res.body!.getReader();
    await readWireUntil(reader, "message_stop");
    await reader.cancel(); // disconnect AFTER the answer completed
    release();

    const rows = await waitForRows(home, sid, 2);
    const turn = rows[rows.length - 1]!;
    expect(turn.status).toBeUndefined(); // ok turn — a finished answer is never discarded
    expect(turn.content).toBe("a complete paid answer");
    expect(turn.tokens).toEqual({ input: 11, output: 22 });
    const ledger = ledgerOnDisk(home);
    expect(ledger).toHaveLength(1); // paid-for usage IS ledgered
    expect(ledger[0]).toMatchObject({ kind: "chat", input_tokens: 11, output_tokens: 22 });
  });
});

// ═══════════════ browser disconnect = same kill path ═══════════════════

describe("server — disconnect kills the subprocess; no zombie, no fake ok turn", () => {
  test("body cancel with NO partial text → cancelled row (content ''), never an ok/failed empty turn, no ledger", async () => {
    const { home, idx } = tmpHome();
    const fake = fakeSpawn([{ complete: false }]); // hangs, emits nothing
    const app = mountApp(home, idx, realStream(fake.spawn));

    const started = Date.now();
    const { res, sid } = await post(app, { message: "tab closed" });
    const reader = res.body!.getReader();
    await reader.read(); // stream live (route's message_start)
    await reader.cancel(); // what the runtime fires when the socket dies

    await waitFor(() => (fake.kills.length > 0 ? true : null), "kill on disconnect");
    const rows = await waitForRows(home, sid, 2);
    const turn = rows[rows.length - 1]!;
    expect(turn.status).toBe("cancelled");
    expect(turn.content).toBe("");
    expect(turn.error_reason).toBeUndefined(); // NOT misread as empty_exit
    expect(turn.tokens).toBeNull();
    expect(ledgerOnDisk(home)).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("raw Request AbortSignal → same path: kill + cancelled row", async () => {
    const { home, idx } = tmpHome();
    const fake = fakeSpawn([{ complete: false }]);
    const app = mountApp(home, idx, realStream(fake.spawn));

    const ac = new AbortController();
    const { res, sid } = await post(app, { message: "signal leg" }, ac.signal);
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();

    await waitFor(() => (fake.kills.length > 0 ? true : null), "kill via request signal");
    const rows = await waitForRows(home, sid, 2);
    expect(rows[rows.length - 1]!).toMatchObject({ role: "assistant", status: "cancelled" });
    expect(ledgerOnDisk(home)).toHaveLength(0);
  });

  test("double-stop: body cancel + signal abort together → ONE kill, ONE cancelled row", async () => {
    const { home, idx } = tmpHome();
    const fake = fakeSpawn([{ complete: false }]);
    const app = mountApp(home, idx, realStream(fake.spawn));

    const ac = new AbortController();
    const { res, sid } = await post(app, { message: "double stop" }, ac.signal);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    ac.abort(); // second trigger must be a no-op

    await waitFor(() => (fake.kills.length > 0 ? true : null), "kill");
    const rows = await waitForRows(home, sid, 2);
    // settle window: give any duplicate persistence a chance to appear
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.kills).toHaveLength(1);
    expect(rowsOnDisk(home, sid)).toHaveLength(2);
    expect(rows[1]!.status).toBe("cancelled");
  });

  test("stop before any read: cancel still kills + persists a cancelled row", async () => {
    const { home, idx } = tmpHome();
    const fake = fakeSpawn([{ complete: false }]);
    const app = mountApp(home, idx, realStream(fake.spawn));

    const { res, sid } = await post(app, { message: "instant regret" });
    await res.body!.cancel(); // no read at all — earliest possible stop

    await waitFor(() => (fake.kills.length > 0 ? true : null), "kill on instant cancel");
    const rows = await waitForRows(home, sid, 2);
    expect(rows[rows.length - 1]!.status).toBe("cancelled");
  });
});

// ═══════════ client — islands: stop aborts, quiet marker ═════════════

/** Injected fetch for the /chat island: streams `deltaText`, then holds the
 * body open; aborting the signal errors the body with AbortError (exactly what
 * real fetch does when its signal fires mid-body). */
function sseFetchHoldingOpen(deltaText: string): {
  fetchFn: typeof fetch;
  seenSignal: () => AbortSignal | null;
} {
  let captured: AbortSignal | null = null;
  const enc = new TextEncoder();
  const fetchFn = ((url: string, init?: RequestInit) => {
    if (String(url).includes("context-preview")) {
      return Promise.resolve(Response.json({ page_label: "/", facts_count: 0 }));
    }
    captured = init?.signal ?? null;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          enc.encode(`event: content_block_delta\ndata: ${JSON.stringify({ text: deltaText })}\n\n`),
        );
        init?.signal?.addEventListener("abort", () => {
          c.error(new DOMException("The user aborted a request.", "AbortError"));
        });
      },
    });
    return Promise.resolve(
      new Response(body, {
        headers: { "content-type": "text/event-stream", "X-Siltpoke-Session-Id": "s-t5v" },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchFn, seenSignal: () => captured };
}

/** Injected fetch that never resolves /api/chat until the signal aborts —
 * the stop-before-first-byte shape. */
function fetchPendingUntilAbort(): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    if (String(url).includes("context-preview")) {
      return Promise.resolve(Response.json({ page_label: "/", facts_count: 0 }));
    }
    return new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () => {
        rej(new DOMException("The user aborted a request.", "AbortError"));
      });
    });
  }) as unknown as typeof fetch;
}

async function ticks(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

const ALL_ERROR_COPY = [...Object.values(CHAT_ERROR_COPY), CHAT_ERROR_FALLBACK_COPY];

describe("client — /chat island (makeChatStreamData)", () => {
  test("stop() mid-stream: fetch signal aborted, quiet marker, partial dropped, no error copy, composer ready", async () => {
    const { fetchFn, seenSignal } = sseFetchHoldingOpen("partial that must vanish");
    const d = makeChatStreamData(fetchFn);
    d.input = "a question";
    const sendP = d.send();
    // wait for the partial to land in the live buffer (stop hits a LIVE stream)
    await waitFor(() => (d.buffer.includes("partial that must vanish") ? true : null), "partial in buffer");
    expect(d.streaming).toBe(true);

    d.stop();
    await sendP;

    expect(seenSignal()?.aborted).toBe(true); // the fetch really was aborted
    // originating transcript: user turn + exactly one quiet cancelled marker
    expect(d.messages).toHaveLength(2);
    expect(d.messages[0]).toMatchObject({ role: "user", text: "a question" });
    expect(d.messages[1]).toMatchObject({
      role: "assistant",
      text: CHAT_STOPPED_MARKER,
      status: "cancelled",
    });
    // negatives: not an error state in ANY channel
    expect(d.error).toBeNull();
    expect(d.messages.filter((m) => m.status === "failed")).toHaveLength(0);
    for (const copy of ALL_ERROR_COPY) {
      expect(d.messages[1]!.text).not.toBe(copy);
    }
    // partial buffer dropped — never rendered as an assistant bubble
    expect(d.messages.some((m) => m.text.includes("partial that must vanish"))).toBe(false);
    // composer ready immediately
    expect(d.streaming).toBe(false);
    expect(d.buffer).toBe("");
    expect(d.abortController).toBeNull();
  });

  test("stop() before the first byte: same quiet outcome", async () => {
    const d = makeChatStreamData(fetchPendingUntilAbort());
    d.input = "never answered";
    const sendP = d.send();
    await ticks();
    expect(d.streaming).toBe(true);

    d.stop();
    await sendP;

    expect(d.messages[d.messages.length - 1]).toMatchObject({
      text: CHAT_STOPPED_MARKER,
      status: "cancelled",
    });
    expect(d.error).toBeNull();
    expect(d.streaming).toBe(false);
  });

  test("double-stop + idle stop are no-ops (one marker, no throw)", async () => {
    const d = makeChatStreamData(fetchPendingUntilAbort());
    expect(() => d.stop()).not.toThrow(); // idle — nothing in flight
    d.input = "q";
    const sendP = d.send();
    await ticks();
    d.stop();
    d.stop(); // second stop mid-teardown
    await sendP;
    expect(() => d.stop()).not.toThrow(); // idle again
    expect(d.messages.filter((m) => m.status === "cancelled")).toHaveLength(1);
    expect(d.error).toBeNull();
  });
});

describe("client — floating composer island (makeFloatingChatData)", () => {
  test("stopStreaming() mid-stream: marker lands in the ORIGINATING conversation, even after switching away", async () => {
    const { fetchFn } = sseFetchHoldingOpen("floating partial text");
    const d = makeFloatingChatData(fetchFn, { onGraph: () => false, getViewed: () => null });
    d.newConversation();
    const originId = d.activeId;
    d.draft = "floating question";
    const sendP = d.send();
    await ticks(6); // let the delta land
    expect(d.streaming).toBe(true);
    expect(d.abortController).not.toBeNull();

    d.newConversation(); // user switches away mid-stream
    expect(d.activeId).not.toBe(originId);

    d.stopStreaming();
    await sendP;

    const origin = d.conversations.find((c) => c.id === originId);
    const other = d.conversations.find((c) => c.id === d.activeId);
    const originMarkers = (origin?.messages ?? []).filter((m) => m.status === "cancelled");
    expect(originMarkers).toHaveLength(1);
    expect(originMarkers[0]!.text).toBe(CHAT_STOPPED_MARKER);
    expect((other?.messages ?? []).filter((m) => m.status === "cancelled")).toHaveLength(0);
    // partial text never renders anywhere
    for (const conv of d.conversations) {
      expect(conv.messages.some((m) => m.text.includes("floating partial text"))).toBe(false);
    }
    // quiet + ready
    expect(d.error).toBeNull();
    expect(d.streaming).toBe(false);
    expect(d.streamingConvId).toBeNull();
    expect(d.abortController).toBeNull();
  });

  test("stopStreaming() at idle is a no-op", () => {
    const { fetchFn } = sseFetchHoldingOpen("x");
    const d = makeFloatingChatData(fetchFn, { onGraph: () => false, getViewed: () => null });
    d.newConversation();
    expect(() => d.stopStreaming()).not.toThrow();
    expect(d.streaming).toBe(false);
  });
});

// ═══════════════ SSR — Stop control visible on both surfaces ══════════════

describe("SSR — floating composer: send button swaps to a stop control", () => {
  const html = String(FloatingChat());

  test("while streaming: plain button (no re-submit), wired to stopStreaming(), stays enabled", () => {
    // type swaps away from submit while streaming
    expect(html).toMatch(/streaming \? &#39;button&#39; : &#39;submit&#39;/);
    // click fires the abort
    expect(html).toContain("stopStreaming()");
    // enabled while streaming (a disabled stop is no stop at all)
    expect(html).toMatch(/:disabled="streaming \? false/);
  });

  test("glyph + accessible name swap between stop and send", () => {
    expect(html).toMatch(/streaming \? &#39;■&#39; : &#39;↑&#39;/);
    expect(html).toMatch(/streaming \? &#39;Stop&#39; : &#39;Send&#39;/);
  });
});

describe("SSR — /chat screen: visible Stop while streaming, quiet marker styling", () => {
  const html = String(Chat());

  test("Stop button: gated on streaming, plain type=button, wired to stop()", () => {
    const stopBtn = html.match(/<button[^>]*x-on:click="stop\(\)"[^>]*>/)?.[0];
    expect(stopBtn).toBeDefined();
    expect(stopBtn).toContain('type="button"'); // never submits the composer form
    expect(stopBtn).toContain('x-show="streaming"'); // visible only while a turn streams
    expect(html).toContain("■ Stop");
  });

  test("cancelled marker renders quiet (own centered style branch), error glyph reserved for failed", () => {
    // the message template styles cancelled entries distinctly from failed
    expect(html).toContain("msg.status === &#39;cancelled&#39;");
    // the ⚠ glyph is shown ONLY on failed entries — never on cancelled ones
    expect(html).toMatch(/x-show="msg\.status === &#39;failed&#39;"[^>]*>[\s\S]{0,80}⚠/);
  });

  test("Send button itself stays disabled while streaming (Stop is the live control)", () => {
    expect(html).toContain('x-bind:disabled="streaming || !input.trim()"');
  });
});

/**
 * chat-stream-hardening-server-verify.acceptance.test.ts — independent
 * acceptance verification for the server exit-reason plumbing + persistence
 * branching, intentionally using different oracles than the sibling file
 * (chat-stream-hardening-server.acceptance.test.ts):
 *
 *   • SSE assertions parse the wire into typed frames (event + JSON data),
 *     not substring greps — so "no stderr on the wire" is a key-absence
 *     check on the actual error frame payload.
 *   • The poisoned-history oracle is the bytes written to the fake subprocess's
 *     STDIN by the REAL streamChat (capture at proc.stdin.write), one level
 *     deeper than the sibling file's factory-level `opts.transcript` capture.
 *   • The poisoned-history fixtures are RAW pre-migration JSONL lines written
 *     straight to disk (no schema round-trip), so "rows without a status
 *     field" is tested against genuine legacy bytes.
 *   • An end-to-end loop test: request 1 REALLY times out through the route,
 *     request 2 in the same session proves the failed turn never reaches the
 *     next transcript while its user question survives.
 *
 * Failure honesty. Run:
 *   bun test tests/acceptance/chat-stream-hardening-server-verify.acceptance.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ── temp-home harness ────────────────────────────────────────────────────────

const teardowns: (() => void)[] = [];
afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
});

function tempHome(): { home: string; idx: ChatIndex } {
  const home = mkdtempSync(join(tmpdir(), "silt-verify-"));
  const idx = openIndex(home);
  teardowns.push(() => {
    idx.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, idx };
}

// ── scripted fake subprocess (drives the REAL streamChat) ────────────────────

interface ProcScript {
  /** NDJSON lines emitted on stdout before the scripted ending. */
  stdoutLines?: string[];
  /** Raw stderr text (emitted whole, then stderr closes). */
  stderrText?: string;
  /** Exit code used when stdout closes normally. Default 0. */
  exitCode?: number;
  /** Keep stdout open forever — only kill() (the timeout timer) ends it. */
  stall?: boolean;
  /** Error the stdout stream mid-read (drives the read-failure branch). */
  stdoutError?: string;
}

interface StdinCapture {
  chunks: string[];
}

function scriptedSpawn(script: ProcScript, capture?: StdinCapture): typeof Bun.spawn {
  const impl = () => {
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
    let settleExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      settleExit = resolve;
    });
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    return {
      stdin: {
        write(chunk: string | Uint8Array) {
          capture?.chunks.push(typeof chunk === "string" ? chunk : dec.decode(chunk));
        },
        end() {},
      },
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          for (const line of script.stdoutLines ?? []) c.enqueue(enc.encode(`${line}\n`));
          if (script.stdoutError) {
            c.error(new Error(script.stdoutError));
            settleExit(script.exitCode ?? 1);
            return;
          }
          if (!script.stall) {
            c.close();
            settleExit(script.exitCode ?? 0);
          }
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          if (script.stderrText) c.enqueue(enc.encode(script.stderrText));
          c.close();
        },
      }),
      exited,
      kill() {
        try {
          ctrl?.close();
        } catch {
          // already closed
        }
        settleExit(137);
      },
    };
  };
  return impl as unknown as typeof Bun.spawn;
}

const VERIFY_TIMEOUT_MS = 30; // injectable timeout — never the 60s default

/** Route-level factory that funnels the route's transcript into the REAL
 * streamChat over a scripted fake subprocess. `scriptRef` is read per call so
 * one app can serve differently-behaving consecutive requests. */
function liveFactory(scriptRef: { script: ProcScript; capture?: StdinCapture }) {
  return (opts: StreamChatOptions) =>
    streamChat({
      ...opts,
      spawnFn: scriptedSpawn(scriptRef.script, scriptRef.capture),
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
}

function buildApp(
  home: string,
  idx: ChatIndex,
  factory: (opts: StreamChatOptions) => AsyncGenerator<StreamEvent, void, void>,
): Hono {
  const app = new Hono();
  mountChatRoutes(app, { homeBase: home, index: idx, streamFactory: factory });
  return app;
}

// ── typed SSE frame parsing (not substring greps) ────────────────────────────

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

function parseSseFrames(sse: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of sse.split("\n\n")) {
    const lines = block.split("\n");
    const ev = lines.find((l) => l.startsWith("event: "));
    const data = lines.find((l) => l.startsWith("data: "));
    if (!ev || !data) continue;
    frames.push({
      event: ev.slice("event: ".length),
      data: JSON.parse(data.slice("data: ".length)) as Record<string, unknown>,
    });
  }
  return frames;
}

async function send(
  app: Hono,
  body: Record<string, unknown>,
): Promise<{ sid: string; sse: string; frames: SseFrame[] }> {
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  const sid = res.headers.get("X-Siltpoke-Session-Id") ?? "";
  expect(sid.length).toBeGreaterThan(0);
  const sse = await res.text();
  return { sid, sse, frames: parseSseFrames(sse) };
}

// ── on-disk oracles ──────────────────────────────────────────────────────────

function sessionFileRaw(home: string, sid: string): string {
  return readFileSync(join(home, "chats", `${sid}.jsonl`), "utf8");
}

function sessionRows(home: string, sid: string): Record<string, unknown>[] {
  return sessionFileRaw(home, sid)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function ledgerRows(home: string): Record<string, unknown>[] {
  const p = join(home, "usage-events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Writes RAW JSONL lines (genuine legacy / hand-shaped bytes, no schema
 * round-trip) as an existing session's history. */
function seedRawSession(home: string, sid: string, rows: Record<string, unknown>[]): void {
  mkdirSync(join(home, "chats"), { recursive: true });
  writeFileSync(
    join(home, "chats", `${sid}.jsonl`),
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
    "utf8",
  );
}

let rawSeq = 0;
function rawRow(
  sid: string,
  role: string,
  content: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  rawSeq += 1;
  // Deliberately MINIMAL keys — pre-migration rows have no status/model/tokens.
  return { id: `mv-${rawSeq}`, session_id: sid, role, content, ts: "2026-07-01T09:00:00Z", ...extra };
}

async function withConsoleErrorSpy<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = original;
  }
}

const OK_REPLY_LINES = [
  JSON.stringify({
    type: "assistant",
    message: { id: "msg_ok", content: [{ type: "text", text: "verified reply" }] },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "verified reply",
    usage: { input_tokens: 3, output_tokens: 4 },
  }),
];

// ═════ Timeout kill → failed turn + classified SSE error ════════════════════

describe("timeout", () => {
  test("hung claude -p is killed at timeoutMs; wire = error{reason:timeout}, store = failed row; no message_stop, no silent empty turn", async () => {
    const { home, idx } = tempHome();
    const app = buildApp(home, idx, liveFactory({ script: { stall: true } }));

    const { sid, frames } = await send(app, { message: "will you hang?" });

    // Wire: exactly zero message_stop frames, at least one classified error.
    expect(frames.filter((f) => f.event === "message_stop")).toHaveLength(0);
    const errors = frames.filter((f) => f.event === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.data.reason).toBe("timeout");
    expect(String(errors[0]?.data.error)).toContain(`${VERIFY_TIMEOUT_MS}ms`);

    // Store: user turn persisted, assistant turn failed with the enum.
    const rows = sessionRows(home, sid);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ role: "user", content: "will you hang?" });
    expect(rows[1]).toMatchObject({
      role: "assistant",
      content: "",
      status: "failed",
      error_reason: "timeout",
    });
    // No usage came back → honest tokens:null on the failed row.
    expect(rows[1]?.tokens).toBeNull();
  });
});

// ═════ spawn_failed (throw / non-zero exit / read failure) ══════════════════

describe("spawn_failed", () => {
  test("Bun.spawn throws (binary missing) → error{reason:spawn_failed} + failed row", async () => {
    const { home, idx } = tempHome();
    const explodingSpawn = (() => {
      throw new Error("posix_spawn 'claude': No such file or directory");
    }) as unknown as typeof Bun.spawn;
    const app = buildApp(home, idx, (opts) =>
      streamChat({ ...opts, spawnFn: explodingSpawn, timeoutMs: VERIFY_TIMEOUT_MS }),
    );

    const { sid, frames } = await send(app, { message: "hi" });

    expect(frames.filter((f) => f.event === "message_stop")).toHaveLength(0);
    const err = frames.find((f) => f.event === "error");
    expect(err?.data.reason).toBe("spawn_failed");
    expect(sessionRows(home, sid)[1]).toMatchObject({
      role: "assistant",
      status: "failed",
      error_reason: "spawn_failed",
      content: "",
    });
  });

  test("exit 3 with zero stdout → spawn_failed on wire and disk", async () => {
    const { home, idx } = tempHome();
    const app = buildApp(
      home,
      idx,
      liveFactory({ script: { stdoutLines: [], exitCode: 3, stderrText: "not logged in\n" } }),
    );

    const { result } = await withConsoleErrorSpy(() => send(app, { message: "hi" }));
    const { sid, frames } = result;

    expect(frames.filter((f) => f.event === "message_stop")).toHaveLength(0);
    expect(frames.find((f) => f.event === "error")?.data.reason).toBe("spawn_failed");
    const row = sessionRows(home, sid)[1];
    expect(row?.status).toBe("failed");
    expect(row?.error_reason).toBe("spawn_failed");
    expect(String(row?.error_message)).toContain("3");
  });

  test("stdout stream read failure (no text) → spawn_failed, not an unhandled throw", async () => {
    const { home, idx } = tempHome();
    const app = buildApp(
      home,
      idx,
      liveFactory({ script: { stdoutError: "EPIPE mid-stream", exitCode: 1 } }),
    );

    const { sid, frames } = await send(app, { message: "hi" });

    expect(frames.filter((f) => f.event === "message_stop")).toHaveLength(0);
    expect(frames.find((f) => f.event === "error")?.data.reason).toBe("spawn_failed");
    expect(sessionRows(home, sid)[1]?.error_reason).toBe("spawn_failed");
  });
});

// ═════ Exit 0, no assistant text → empty_exit ════════════════════════════════

describe("empty_exit", () => {
  test("clean exit with only non-text events → error{reason:empty_exit} + failed row", async () => {
    const { home, idx } = tempHome();
    const app = buildApp(
      home,
      idx,
      liveFactory({
        script: {
          stdoutLines: [JSON.stringify({ type: "system", subtype: "init", message: {} })],
          exitCode: 0,
        },
      }),
    );

    const { sid, frames } = await send(app, { message: "hi" });

    expect(frames.filter((f) => f.event === "message_stop")).toHaveLength(0);
    expect(frames.find((f) => f.event === "error")?.data.reason).toBe("empty_exit");
    expect(sessionRows(home, sid)[1]).toMatchObject({
      status: "failed",
      error_reason: "empty_exit",
      content: "",
    });
  });

  test("whitespace-only result text still counts as empty (trim discipline)", async () => {
    const { home, idx } = tempHome();
    const app = buildApp(
      home,
      idx,
      liveFactory({
        script: {
          stdoutLines: [JSON.stringify({ type: "result", subtype: "success", result: "   \n " })],
          exitCode: 0,
        },
      }),
    );

    const { sid, frames } = await send(app, { message: "hi" });

    expect(frames.find((f) => f.event === "error")?.data.reason).toBe("empty_exit");
    expect(sessionRows(home, sid)[1]?.status).toBe("failed");
  });
});

// ═════ stderr: log yes, store no, wire no ════════════════════════════════════

describe("stderr containment", () => {
  // A >300-char blob with a unique marker: cap discipline is observable too.
  const MARKER = "STDERR_CANARY_7f3a91xx";
  const BLOB = `${MARKER} ${"secret-token-material ".repeat(30)}`;

  test("stderr reaches console.error (daemon log) tagged with session id + reason; JSONL bytes and SSE payloads never contain it", async () => {
    const { home, idx } = tempHome();
    const app = buildApp(
      home,
      idx,
      liveFactory({ script: { stdoutLines: [], exitCode: 1, stderrText: BLOB } }),
    );

    const { result, logged } = await withConsoleErrorSpy(() => send(app, { message: "hi" }));
    const { sid, sse, frames } = result;

    // Server log: observable, session-tagged, reason-tagged, carries the tail.
    const logLine = logged.find((l) => l.includes(MARKER));
    expect(logLine).toBeDefined();
    expect(logLine).toContain(sid);
    expect(logLine).toContain("spawn_failed");

    // Store: raw bytes clean; row carries ONLY enum + short message.
    const raw = sessionFileRaw(home, sid);
    expect(raw).not.toContain(MARKER);
    const assistantRow = sessionRows(home, sid)[1] as Record<string, unknown>;
    expect(assistantRow.error_reason).toBe("spawn_failed");
    expect(typeof assistantRow.error_message).toBe("string");
    expect((assistantRow.error_message as string).length).toBeLessThanOrEqual(300);
    expect("stderr_tail" in assistantRow).toBe(false);

    // Wire: no frame's payload carries the blob or a stderr_tail key.
    expect(sse).not.toContain(MARKER);
    for (const f of frames) {
      expect("stderr_tail" in f.data).toBe(false);
    }
  });
});

// ═════ Transcript exclusion, observed at the subprocess's STDIN ═════════════

describe("poisoned history never reaches claude -p stdin", () => {
  test("stdin of the NEXT real streamChat call excludes failed/cancelled/empty turns", async () => {
    const { home, idx } = tempHome();
    const sid = "s-verify-ac5";
    seedRawSession(home, sid, [
      rawRow(sid, "user", "KEEP-Q-alpha"),
      rawRow(sid, "assistant", "KEEP-A-alpha"), // pre-migration ok row (no status)
      rawRow(sid, "assistant", ""), // pre-migration EMPTY row (no status) → drop
      rawRow(sid, "assistant", "   "), // whitespace-only legacy row → drop
      rawRow(sid, "user", "KEEP-Q-beta-before-failed"),
      rawRow(sid, "assistant", "", {
        status: "failed",
        error_reason: "timeout",
        error_message: "claude -p timed out after 60000ms",
      }), // failed → drop, but its user question is KEPT
      rawRow(sid, "user", "DROP-Q-gamma-before-cancelled"),
      rawRow(sid, "assistant", "DROP-A-gamma-partial", { status: "cancelled" }), // cancelled → drop + drops its user q
    ]);

    const capture: StdinCapture = { chunks: [] };
    const app = buildApp(
      home,
      idx,
      liveFactory({ script: { stdoutLines: OK_REPLY_LINES }, capture }),
    );

    await send(app, { session_id: sid, message: "NEW-QUESTION-omega" });

    const stdin = capture.chunks.join("");
    expect(stdin.length).toBeGreaterThan(0); // oracle actually captured bytes

    // Kept: ok history + the failed turn's user question + the new message.
    expect(stdin).toContain("[user] KEEP-Q-alpha");
    expect(stdin).toContain("[assistant] KEEP-A-alpha");
    expect(stdin).toContain("[user] KEEP-Q-beta-before-failed");
    expect(stdin).toContain("[user] NEW-QUESTION-omega");

    // Dropped: cancelled turn AND its user question.
    expect(stdin).not.toContain("DROP-A-gamma-partial");
    expect(stdin).not.toContain("DROP-Q-gamma-before-cancelled");

    // Dropped: every empty/whitespace assistant line (pre-migration + failed).
    expect(stdin).not.toMatch(/\[assistant\]\s*(?:\n|$)/);
  });

  test("end-to-end loop: a turn that REALLY fails via the route is excluded from the following request's stdin", async () => {
    const { home, idx } = tempHome();
    const scriptRef: { script: ProcScript; capture?: StdinCapture } = {
      script: { stall: true }, // request 1: timeout
    };
    const app = buildApp(home, idx, liveFactory(scriptRef));

    // Request 1 — real timeout through the route.
    const first = await send(app, { message: "FIRST-QUESTION-kappa" });
    expect(first.frames.find((f) => f.event === "error")?.data.reason).toBe("timeout");

    // Request 2 — same session, healthy subprocess, capture stdin.
    const capture: StdinCapture = { chunks: [] };
    scriptRef.script = { stdoutLines: OK_REPLY_LINES };
    scriptRef.capture = capture;
    await send(app, { session_id: first.sid, message: "SECOND-QUESTION-lambda" });

    const stdin = capture.chunks.join("");
    // Failed turn's user question survives (backend failed, not the user)…
    expect(stdin).toContain("[user] FIRST-QUESTION-kappa");
    expect(stdin).toContain("[user] SECOND-QUESTION-lambda");
    // …but no empty assistant line from the failed turn leaks into context.
    expect(stdin).not.toMatch(/\[assistant\]\s*(?:\n|$)/);
    expect(stdin).not.toContain("timed out"); // error_message never becomes context
  });
});

// ═════ Ledger gated on real usage presence ══════════════════════════════════

describe("ledger honesty", () => {
  test("timeout with no usage → ledger file never created", async () => {
    const { home, idx } = tempHome();
    const app = buildApp(home, idx, liveFactory({ script: { stall: true } }));

    await send(app, { message: "hi" });

    expect(existsSync(join(home, "usage-events.jsonl"))).toBe(false);
  });

  test("spawn_failed and empty_exit (no usage) → still zero ledger rows", async () => {
    const { home, idx } = tempHome();
    const scriptRef: { script: ProcScript } = { script: { stdoutLines: [], exitCode: 2 } };
    const app = buildApp(home, idx, liveFactory(scriptRef));

    await send(app, { message: "spawn-fail turn" });
    scriptRef.script = { stdoutLines: [], exitCode: 0 };
    await send(app, { message: "empty-exit turn" });

    expect(ledgerRows(home)).toHaveLength(0);
  });

  test("usage delivered BEFORE the timeout kill IS ledgered (exact tokens) and rides the failed row", async () => {
    const { home, idx } = tempHome();
    const app = buildApp(
      home,
      idx,
      liveFactory({
        script: {
          stdoutLines: [
            JSON.stringify({
              type: "result",
              subtype: "success",
              result: "",
              usage: { input_tokens: 41, output_tokens: 17 },
            }),
          ],
          stall: true, // usage arrives, then the process hangs → timeout kill
        },
      }),
    );

    const { sid } = await send(app, { message: "hi" });

    const rows = sessionRows(home, sid);
    expect(rows[1]).toMatchObject({
      status: "failed",
      error_reason: "timeout",
      tokens: { input: 41, output: 17 }, // pre-kill usage persisted honestly
    });

    const ledger = ledgerRows(home);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      kind: "chat",
      session_id: sid,
      input_tokens: 41,
      output_tokens: 17,
    });
  });

  test("positive control — success ledgers exactly one chat row and persists a lean ok turn", async () => {
    const { home, idx } = tempHome();
    const app = buildApp(home, idx, liveFactory({ script: { stdoutLines: OK_REPLY_LINES } }));

    const { sid, frames } = await send(app, { message: "hi" });

    const stop = frames.find((f) => f.event === "message_stop");
    expect(stop?.data.full_text).toBe("verified reply");
    expect(frames.filter((f) => f.event === "error")).toHaveLength(0);

    const row = sessionRows(home, sid)[1] as Record<string, unknown>;
    expect(row.content).toBe("verified reply");
    expect("status" in row).toBe(false); // lean pre-migration shape kept
    expect("error_reason" in row).toBe(false);

    const ledger = ledgerRows(home);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      kind: "chat",
      session_id: sid,
      input_tokens: 3,
      output_tokens: 4,
    });
  });
});

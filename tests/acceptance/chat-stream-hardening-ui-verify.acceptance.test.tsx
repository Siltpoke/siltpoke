/** @jsxImportSource hono/jsx */
/**
 * chat-stream-hardening-ui-verify.acceptance.test.tsx — independent
 * acceptance verification for the chat-stream-hardening track.
 *
 *
 *   Each failure reason (timeout / spawn_failed / empty_exit) renders
 *        DISTINCT fixed pet-voice copy in an error card on BOTH surfaces
 *        (floating widget + standalone /chat); card visually distinct from
 *        conversation bubbles.
 *   Reloading/lazy-loading a session with persisted failed turns renders
 *        them as error cards, never blank assistant bubbles; the old
 *        empty-stream string appears nowhere.
 *
 * ORACLE LEVELS (strongest reachable per assertion):
 *   L1 — end-to-end through the REAL server: in-process Hono app + REAL
 *        mountChatRoutes + REAL streamChat driven by a fake Bun.spawn
 *        (streamFactory seam, the same seam the earlier hardening
 *        acceptance suite uses),
 *        SSE body consumed by the REAL island data objects
 *        (makeChatStreamData / makeFloatingChatData with injected fetch).
 *   L2 — history leg: real JSONL rows seeded via the REAL schema + store,
 *        served by the REAL GET /api/chat/sessions/:id/messages route, fed
 *        through the floating island's REAL openConversation path.
 *   L3 — SSR markup: render Chat.tsx + FloatingChat.tsx, assert the
 *        three-way branch (bubble / error card / stopped marker) markup.
 *   L4 — old-string absence: independent file walk over src/ + tests/ +
 *        scripts/ (needle built from parts so this file never matches).
 *
 * HONESTY NOTE (stubs): the LLM subprocess is faked at the Bun.spawn /
 * streamFactory seam (no real `claude -p`); everything downstream — route,
 * SSE encoding, JSONL persistence, island parsing + message model — is real.
 * "Rendered state" is asserted at the island message-model level plus the SSR
 * template markup (L3); a live Alpine DOM mount is not exercised — the repo's
 * island tests are factory-level by design (no Alpine runtime harness exists).
 *
 * Copy strings below are hand-transcribed from the pet-voice copy table and
 * DELIBERATELY not imported from src/web/client/lib/chat-error-copy.ts —
 * importing the implementation's constants would make the oracle circular.
 * A transcription guard asserts each string appears verbatim in the reference doc.
 *
 * Run: bun test tests/acceptance/chat-stream-hardening-ui-verify.acceptance.test.tsx
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { type ChatIndex, openIndex } from "../../src/chat/fts5-index";
import { appendMessage } from "../../src/chat/jsonl-store";
import { type ChatMessage, chatMessageSchema } from "../../src/chat/schema";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import {
  type StreamChatOptions,
  type StreamEvent,
  streamChat,
} from "../../src/daemon/routes/chat-stream";
import { makeChatStreamData } from "../../src/web/client/islands/chat-stream";
import { makeFloatingChatData } from "../../src/web/client/islands/floating-chat";
import { FloatingChat } from "../../src/web/_shared/FloatingChat";
import { Chat } from "../../src/web/screens/Chat";

// ── Pet-voice copy table (hand-transcribed — independent oracle) ─────────────

const SPEC_COPY: Record<string, string> = {
  timeout:
    "I waited a whole minute but my brain never answered. (backend timeout — try sending that again?)",
  spawn_failed:
    "I couldn't reach my brain at all just now. (couldn't start claude — is it installed and logged in?)",
  empty_exit: "My brain came back with… nothing. (empty response — try once more?)",
};
const SPEC_FALLBACK = "Something broke on my side. (unknown error — try again?)";

/** Old string, built from parts so THIS file never matches its own grep. */
const OLD_STRING = ["No reply ", "received (backend ", "returned empty stream)"].join("");

const REPO_ROOT = join(import.meta.dir, "..", "..");

// ── harness (adapted from the earlier hardening acceptance file) ─────────────

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

type StreamFactory = (opts: StreamChatOptions) => AsyncGenerator<StreamEvent, void, void>;

function appWith(home: string, idx: ChatIndex, streamFactory: StreamFactory): Hono {
  const app = new Hono();
  mountChatRoutes(app, { homeBase: home, index: idx, streamFactory });
  return app;
}

/** Bridge the island's injected fetch into the in-process Hono app. */
function fetchVia(app: Hono): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(input instanceof Request ? input : String(input), init)) as typeof fetch;
}

interface FakeProcOpts {
  lines?: string[];
  stderrChunks?: string[];
  exitCode?: number;
  /** keep stdout open — only the kill timer ends the stream (timeout path). */
  hang?: boolean;
}

/** Fake Bun.spawn driving the REAL streamChat classification. */
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
        /* already closed */
      }
      resolveExit(143);
    },
  };
  return (() => proc) as unknown as typeof Bun.spawn;
}

function realStreamWith(spawnFn: typeof Bun.spawn, timeoutMs = 40): StreamFactory {
  return (opts: StreamChatOptions) => streamChat({ ...opts, spawnFn, timeoutMs });
}

/** Per-reason server setups. RAW_STDERR marker must never reach the UI model. */
const RAW_STDERR = "RAW_STDERR_MARKER_do_not_render";
const FAILURE_SETUPS: Record<string, () => StreamFactory> = {
  timeout: () => realStreamWith(fakeProc({ hang: true, stderrChunks: [RAW_STDERR] })),
  spawn_failed: () =>
    realStreamWith(
      (() => {
        throw new Error(`ENOENT no such file claude ${RAW_STDERR}`);
      }) as unknown as typeof Bun.spawn,
    ),
  empty_exit: () =>
    realStreamWith(fakeProc({ lines: [], exitCode: 0, stderrChunks: [RAW_STDERR] })),
};

/** Route-catch path: a streamFactory that throws mid-iteration — the real
 * route classifies it as a NO-REASON failure (fallback copy on the client). */
function throwingStreamFactory(): StreamFactory {
  // eslint-disable-next-line require-yield
  return async function* () {
    throw new Error(`internal kaboom ${RAW_STDERR}`);
  };
}

interface DisplayMsg {
  role: string;
  text: string;
  status?: string;
  error_reason?: string;
}

// ── transcription guard ──────────────────────────────────────────────────────

describe("error-copy guard", () => {
  // Drift guard: the hardcoded oracle strings must match the source
  // reference copy verbatim. That reference isn't shipped, so this runs
  // only when SILTPOKE_CHATSTREAM_SPEC points at it locally.
  const SPEC_DOC = process.env.SILTPOKE_CHATSTREAM_SPEC;
  test.skipIf(!SPEC_DOC || !existsSync(SPEC_DOC))(
    "every hardcoded oracle string appears verbatim in the reference doc",
    () => {
      const spec = readFileSync(SPEC_DOC as string, "utf8");
      for (const s of [...Object.values(SPEC_COPY), SPEC_FALLBACK]) {
        expect(spec).toContain(s);
      }
    },
  );

  test("the three reason copies are pairwise DISTINCT", () => {
    const vals = Object.values(SPEC_COPY);
    expect(new Set([...vals, SPEC_FALLBACK]).size).toBe(4);
  });
});

// ── L1 — standalone /chat island through the real server ───────────────────

describe("standalone /chat island: live failure → error card (L1, real server)", () => {
  for (const reason of ["timeout", "spawn_failed", "empty_exit"] as const) {
    test(`${reason} → exact spec copy, failed card, no blank bubble, no raw internals`, async () => {
      const { home, idx } = freshHome();
      const app = appWith(home, idx, FAILURE_SETUPS[reason]());
      const data = makeChatStreamData(fetchVia(app));
      data.sessionId = `standalone-${reason}`;
      data.input = "hello there";

      await data.send();

      const msgs = data.messages as DisplayMsg[];
      expect(msgs.length).toBe(2); // user turn + error card — message never vanishes
      expect(msgs[0]).toMatchObject({ role: "user", text: "hello there" });
      const card = msgs[1];
      expect(card.role).toBe("assistant");
      expect(card.status).toBe("failed");
      expect(card.error_reason).toBe(reason);
      expect(card.text).toBe(SPEC_COPY[reason]); // EXACT fixed pet-voice copy
      expect(card.text.trim().length).toBeGreaterThan(0); // never a blank bubble
      // raw server internals never reach the model
      const flat = JSON.stringify(msgs) + String(data.error);
      expect(flat).not.toContain(RAW_STDERR);
      expect(flat).not.toContain(OLD_STRING);
      // the failure renders as an in-transcript card, not the plain error line
      expect(data.error).toBeNull();
      expect(data.streaming).toBe(false);
    });
  }

  test("route-catch failure (no reason enum) → fallback copy", async () => {
    const { home, idx } = freshHome();
    const app = appWith(home, idx, throwingStreamFactory());
    const data = makeChatStreamData(fetchVia(app));
    data.sessionId = "standalone-fallback";
    data.input = "hi";

    await data.send();

    const card = (data.messages as DisplayMsg[])[1];
    expect(card.status).toBe("failed");
    expect(card.error_reason).toBeUndefined();
    expect(card.text).toBe(SPEC_FALLBACK);
    expect(card.text).not.toContain("kaboom"); // raw message never rendered
  });
});

// ── L1 — floating widget island through the real server ───────────────────

function freshFloating(app: Hono) {
  const data = makeFloatingChatData(fetchVia(app), {
    getViewed: () => null,
    onGraph: () => false,
    pageProvider: () => "/",
  });
  data.newConversation();
  return data;
}

describe("floating widget island: live failure → error card (L1, real server)", () => {
  for (const reason of ["timeout", "spawn_failed", "empty_exit"] as const) {
    test(`${reason} → exact spec copy, failed card in the conversation`, async () => {
      const { home, idx } = freshHome();
      const app = appWith(home, idx, FAILURE_SETUPS[reason]());
      const data = freshFloating(app);
      data.draft = "hello there";

      await data.send();

      const conv = data.active();
      expect(conv).not.toBeNull();
      const msgs = (conv?.messages ?? []) as DisplayMsg[];
      expect(msgs.length).toBe(2);
      expect(msgs[0]).toMatchObject({ role: "user", text: "hello there" });
      const card = msgs[1];
      expect(card.role).toBe("assistant");
      expect(card.status).toBe("failed");
      expect(card.error_reason).toBe(reason);
      expect(card.text).toBe(SPEC_COPY[reason]);
      const flat = JSON.stringify(msgs) + String(data.error);
      expect(flat).not.toContain(RAW_STDERR);
      expect(flat).not.toContain(OLD_STRING);
      expect(data.error).toBeNull();
      expect(data.streaming).toBe(false);
    });
  }

  test("route-catch failure (no reason enum) → fallback copy", async () => {
    const { home, idx } = freshHome();
    const app = appWith(home, idx, throwingStreamFactory());
    const data = freshFloating(app);
    data.draft = "hi";

    await data.send();

    const card = (data.active()?.messages ?? [])[1] as DisplayMsg;
    expect(card.status).toBe("failed");
    expect(card.text).toBe(SPEC_FALLBACK);
    expect(card.text).not.toContain("kaboom");
  });
});

// ── L3 — SSR markup: card visually distinct on both surfaces ───────────────

describe("SSR markup three-way branch (L3)", () => {
  test("standalone Chat.tsx: failed card branch distinct from bubbles + cancelled marker", () => {
    const html = String(<Chat />);
    // failed → distinct card via the x-bind:style branch: full-width stretch
    // + bordered card background (≠ 70% bubble). The dead chat-error-card /
    // chat-stopped-marker class literals were removed from Chat.tsx (no
    // stylesheet targeted them); these assertions are on the style-branch
    // condition instead.
    // (Hono JSX escapes single quotes to &#39; in emitted attributes)
    expect(html).toContain("msg.status === &#39;failed&#39;");
    expect(html).toContain("alignSelf: &#39;stretch&#39;");
    expect(html).toContain("background: &#39;#f7ede4&#39;");
    // cancelled → quiet centered marker branch (style, not class)
    expect(html).toContain("alignSelf: &#39;center&#39;");
    expect(html).toContain("msg.status === &#39;cancelled&#39;");
    // normal bubbles still keyed on role
    expect(html).toContain("msg.role === &#39;user&#39;");
    // status glyph present, text rendered via x-text (no HTML injection path)
    expect(html).toContain("⚠");
    expect(html).toContain('x-text="msg.text"');
  });

  test("FloatingChat.tsx: failed card branch distinct from bubbles + cancelled marker", () => {
    const html = String(<FloatingChat />);
    // three-way conditional present
    expect(html).toContain("m.status === &#39;failed&#39;");
    expect(html).toContain("m.status === &#39;cancelled&#39;");
    // failed card style: full-width + bordered card (≠ white bubble)
    expect(html).toContain("align-self:stretch");
    expect(html).toContain("border:1px solid rgba(176,60,20,0.18)");
    // markdown rendering is GATED OFF for status entries (no renderMd of copy)
    expect(html).toContain("m.role === &#39;assistant&#39; &amp;&amp; !m.status");
    // glyph + plain-text copy rendering
    expect(html).toContain("⚠");
    expect(html).toContain('x-text="m.text"');
  });
});

// ── L2 — persisted failed turns → error cards on history load ──────────────

const HIDDEN_HINT = "SHOULD_NOT_RENDER_HINT";
const PARTIAL_CANCELLED = "partial reply that must stay hidden this track";

function seedRow(
  sid: string,
  n: number,
  role: "user" | "assistant",
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return chatMessageSchema.parse({
    id: `m${n}`,
    session_id: sid,
    role,
    content,
    ts: new Date(1700000000000 + n * 1000).toISOString(),
    model: role === "assistant" ? "claude-sonnet-4-6" : null,
    tokens: null,
    ...extra,
  });
}

async function seedHistorySession(home: string): Promise<string> {
  const sid = "history-1";
  const rows: ChatMessage[] = [
    seedRow(sid, 1, "user", "q1 fine question"),
    seedRow(sid, 2, "assistant", "a1 fine answer"),
    seedRow(sid, 3, "user", "q2 hit a timeout"),
    seedRow(sid, 4, "assistant", "", {
      status: "failed",
      error_reason: "timeout",
      error_message: HIDDEN_HINT,
    }),
    seedRow(sid, 5, "user", "q3 unclassified failure"),
    seedRow(sid, 6, "assistant", "", { status: "failed", error_message: HIDDEN_HINT }),
    seedRow(sid, 7, "user", "q4 then I hit stop"),
    seedRow(sid, 8, "assistant", PARTIAL_CANCELLED, { status: "cancelled" }),
  ];
  for (const r of rows) await appendMessage(home, sid, r);
  return sid;
}

describe("persisted failed turns render as error cards, never blank bubbles (L2)", () => {
  test("server leg: GET /sessions/:id/messages passes status + error_reason through", async () => {
    const { home, idx } = freshHome();
    const sid = await seedHistorySession(home);
    const app = appWith(home, idx, throwingStreamFactory());

    const res = await app.request(`/api/chat/sessions/${sid}/messages`);
    expect(res.status).toBe(200);
    const { messages } = (await res.json()) as { messages: DisplayMsg[] };
    expect(messages.length).toBe(8);
    expect(messages[3]).toMatchObject({ role: "assistant", status: "failed", error_reason: "timeout" });
    expect(messages[5]).toMatchObject({ role: "assistant", status: "failed" });
    expect(messages[5].error_reason).toBeUndefined();
    expect(messages[7]).toMatchObject({ role: "assistant", status: "cancelled" });
  });

  test("floating island lazy-load: failed rows → exact-copy cards, zero blank assistant bubbles", async () => {
    const { home, idx } = freshHome();
    const sid = await seedHistorySession(home);
    const app = appWith(home, idx, throwingStreamFactory());
    const data = makeFloatingChatData(fetchVia(app), {
      getViewed: () => null,
      onGraph: () => false,
      pageProvider: () => "/",
    });
    // Rehydrated-conversation shape (same fields loadSessions() constructs).
    data.conversations = [
      {
        id: sid,
        serverSessionId: sid,
        anchor: null,
        anchorNodeId: null,
        label: "Chat",
        pin: "",
        badge: "",
        title: "q1 fine question",
        pinSent: true,
        createdAt: new Date().toISOString(),
        messages: [],
        count: 8,
      },
    ];

    await data.openConversation(sid);

    const msgs = (data.active()?.messages ?? []) as DisplayMsg[];
    expect(msgs.length).toBe(8);

    // ok rows untouched
    expect(msgs[1]).toMatchObject({ role: "assistant", text: "a1 fine answer" });
    expect(msgs[1].status).toBeUndefined();

    // failed(timeout) → EXACT reason copy as an error card
    expect(msgs[3].status).toBe("failed");
    expect(msgs[3].text).toBe(SPEC_COPY.timeout);

    // failed(no reason) → EXACT fallback copy
    expect(msgs[5].status).toBe("failed");
    expect(msgs[5].text).toBe(SPEC_FALLBACK);

    // cancelled → quiet marker; the partial content stays hidden this track
    expect(msgs[7].status).toBe("cancelled");
    expect(msgs[7].text.trim().length).toBeGreaterThan(0);
    expect(msgs[7].text).not.toBe(PARTIAL_CANCELLED);

    // ZERO blank assistant bubbles anywhere in the rendered model
    const blanks = msgs.filter((m) => m.role === "assistant" && m.text.trim() === "");
    expect(blanks.length).toBe(0);

    // old string + stored error_message hint never surface
    const flat = JSON.stringify(msgs);
    expect(flat).not.toContain(OLD_STRING);
    expect(flat).not.toContain(HIDDEN_HINT);
  });
});

// ── L4 — old string retired everywhere ──────────────────────────────────────

const TEXT_EXT = /\.(ts|tsx|js|jsx|cjs|mjs|json|md|sh|yml|yaml|txt|css|html)$/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (st.isFile() && TEXT_EXT.test(entry) && st.size < 2_000_000) yield p;
  }
}

describe("old empty-stream string appears nowhere (L4, independent walk)", () => {
  test("src/ + tests/ + scripts/ contain zero occurrences of the retired string", () => {
    const offenders: string[] = [];
    for (const root of ["src", "tests", "scripts"]) {
      for (const f of walk(join(REPO_ROOT, root))) {
        if (readFileSync(f, "utf8").includes(OLD_STRING)) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});

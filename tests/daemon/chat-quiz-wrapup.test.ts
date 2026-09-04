// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openIndex } from "../../src/chat/fts5-index";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import type { ModuleGraph } from "../../src/repo-graph/module-graph";

const mg: ModuleGraph = { modules: ["src/web", "src/daemon"], edges: [["src/web", "src/daemon"]], resolvedInternal: 1, unresolvedInternal: 0 };

// NOTE: the brief's literal fixture used a bare `{ insertMessage() {}, search:
// () => [] }` stand-in for `index`. That works for the OPENER test in
// chat-quiz-route.test.ts only because the opener's message is empty
// (isEmptyQuizOpener skips appendMessage/insertMessage entirely). Here the
// continuation carries a real, non-empty answer ("web depends on daemon"),
// so chat.ts's normal (pre-existing, untouched-by-Task-7) message-append path
// calls the REAL module-level `insertMessage(deps.index, msg)`, which reads
// `idx.db` — a fake object without `.db` throws before any quiz/wrap-up logic
// ever runs. chat-quiz-route.test.ts's own second test hit this exact issue
// and fixed it the same way (real `openIndex` over a tmp dir) — mirrored here.
it("emits wrap-up once, then a fixed complete-line, never a score", async () => {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-quiz-wrapup-"));
  const idx = openIndex(home);
  const mem = new Map<string, any>();
  // Pre-seed a state one turn from the budget so the next answer wraps.
  mem.set("qw", { mode: "quiz", scope: { moduleId: null }, overlay: { supported: new Set(["src/web->src/daemon"]), contradicted: new Set(), unverified: new Set(), userEntities: new Set(["src/web"]), hintEntities: new Set() }, currentTarget: { kind: "dependency_edge", a: "src/web", b: "src/daemon" }, ladderStep: null, turnCount: 7, wrappedUp: false });
  const app = new Hono();
  mountChatRoutes(app, { homeBase: home, index: idx, secret: "s",
    loadModuleGraph: async () => mg,
    quizStore: { read: async (id: string) => mem.get(id) ?? null, write: async (id: string, s: any) => void mem.set(id, s) },
    readSession: async () => [],
    streamFactory: async function* () { yield { type: "message_start", message_id: "m", model: "t" }; yield { type: "content_block_delta", text: "x" }; yield { type: "message_stop", usage: { input_tokens: 1, output_tokens: 1 }, full_text: "x" }; } as any,
  } as any);
  try {
    const r1 = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" }, body: JSON.stringify({ message: "web depends on daemon", session_id: "qw", page: "repo-graph" }) });
    const b1 = await r1.text();
    expect(b1).not.toMatch(/\d+ *%|score|tally|streak/i);
    expect(mem.get("qw").wrappedUp).toBe(true);
    const r2 = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" }, body: JSON.stringify({ message: "and daemon?", session_id: "qw", page: "repo-graph" }) });
    const b2 = await r2.text();
    expect(b2).toMatch(/complete|new one/i);   // fixed complete-line, not a second wrap
  } finally {
    idx.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// Fix (post-review polish, R7.2): the wrap-up turn and the post-wrap dedupe
// turn both emit their text via `singleTextStream` — a synthetic
// message_stop that sets `red.sawUsage = true` even though NO real Brain
// call happened (ZERO_QUIZ_USAGE is a present-but-zero placeholder, not a
// real usage object). Left ungated, `ledgerBrainCall` fired a phantom $0
// row for these turns, violating its own doc-invariant (src/state/usage.ts:
// "Call ONLY on a real ... charged call"). `ledgerBrainCall` is injected via
// the same optional-DI seam as `streamFactory`/`readMemory` so this test can
// assert zero calls without touching the real usage-events.jsonl file.
it("does NOT ledger a Brain call for the wrap-up turn or the post-wrap dedupe turn", async () => {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-quiz-wrapup-ledger-"));
  const idx = openIndex(home);
  const mem = new Map<string, any>();
  mem.set("qwl", { mode: "quiz", scope: { moduleId: null }, overlay: { supported: new Set(["src/web->src/daemon"]), contradicted: new Set(), unverified: new Set(), userEntities: new Set(["src/web"]), hintEntities: new Set() }, currentTarget: { kind: "dependency_edge", a: "src/web", b: "src/daemon" }, ladderStep: null, turnCount: 7, wrappedUp: false });
  const ledgerCalls: unknown[] = [];
  const app = new Hono();
  mountChatRoutes(app, { homeBase: home, index: idx, secret: "s",
    loadModuleGraph: async () => mg,
    quizStore: { read: async (id: string) => mem.get(id) ?? null, write: async (id: string, s: any) => void mem.set(id, s) },
    readSession: async () => [],
    streamFactory: async function* () { yield { type: "message_start", message_id: "m", model: "t" }; yield { type: "content_block_delta", text: "x" }; yield { type: "message_stop", usage: { input_tokens: 1, output_tokens: 1 }, full_text: "x" }; } as any,
    ledgerBrainCall: async (_basePath: string, args: unknown) => {
      ledgerCalls.push(args);
    },
  } as any);
  try {
    // r1 crosses into wrap-up (deterministic wrapText, no Brain call). The
    // SSE body streams the quiz-store write + ledger check from inside its
    // own async start() callback — must drain the body (await .text()) before
    // asserting on either side effect, or the assertion races the stream.
    const r1 = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" }, body: JSON.stringify({ message: "web depends on daemon", session_id: "qwl", page: "repo-graph" }) });
    await r1.text();
    expect(mem.get("qwl").wrappedUp).toBe(true);
    // r2 is the dedupe/already-wrapped continuation (fixed complete-line, no Brain call).
    const r2 = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" }, body: JSON.stringify({ message: "and daemon?", session_id: "qwl", page: "repo-graph" }) });
    await r2.text();
    expect(ledgerCalls).toEqual([]);
  } finally {
    idx.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// Regression guard for the same fix: a normal (non-quiz) turn with a REAL
// message_stop usage must still ledger truthfully — the guard must gate
// only the two no-Brain-call quiz branches, never a real call.
it("still ledgers a real Brain call for a normal (non-quiz) turn", async () => {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-quiz-wrapup-ledger-normal-"));
  const idx = openIndex(home);
  const ledgerCalls: unknown[] = [];
  const app = new Hono();
  mountChatRoutes(app, { homeBase: home, index: idx, secret: "s",
    readSession: async () => [],
    streamFactory: async function* () { yield { type: "message_start", message_id: "m", model: "t" }; yield { type: "content_block_delta", text: "hi" }; yield { type: "message_stop", usage: { input_tokens: 3, output_tokens: 5 }, full_text: "hi" }; } as any,
    ledgerBrainCall: async (_basePath: string, args: unknown) => {
      ledgerCalls.push(args);
    },
  } as any);
  try {
    const r1 = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" }, body: JSON.stringify({ message: "hello", session_id: "normal-1", page: "repo-graph" }) });
    await r1.text();
    expect(ledgerCalls.length).toBe(1);
    expect(ledgerCalls[0]).toMatchObject({ kind: "chat", session_id: "normal-1", usage: { input_tokens: 3, output_tokens: 5 } });
  } finally {
    idx.close();
    rmSync(home, { recursive: true, force: true });
  }
});

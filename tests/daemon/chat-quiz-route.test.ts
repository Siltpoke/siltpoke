// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import type { StreamChatOptions } from "../../src/daemon/routes/chat-stream";
import { openIndex } from "../../src/chat/fts5-index";
import type { QuizSessionState } from "../../src/quiz/index";
import type { ModuleGraph } from "../../src/repo-graph/module-graph";

const mg: ModuleGraph = {
  modules: ["src/web", "src/daemon"], edges: [["src/web", "src/daemon"]],
  resolvedInternal: 1, unresolvedInternal: 0,
};

function harness(captured: { systemPrompt?: string }) {
  const app = new Hono();
  const mem = new Map<string, QuizSessionState>();
  mountChatRoutes(app, {
    homeBase: "/tmp/quiz-test", index: { insertMessage() {}, search: () => [] } as any,
    secret: "s",
    loadModuleGraph: async () => mg,
    quizStore: {
      read: async (id: string) => mem.get(id) ?? null,
      write: async (id: string, s: QuizSessionState) => void mem.set(id, s),
    },
    readSession: async () => [],
    streamFactory: async function* (opts: StreamChatOptions) {
      captured.systemPrompt = opts.systemPrompt;
      yield { type: "message_start", message_id: "m", model: "test" };
      yield { type: "content_block_delta", text: "Which way does the dependency run?" };
      yield { type: "message_stop", usage: { input_tokens: 1, output_tokens: 1 }, full_text: "Which way does the dependency run?" };
    } as any,
  } as any);
  return app;
}

describe("POST /api/chat quiz mode", () => {
  it("opener threads the conductor prompt via quizPrompt and asks (no verdict)", async () => {
    const captured: { systemPrompt?: string } = {};
    const app = harness(captured);
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
      body: JSON.stringify({ message: "", session_id: "q1", page: "repo-graph",
        quiz: { proj_hash: "abc", scope_module_id: null } }),
    });
    expect(res.status).toBe(200);
    expect(captured.systemPrompt).toContain("never"); // CONDUCTOR_SYSTEM_PROMPT never-decide language
  });

  it("reversed continuation answer emits the real direction and records contradiction", async () => {
    // A real index + real tmp homeBase: the continuation turn's answer is a
    // non-empty message, so (unlike the opener test above) the route's
    // appendMessage/insertMessage path actually runs — a bare `{
    // insertMessage(){} }` stand-in lacks the `.db` the real fts5-index
    // functions read (chat.ts calls the module-level insertMessage/search
    // directly, passing deps.index as data, not as a vtable).
    const home = mkdtempSync(join(tmpdir(), "siltpoke-quiz-route-"));
    const idx = openIndex(home);
    const mem = new Map<string, any>();
    const app = new Hono();
    mountChatRoutes(app, {
      homeBase: home, index: idx, secret: "s",
      loadModuleGraph: async () => mg,
      quizStore: {
        read: async (id: string) => mem.get(id) ?? null,
        write: async (id: string, s: QuizSessionState) => void mem.set(id, s),
      },
      readSession: async () => [],
      // "basically right" is a literal CAVING phrase in the real
      // output-validator's blocklist (src/quiz/output-validator.ts) — this
      // must actually FAIL validateVerbalization for a "contradict" verdict
      // so generateValidatedVerbalization exhausts its retry and falls back
      // to the deterministic real-direction text (same phrase Task 5's own
      // chat-quiz-emit.test.ts uses to force its fallback case).
      streamFactory: async function* () {
        yield { type: "message_start", message_id: "m", model: "t" };
        yield { type: "content_block_delta", text: "Your intuition is basically right, nice job!" };
        yield { type: "message_stop", usage: { input_tokens: 1, output_tokens: 1 }, full_text: "Your intuition is basically right, nice job!" };
      } as any,
    } as any);
    try {
      // opener — drain the SSE body before the next turn: the quiz state
      // write happens inside the response stream's `start()` (Task 6, so an
      // aborted/failed turn never persists — see chat.ts), which is a
      // background task the route handler's own `return` does NOT await.
      // `.text()` only resolves once the stream reaches `controller.close()`
      // (after that write), so draining it here is what actually
      // synchronizes with it — same as a real client reading the full SSE
      // reply before the user can send the next turn.
      const openerRes = await app.request("/api/chat", { method: "POST",
        headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
        body: JSON.stringify({ message: "", session_id: "q2", page: "repo-graph", quiz: { proj_hash: "abc", scope_module_id: null } }) });
      await openerRes.text();
      // reversed answer
      const res = await app.request("/api/chat", { method: "POST",
        headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
        body: JSON.stringify({ message: "daemon depends on web", session_id: "q2", page: "repo-graph" }) });
      const body = await res.text();
      expect(body).toContain("depends on");          // emitted the direction fact, not the caving praise
      expect(body).not.toMatch(/nice job|basically right/i);
      expect(mem.get("q2").overlay.contradicted.length ?? mem.get("q2").overlay.contradicted.size).toBeGreaterThan(0);
    } finally {
      idx.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * Server-side model-transcript injection.
 *
 * RECALL_SURFACE_ENABLED is currently false (surface parked 2026-06-26).
 * With the flag off, recallRelatedChats is never called — the server always
 * injects nothing regardless of corpus content.
 *
 * Tests assert DEFAULT-OFF behaviour:
 *   (off) — even with a matching past summary, systemPrompt is undefined
 *           (no injection). On-behaviour (injection when flag=true) is
 *           covered by the recallRelatedChats unit tests (tests/chat/recall*).
 *   (off) — empty corpus → systemPrompt undefined, as always.
 *
 * Determinism: a 3-axis `idEmbedder` is kept for reference; it is no longer
 * exercised by the route tests while the flag is off.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import { openIndex, type ChatIndex } from "../../src/chat/fts5-index";
import { writeMemory, emptyMemory } from "../../src/memory/memory";
import { writeGlobal, emptyGlobal } from "../../src/memory/global";
import type { StreamEvent, StreamChatOptions } from "../../src/daemon/routes/chat-stream";
import type { Embedder } from "../../src/few-shot/embedder";

// ---------------------------------------------------------------------------
// Deterministic embedder — token-axis encoding, predictable cosine similarity.
// ---------------------------------------------------------------------------
const idEmbedder: Embedder = {
  dimension: 3,
  async embed(t: string): Promise<number[]> {
    if (t.includes("alpha")) return [1, 0, 0];
    if (t.includes("beta")) return [0, 1, 0];
    return [0, 0, 1];
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stream that just stops immediately. */
const DUMMY_EVENTS: StreamEvent[] = [
  {
    type: "message_stop",
    usage: { input_tokens: 0, output_tokens: 0 },
    full_text: "ok",
  },
];

/**
 * Seed a V3 memory layout in `base` with the given past-session summaries.
 * Global.json presence activates the V3 split-layout path in both readMemory
 * and writeMemory, matching what the production daemon uses.
 */
async function seedProject(
  base: string,
  summaries: Array<{ id: string; summary: string }>,
): Promise<void> {
  await writeGlobal(base, emptyGlobal());
  const mem = emptyMemory();
  mem.chat_sessions = summaries.map((s) => ({
    id: s.id,
    started_at: "2026-06-26T00:00:00Z",
    ended_at: "2026-06-26T00:01:00Z",
    message_count: 4,
    summary: s.summary,
    summary_generated_at: null,
    tags: [],
    anchor: null,
  }));
  await writeMemory(base, mem);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/chat — recall injection", () => {
  let app: Hono;
  let home: string;
  let idx: ChatIndex;
  let capturedSystemPrompt: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "siltpoke-recall-inject-"));
    idx = openIndex(home);
    capturedSystemPrompt = undefined;
  });

  afterEach(() => {
    idx.close();
    rmSync(home, { recursive: true, force: true });
  });

  /** Mount routes with the recall embedder seam + a systemPrompt-capturing streamFactory. */
  function mountWithCapture(): void {
    app = new Hono();
    mountChatRoutes(app, {
      homeBase: home,
      index: idx,
      recallEmbedder: idEmbedder,
      streamFactory: async function* (opts: StreamChatOptions) {
        capturedSystemPrompt = opts.systemPrompt;
        for (const ev of DUMMY_EVENTS) yield ev;
      },
    });
  }

  test("(surface off): matching past summary → NO injection (RECALL_SURFACE_ENABLED=false)", async () => {
    // Seed one session whose summary contains "alpha" (idEmbedder → [1,0,0]).
    // Even though alpha↔alpha cosine = 1.0 > threshold, the flag is OFF so the
    // route skips recallRelatedChats entirely — systemPrompt stays undefined.
    // On-behaviour (RELATED PAST CHATS injected when flag=true) is covered by
    // the recallRelatedChats unit tests (tests/chat/recall*.test.ts).
    await seedProject(home, [
      { id: "past-alpha", summary: "alpha refactor of the router" },
    ]);

    mountWithCapture();

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "alpha question" }),
    });
    await res.text(); // drain SSE body

    // No anchor + RECALL_SURFACE_ENABLED=false → no injection → undefined.
    // (If it were a string, it must NOT contain the recall block — but undefined
    //  is the correct state: "" || undefined = undefined.)
    expect(capturedSystemPrompt).toBeUndefined();
  });

  test("empty corpus → systemPrompt is undefined (nothing injected)", async () => {
    // No past sessions seeded — recall returns [] → no injection, no anchor.
    mountWithCapture();

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "alpha question" }),
    });
    await res.text();

    // No anchor + no recall matches → `"" || undefined` = undefined.
    expect(capturedSystemPrompt).toBeUndefined();
  });

  test("all-below-threshold corpus → no RELATED PAST CHATS injected", async () => {
    // Session summary contains "beta" (idEmbedder → [0,1,0]).
    // User message contains "alpha" (query → [1,0,0]). cosine([1,0,0],[0,1,0]) = 0 < 0.4.
    await seedProject(home, [
      { id: "past-beta", summary: "beta unrelated topic" },
    ]);

    mountWithCapture();

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "alpha question" }),
    });
    await res.text();

    // Below-threshold → recallBlock = "" → baseSystemPrompt = "" → undefined.
    expect(capturedSystemPrompt).toBeUndefined();
  });
});

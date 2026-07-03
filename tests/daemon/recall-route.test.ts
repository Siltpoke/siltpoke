/**
 * GET /api/chat/recall route
 *
 * Tests drive the route via mountChatRoutes with injected deps.
 * A deterministic 3-axis idEmbedder avoids fastembed and keeps tests fast.
 *   "alpha" text → [1,0,0], "beta" → [0,1,0]; alpha↔alpha cosine = 1.0 > 0.4.
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
import type { Embedder } from "../../src/few-shot/embedder";

// ---------------------------------------------------------------------------
// Deterministic embedder — same pattern as chat-recall-injection.test.ts
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
// Seeding helper (V3 layout)
// ---------------------------------------------------------------------------
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
describe("GET /api/chat/recall", () => {
  let app: Hono;
  let home: string;
  let idx: ChatIndex;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "siltpoke-recall-route-"));
    idx = openIndex(home);
    app = new Hono();
    mountChatRoutes(app, {
      homeBase: home,
      index: idx,
      recallEmbedder: idEmbedder,
    });
  });

  afterEach(() => {
    idx.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("matched past session returned in matches array", async () => {
    // Seed one past session with "alpha" summary (idEmbedder → [1,0,0]).
    await seedProject(home, [
      { id: "past-alpha", summary: "alpha refactor of the router" },
    ]);

    // Query "alpha" from a different session → cosine 1.0 → above threshold.
    const res = await app.request("/api/chat/recall?q=alpha&session=cur");

    expect(res.status).toBe(200);
    const json = (await res.json()) as { matches: Array<{ session_id: string; summary: string; similarity: number }> };
    expect(Array.isArray(json.matches)).toBe(true);
    expect(json.matches.length).toBeGreaterThan(0);
    expect(json.matches[0]?.session_id).toBe("past-alpha");
    expect(json.matches[0]?.summary).toContain("alpha");
  });

  test("current session excluded from recall results", async () => {
    // Seed two sessions — one is the "current" session (session=cur).
    await seedProject(home, [
      { id: "cur", summary: "alpha current work in progress" },
      { id: "past-alpha", summary: "alpha previous session result" },
    ]);

    const res = await app.request("/api/chat/recall?q=alpha&session=cur");

    expect(res.status).toBe(200);
    const json = (await res.json()) as { matches: Array<{ session_id: string }> };
    // "cur" must be excluded; only "past-alpha" may appear.
    const ids = json.matches.map((m) => m.session_id);
    expect(ids).not.toContain("cur");
  });

  test("400 when q is absent", async () => {
    const res = await app.request("/api/chat/recall");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBeTruthy();
  });

  test("400 when q is empty string", async () => {
    const res = await app.request("/api/chat/recall?q=");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBeTruthy();
  });

  test("200 with empty matches when no sessions in corpus", async () => {
    // No past sessions — recall returns [].
    const res = await app.request("/api/chat/recall?q=alpha");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { matches: unknown[] };
    expect(json.matches).toEqual([]);
  });
});

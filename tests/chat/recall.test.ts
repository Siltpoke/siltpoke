import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallRelatedChats, RECALL_THRESHOLD } from "../../src/chat/recall";
import { writeMemory, emptyMemory } from "../../src/memory/memory";
import { writeGlobal, emptyGlobal } from "../../src/memory/global";
import type { Embedder } from "../../src/few-shot/embedder";

// Deterministic 3-dim embedder: distinct token axes make cosine predictable.
// alpha↔alpha = 1.0 (cosine), alpha↔beta = 0.0.
const idEmbedder: Embedder = {
  dimension: 3,
  async embed(t: string): Promise<number[]> {
    if (t.includes("alpha")) return [1, 0, 0];
    if (t.includes("beta")) return [0, 1, 0];
    return [0, 0, 1];
  },
};

/**
 * Seed a fresh tmpdir with the V3 memory layout.
 *
 * The critical requirement: presence of global.json triggers the V3 code
 * path in both writeMemory and readMemory. Both paths call
 * resolveProjectRoot(process.cwd()) to derive the per-project key — because
 * seed-write and recall-read run in the same test process, the cwd is
 * identical, so the round-trip must find the seeded sessions. A divergence in
 * key resolution would break the round-trip, making this a real proof.
 */
async function seedProject(
  summaries: Array<{ id: string; summary: string }>,
): Promise<string> {
  const base = mkdtempSync(join(tmpdir(), "recall-"));
  // Write global.json to activate V3 split layout (the presence trigger).
  await writeGlobal(base, emptyGlobal());
  const mem = emptyMemory();
  // Build the chat sessions that recall should find.
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
  // V3 writer: resolveProjectRoot(process.cwd()) computes project_id;
  // the V3 reader in recallRelatedChats resolves the SAME id → round-trip.
  await writeMemory(base, mem);
  return base;
}

test("round-trip: a summary written for project P is retrievable by recall opened in P", async () => {
  const base = await seedProject([{ id: "past", summary: "alpha refactor of the router" }]);
  const { matches } = await recallRelatedChats("alpha question", base, {
    currentSessionId: "current",
    embedder: idEmbedder,
  });
  // The reader must have resolved the same project key the writer used.
  expect(matches.map((m) => m.session_id)).toContain("past");
});

test("INV2: all-below-threshold corpus returns [] and surfaces nothing", async () => {
  const base = await seedProject([{ id: "p1", summary: "beta unrelated topic" }]);
  const { matches } = await recallRelatedChats("alpha query", base, {
    currentSessionId: "cur",
    embedder: idEmbedder,
    threshold: 0.9,
  });
  // beta vs alpha cosine = 0.0 < 0.9
  expect(matches).toEqual([]);
});

test("self session excluded; top matches above threshold returned", async () => {
  const base = await seedProject([
    { id: "self", summary: "alpha self chat" },
    { id: "other", summary: "alpha other chat" },
  ]);
  const { matches } = await recallRelatedChats("alpha", base, {
    currentSessionId: "self",
    embedder: idEmbedder,
  });
  // "self" is excluded regardless of similarity; "other" passes the threshold.
  expect(matches.map((m) => m.session_id)).toEqual(["other"]);
});

test("empty-summary session is skipped, never matched", async () => {
  const base = await seedProject([{ id: "blank", summary: "   " }]);
  const { matches } = await recallRelatedChats("alpha", base, {
    currentSessionId: "cur",
    embedder: idEmbedder,
    threshold: 0,
  });
  expect(matches.find((m) => m.session_id === "blank")).toBeUndefined();
});

test("RECALL_THRESHOLD is 0.4", () => {
  expect(RECALL_THRESHOLD).toBe(0.4);
});

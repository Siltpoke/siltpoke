// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWrite } from "../utils/atomic-write";
import { findNearest } from "../few-shot/retriever";
import type { FewShotIndexEntry } from "../few-shot/types";
import { defaultEmbedder, type Embedder } from "../few-shot/embedder";
import { readMemory } from "../memory/memory";
import { resolveProjectRoot, projectMemoryDir } from "../memory/project";

// Cross-chat recall SURFACE is parked (2026-06-26). Summaries (memory) stay active;
// flip to true to re-enable the chip + dropdown + escape-hatch + server injection.
export const RECALL_SURFACE_ENABLED = false;

const summaryIndexEntrySchema = z.object({
  session_id: z.string(),
  summary_hash: z.string(),
  embedding: z.array(z.number()),
  updated_at: z.string(),
});
const summaryIndexFileSchema = z.object({ entries: z.array(summaryIndexEntrySchema) });
export type SummaryIndexEntry = z.infer<typeof summaryIndexEntrySchema>;

export function summaryHash(summary: string): string {
  return createHash("sha256").update(summary.trim()).digest("hex");
}

function indexPath(projectBase: string): string {
  const { project_id } = resolveProjectRoot(process.cwd());
  return join(projectMemoryDir(projectBase, project_id), "chat-summary-index.json");
}

export async function readSummaryIndex(projectBase: string): Promise<SummaryIndexEntry[]> {
  try {
    const raw = await readFile(indexPath(projectBase), "utf8");
    return summaryIndexFileSchema.parse(JSON.parse(raw)).entries;
  } catch {
    return []; // missing / malformed → cold start, never throw
  }
}

export function writeSummaryIndex(projectBase: string, entries: SummaryIndexEntry[]): void {
  atomicWrite(indexPath(projectBase), JSON.stringify({ entries }, null, 2));
}

type IndexableSession = { id: string; summary: string };

export async function refreshSummaryIndex(
  sessions: IndexableSession[],
  prior: SummaryIndexEntry[],
  embed: (text: string) => Promise<number[]>,
  now: Date,
): Promise<{ entries: SummaryIndexEntry[]; embedCount: number }> {
  const priorById = new Map(prior.map((e) => [e.session_id, e]));
  const next: SummaryIndexEntry[] = [];
  let embedCount = 0;
  for (const s of sessions) {
    const summary = s.summary.trim();
    if (summary.length === 0) continue; // skip empty (Contingency)
    const hash = summaryHash(summary);
    const existing = priorById.get(s.id);
    if (existing && existing.summary_hash === hash) {
      next.push(existing); // unchanged → reuse, no embed
      continue;
    }
    const embedding = await embed(summary);
    embedCount++;
    next.push({ session_id: s.id, summary_hash: hash, embedding, updated_at: now.toISOString() });
  }
  return { entries: next, embedCount }; // vanished sessions naturally dropped
}

// ---------------------------------------------------------------------------
// Recall core
// ---------------------------------------------------------------------------

export const RECALL_THRESHOLD = 0.4;

export type RecallMatch = { session_id: string; summary: string; similarity: number };

/**
 * Find past chat sessions whose summaries are semantically similar to `query`.
 *
 * Flow:
 *   1. Read project memory via readMemory (V3-aware: resolveProjectRoot chokepoint).
 *   2. Exclude currentSessionId and blank summaries.
 *   3. Refresh sidecar embedding index (embed only changed/new summaries).
 *   4. Run cosine nearest-neighbour search via findNearest.
 *   5. Filter by threshold; return sorted matches.
 *
 * writeMemory and readMemory both call resolveProjectRoot(process.cwd())
 * for the project key, so a write + recall in the same process is guaranteed
 * to round-trip through the same store entry.
 */
export async function recallRelatedChats(
  query: string,
  projectBase: string,
  opts: {
    currentSessionId?: string;
    k?: number;
    threshold?: number;
    embedder?: Embedder;
    now?: Date;
  } = {},
): Promise<{ matches: RecallMatch[] }> {
  const q = query.trim();
  if (q.length === 0) return { matches: [] };

  // Step 1: read via the same V3 resolveProjectRoot chokepoint as the writer.
  const mem = await readMemory(projectBase);

  // Step 2: exclude current session and blank summaries.
  const sessions = (mem?.chat_sessions ?? [])
    .filter((s) => s.id !== opts.currentSessionId)
    .filter((s) => s.summary.trim().length > 0)
    .map((s) => ({ id: s.id, summary: s.summary }));

  if (sessions.length === 0) return { matches: [] };

  // Step 3: refresh sidecar embedding index, persisting when anything changed.
  const embedder = opts.embedder ?? (await defaultEmbedder());
  const now = opts.now ?? new Date();
  const prior = await readSummaryIndex(projectBase);
  const { entries, embedCount } = await refreshSummaryIndex(
    sessions,
    prior,
    (t) => embedder.embed(t),
    now,
  );
  if (embedCount > 0) writeSummaryIndex(projectBase, entries);

  // Step 4: adapt sidecar entries to FewShotIndexEntry — no casts needed.
  // We set id = session_id so n.entry.id is the session_id after findNearest.
  const fewShotIndex: FewShotIndexEntry[] = entries.map((e) => ({
    id: e.session_id,
    embedding: e.embedding,
    signal: "dismiss" as const,
    reason_text: null,
    critique_summary: "", // unused by retriever
    ts: e.updated_at,
  }));

  const qEmb = await embedder.embed(q);
  const threshold = opts.threshold ?? RECALL_THRESHOLD;
  const k = opts.k ?? 3;
  const summaryById = new Map(sessions.map((s) => [s.id, s.summary]));

  // Step 5: nearest-neighbour search, threshold gate, result assembly.
  const matches = findNearest(qEmb, fewShotIndex, k)
    .filter((n) => n.similarity >= threshold)
    .map((n) => ({
      session_id: n.entry.id,
      summary: summaryById.get(n.entry.id) ?? "",
      similarity: n.similarity,
    }))
    .filter((m) => m.summary.length > 0);

  return { matches };
}

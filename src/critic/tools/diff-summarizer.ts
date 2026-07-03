// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Adaptive hunk body.
 *
 * Three tiers based on line count:
 *   ≤ 60  → full body returned as-is
 *   61-200 → head 30 + tail 30 with middle elision marker
 *   > 200  → optional LLM summarizer (or heuristic fallback) + head 15 + tail 15
 *
 * Pure async function with an optional summarizer injection seam for tests.
 */

import { createHash } from "node:crypto";

/** Simple in-process cache keyed by content SHA. */
const CACHE = new Map<string, string>();

export type Summarizer = (body: string) => Promise<string>;

export interface AdaptiveOpts {
  sha?: string;
  summarizer?: Summarizer;
}

const FULL_THRESHOLD = 60;
const ELIDE_THRESHOLD = 200;
const HEAD_TAIL_LINES = 30;
const SUMMARY_HEAD_TAIL = 15;

function heuristicSummary(body: string): string {
  const lines = body.split("\n");
  const adds = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const dels = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  return `[HEURISTIC SUMMARY: ${lines.length} lines, +${adds} -${dels}, body too large for full inline]`;
}

export async function adaptiveHunkBody(body: string, opts: AdaptiveOpts = {}): Promise<string> {
  const lines = body.split("\n");

  if (lines.length <= FULL_THRESHOLD) {
    return body;
  }

  if (lines.length <= ELIDE_THRESHOLD) {
    const head = lines.slice(0, HEAD_TAIL_LINES).join("\n");
    const tail = lines.slice(-HEAD_TAIL_LINES).join("\n");
    const elided = lines.length - 2 * HEAD_TAIL_LINES;
    return `${head}\n[middle ${elided} lines elided]\n${tail}`;
  }

  // > ELIDE_THRESHOLD: use summarizer (or heuristic fallback) + head + tail
  const sha = opts.sha ?? createHash("sha256").update(body).digest("hex").slice(0, 16);
  const cached = CACHE.get(sha);

  let summary: string;
  if (cached !== undefined) {
    summary = cached;
  } else {
    const summarizeFn: Summarizer = opts.summarizer ?? (async (b: string) => heuristicSummary(b));
    summary = await summarizeFn(body);
    CACHE.set(sha, summary);
  }

  const head = lines.slice(0, SUMMARY_HEAD_TAIL).join("\n");
  const tail = lines.slice(-SUMMARY_HEAD_TAIL).join("\n");
  return `${summary}\n${head}\n[... mid-section summarized above]\n${tail}`;
}

/**
 * LLM summarizer stub — in production this would call Haiku.
 * Currently falls back to heuristicSummary to avoid live API calls.
 */
export async function summarizeHunkLLM(body: string): Promise<string> {
  return heuristicSummary(body);
}

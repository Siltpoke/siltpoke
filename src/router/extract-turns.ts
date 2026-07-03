// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * extractTranscriptTurns — parse a Claude Code transcript JSONL and return an
 * ordered list of {role, text, ts} turns.
 *
 * Used by handle-stop.ts to wire real transcript turns into runCritic() so
 * captureIntent() can produce non-null user_raw_query + agent_restatement.
 *
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { TranscriptEvent } from "./context";
import { extractAssistantText, extractUserText } from "./context";
import type { TranscriptTurn } from "../critic/intent/capture";

export type { TranscriptTurn };

export async function extractTranscriptTurns(
  transcriptPath: string,
): Promise<TranscriptTurn[]> {
  if (!existsSync(transcriptPath)) return [];

  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return [];
  }

  const turns: TranscriptTurn[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    let ev: TranscriptEvent;
    try {
      ev = JSON.parse(line) as TranscriptEvent;
    } catch {
      continue;
    }

    if (!ev || typeof ev !== "object") continue;

    // Resolve role from multiple possible locations in the transcript format.
    const role =
      (typeof ev.role === "string" && ev.role) ||
      (typeof ev.type === "string" && ev.type) ||
      (typeof ev.message?.role === "string" && ev.message.role) ||
      null;

    const ts = typeof ev.timestamp === "string" ? ev.timestamp : undefined;

    if (role === "user") {
      const text = extractUserText(ev);
      if (text?.trim()) {
        turns.push({ role: "user", text: text.trim(), ts });
      }
    } else if (role === "assistant") {
      const text = extractAssistantText(ev);
      if (text?.trim()) {
        turns.push({ role: "assistant", text: text.trim(), ts });
      }
    }
  }

  return turns;
}

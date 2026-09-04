// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * extractTranscriptTurns — parse a session transcript JSONL and return an
 * ordered list of {role, text, ts} turns.
 *
 * Used by handle-stop.ts to wire real transcript turns into runCritic() so
 * captureIntent() can produce non-null user_raw_query + agent_restatement.
 *
 */

import { extractAssistantText, extractUserText, readEvents } from "./context";
import type { TranscriptTurn } from "../critic/intent/capture";

export type { TranscriptTurn };

export async function extractTranscriptTurns(
  transcriptPath: string,
): Promise<TranscriptTurn[]> {
  // readEvents handles missing/unreadable files (returns []) and normalizes
  // Codex rollout envelopes into the Claude TranscriptEvent shape, so this
  // loop sees one uniform format.
  const events = await readEvents(transcriptPath);

  const turns: TranscriptTurn[] = [];

  for (const ev of events) {
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

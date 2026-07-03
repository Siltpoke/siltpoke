// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Post-Brain substring-match guard for the tool-augmented critic.
 *
 * Verifies that every evidence snippet emitted by the
 * LLM appears verbatim in the tool-derived citation corpus (the formatted tool
 * section the Brain saw + raw stdout + caller tokens), and that every cited
 * file appears in the changed-files set OR somewhere in the corpus.
 */

import type { BrainOutput } from "../brain/schema";
import type { GateDecision } from "./classify-output";
import type { WebSource } from "../brain/schema-v2";

export type GuardResult =
  | { accept: true }
  | { accept: false; reason: string };

/**
 * Post-Brain substring-match guard.
 *
 * @param out           The parsed BrainOutput from the LLM.
 * @param mode          Gate decision from classifyToolOutput.
 * @param citationCorpus Tool-derived text the Brain may legitimately cite,
 *   verbatim: the formatted tool-output section the Brain saw + every tool's
 *   RAW stdout (+ caller-impact tokens). All deterministic and tool-derived —
 *   no LLM-generated prose — so the anti-hallucination invariant holds.
 * @param changedFiles  Set of file paths that changed in this Stop event.
 * @returns GuardResult — { accept: true } or { accept: false, reason: string }.
 *
 * Mode semantics:
 * - PASSIVE_BUBBLE: always accepts (passive bubble has no evidence to cite).
 * - HARD_SUPPRESS: always accepts (defensive — caller shouldn't reach this in
 *   HARD_SUPPRESS, but accept is the safe no-op).
 * - NORMAL: rejects if evidence is empty OR if any snippet/file fails check.
 *
 * Snippet reason strings are truncated at 60 chars to keep telemetry logs
 * scannable — the full snippet is in the corpus if you need to compare.
 */
export function guardCritique(
  out: BrainOutput,
  mode: GateDecision,
  citationCorpus: string,
  changedFiles: Set<string>,
): GuardResult {
  // PASSIVE_BUBBLE and HARD_SUPPRESS paths — always accept
  if (mode === "PASSIVE_BUBBLE") return { accept: true };
  if (mode === "HARD_SUPPRESS") return { accept: true };

  // NORMAL from here

  if (out.evidence.length === 0) {
    return { accept: false, reason: "NORMAL mode but evidence array empty" };
  }

  for (const item of out.evidence) {
    // Snippet must appear verbatim in the tool-derived citation corpus.
    // Truncate at 60 chars in the reason string for log scannability;
    // only append "..." marker if actually truncated.
    if (!citationCorpus.includes(item.snippet)) {
      const preview =
        item.snippet.length > 60
          ? `${item.snippet.slice(0, 60)}...`
          : item.snippet;
      return {
        accept: false,
        reason: `snippet not in evidence_corpus: ${preview}`,
      };
    }

    // File must appear either in the changed-files set (PQ3) or somewhere
    // in the corpus as a tool-mentioned path (PQ4).
    if (!changedFiles.has(item.file) && !citationCorpus.includes(item.file)) {
      return {
        accept: false,
        reason: `evidence file not in changed-files or corpus: ${item.file}`,
      };
    }
  }

  return { accept: true };
}

const EXTERNAL_CLAIM_PATTERN = /\b(api|library|package|npm|sdk|webhook)\b/i;

/**
 * Returns true when the critique references an external API/library but
 * provides no web sources to ground the claim.
 *
 * Callers may use this to flag or downgrade unverified external references
 * before surfacing critiques to the user.
 */
export function hasUngroundedExternalClaim(critique: {
  critique_for_claude: string;
  web_sources: WebSource[];
}): boolean {
  if (!EXTERNAL_CLAIM_PATTERN.test(critique.critique_for_claude)) return false;
  return critique.web_sources.length === 0;
}

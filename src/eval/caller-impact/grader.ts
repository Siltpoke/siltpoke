// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * E2 — the SECONDARY, blind semantic grader (OQ4).
 *
 * A Brain call on a DIFFERENT TIER than the arm-under-test critic (arms run on
 * Haiku → grader runs on Sonnet). It is BLIND: the prompt is given only the
 * planted-bug description and the surfaced finding — never which arm produced
 * it — and judges whether the finding is genuinely about the planted bug.
 *
 * Honest limit (logged): siltpoke's infra is `claude -p` only, so "different
 * tier" is the strongest available independence — NOT a different model family.
 * The grader is SECONDARY: the deterministic (file,function)±line oracle is
 * primary and is what keeps the small-N verdict defensible. The grader only
 * annotates; on any parse failure it returns `aboutPlanted: false` (conservative
 * — it never manufactures a confirmation).
 */
import { callBrainRaw, type BrainCallRawResult, type CallBrainOptions } from "../../brain/brain";
import type { SemanticGrader } from "./oracle";

/** A different tier than the critic Brain (Haiku). */
export const DEFAULT_GRADER_MODEL = "claude-sonnet-4-6";

export interface GraderDeps {
  /** Raw Brain call seam (tests inject a fake; default = real callBrainRaw). */
  call?: (opts: CallBrainOptions) => Promise<BrainCallRawResult>;
  /** Grader model tier — MUST differ from the arm Brain. */
  model?: string;
}

const GRADER_SYSTEM = [
  "You are a strict, impartial grader checking a code-review finding against a known issue.",
  "You are given a KNOWN planted issue (file, function, line) and a FINDING a reviewer surfaced (file, optional line).",
  "Decide whether the finding refers to the SAME code location / the planted issue — not merely the same file by coincidence.",
  "You do NOT know which system produced the finding; do not speculate about it.",
  'Answer with ONLY a single JSON object: {"aboutPlanted": true} or {"aboutPlanted": false}. No prose.',
].join("\n");

/** Conservative parse: only an explicit boolean true counts; anything else → false. */
export function parseAboutPlanted(output: unknown): boolean {
  if (typeof output === "object" && output !== null && "aboutPlanted" in output) {
    return (output as { aboutPlanted: unknown }).aboutPlanted === true;
  }
  return false;
}

export function makeSemanticGrader(deps: GraderDeps = {}): SemanticGrader {
  const call = deps.call ?? callBrainRaw;
  const model = deps.model ?? DEFAULT_GRADER_MODEL;

  return async ({ planted, finding }) => {
    // `arm` is intentionally NOT destructured/referenced — blindness by construction.
    const contextBundle = JSON.stringify({
      plantedIssue: { file: planted.file, function: planted.function, line: planted.line },
      finding: { file: finding.file, ...(finding.line !== undefined ? { line: finding.line } : {}) },
    });
    try {
      const raw = await call({ systemPrompt: GRADER_SYSTEM, contextBundle, model });
      return { aboutPlanted: parseAboutPlanted(raw.output) };
    } catch {
      return { aboutPlanted: false }; // grader failure never manufactures a confirmation
    }
  };
}

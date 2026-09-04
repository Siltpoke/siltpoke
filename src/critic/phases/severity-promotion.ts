// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// Hard severity-promotion rule for the critic pipeline.
//
// Runs on BOTH NORMAL and PASSIVE_BUBBLE paths after the Brain call —
// PASSIVE_BUBBLE specifically defaults to happy bubbles, so it needs the
// same promotion logic to avoid silently ignoring real concerns.

import type { BrainOutput } from "../../brain/schema";
import type { V2ResultFields } from "../types";
import type { DiffSummary } from "../tools/run-diff-summary";

/**
 * Hard post-process rule: when Brain emits severity=info but rubric triggers
 * (med/high) or diff-summary risks exist, force-elevate to "low" and
 * auto-populate critique_for_claude from the evidence so the user gets a
 * substantive note rather than a silent thumbs-up.
 *
 * This runs on BOTH NORMAL and PASSIVE_BUBBLE paths — PASSIVE_BUBBLE
 * specifically is the path that defaults to happy bubbles, so it needs the
 * same promotion logic to avoid silently ignoring real concerns.
 *
 * Does NOT demote: if Brain returned med/high, we leave it as-is.
 * Does NOT promote if severity > info: no-op.
 */
export function autoPromoteSeverity(
  critique: BrainOutput,
  v2: V2ResultFields,
  diffSummary: DiffSummary | undefined,
): void {
  if (critique.severity !== "info") return;

  const hasMedOrHighTriggers =
    v2.rubricTriggers?.some((t) => t.severity === "med" || t.severity === "high") ?? false;
  const hasRisks = (diffSummary?.risks?.length ?? 0) > 0;

  if (!hasMedOrHighTriggers && !hasRisks) return;

  // Force-elevate: Brain ignored real concerns.
  critique.severity = "low";

  // Build evidence-cited critique text if Brain left it empty.
  if (!critique.critique_for_claude || critique.critique_for_claude.trim().length === 0) {
    const lines: string[] = [];
    if (hasMedOrHighTriggers) {
      const top = v2.rubricTriggers!.filter((t) => t.severity !== "low").slice(0, 3);
      lines.push("Rubric flagged concerns the model didn't surface:");
      for (const t of top) lines.push(`- ${t.rule_id} at ${t.file}:${t.line} — ${t.message}`);
    }
    if (hasRisks) {
      if (lines.length > 0) lines.push("");
      lines.push("Diff-summary risks (Haiku pre-pass):");
      for (const r of diffSummary!.risks.slice(0, 3)) lines.push(`- ${r}`);
    }
    critique.critique_for_claude = lines.join("\n");
  }

  // Nudge mood from happy to concerned so the bubble doesn't mislead.
  if (critique.mood === "happy") critique.mood = "concerned";

  // Override happy bubble text. Brain emitted  while rubric triggers
  // existed → bubble misleads the eye. Replace with a neutral nudge so the
  // chip and the badge agree.
  const happyBubblePatterns = /干净|nice|clean|great|good|nothing to say|all good|all green|✓|👍|👌/i;
  if (critique.bubble_short && happyBubblePatterns.test(critique.bubble_short)) {
    const count = (v2.rubricTriggers ?? []).filter((t) => t.severity !== "low").length;
    if (count > 0) {
      critique.bubble_short = `rubric: ${count} concern${count === 1 ? "" : "s"}`;
    } else if (diffSummary?.risks && diffSummary.risks.length > 0) {
      critique.bubble_short = `${diffSummary.risks.length} risk${diffSummary.risks.length === 1 ? "" : "s"} flagged`;
    } else {
      critique.bubble_short = "see critique";
    }
  }
}

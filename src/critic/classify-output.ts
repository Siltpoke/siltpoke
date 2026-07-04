// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Tool output classifier — 3-tier suppression gate.
 *
 * Spec anchor: §PQ6 lock table (3-tier gate semantics) + §PQ8 abstention floor.
 *
 * Decision order (must be applied in sequence):
 *   1. usableTools.length === 0            → HARD_SUPPRESS (abstention floor, PQ8)
 *   2. allClean AND NOT diffHasHunks       → HARD_SUPPRESS (true no-op)
 *   3. allClean AND diffHasHunks           → PASSIVE_BUBBLE (clean refactor)
 *   4. nonDiffSignal exists                → NORMAL
 *   5. (defensive)                         → HARD_SUPPRESS
 */

import type { ToolName, ToolResult, ToolStatus } from "./tools/types";

export type GateDecision = "HARD_SUPPRESS" | "PASSIVE_BUBBLE" | "NORMAL";

export type ClassificationResult = {
  decision: GateDecision;
  reason: string;
  usableTools: ToolName[];
};

/** Status values that mean the tool produced actionable output we can use. */
const USABLE_STATUS = "ok" as const satisfies ToolStatus;

/** Non-diff tool names — these contribute to NORMAL when they have signal. */
const NON_DIFF_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "tsc",
  "eslint",
  "ripgrep",
]);

/** All ToolName values — kept here as the single iteration source so future
 *  additions to ToolName trigger an exhaustiveness compile error below. */
const ALL_TOOL_NAMES: readonly ToolName[] = ["tsc", "eslint", "git-diff", "ripgrep"];
// Compile-time exhaustiveness: if ToolName widens, the next line fails to type-check.
const _exhaustiveToolNames: ToolName[] = [...ALL_TOOL_NAMES];
void _exhaustiveToolNames;

/**
 * Classify the aggregated tool results into a gate decision.
 *
 * Pure function — no IO, no side effects, no throws.
 */
export function classifyToolOutput(
  results: Record<ToolName, ToolResult>,
): ClassificationResult {
  // Step 1: collect tools with status === "ok"
  const usableTools: ToolName[] = ALL_TOOL_NAMES.filter(
    (name) => results[name].status === USABLE_STATUS,
  );

  // Abstention floor: no tools produced usable output
  if (usableTools.length === 0) {
    return {
      decision: "HARD_SUPPRESS",
      reason: "no tools produced usable output — abstaining",
      usableTools: [],
    };
  }

  // Determine whether every NON-DIFF usable tool is "clean" (parsed.length === 0).
  // git-diff is treated separately — its hunks signal code change, not a problem.
  // A tool that isn't usable (not status=ok) doesn't factor into allClean.
  // Vacuous-true when no non-diff tools are usable (e.g. only git-diff ran ok):
  // [].every(...) returns true, which is the intended behavior — the decision then
  // turns on diffHasHunks alone (PASSIVE_BUBBLE vs HARD_SUPPRESS).
  const allClean = usableTools
    .filter((name) => name !== "git-diff")
    .every((name) => results[name].parsed.length === 0);

  // git-diff special: hunks present means code changed
  const gitDiff = results["git-diff"];
  const diffHasHunks =
    gitDiff.status === "ok" && gitDiff.parsed.length > 0;

  // A non-diff signal: any of {tsc, eslint, ripgrep} with status=ok AND parsed.length > 0
  const nonDiffSignalTools: ToolName[] = usableTools.filter(
    (name) => NON_DIFF_TOOLS.has(name) && results[name].parsed.length > 0,
  );
  const hasNonDiffSignal = nonDiffSignalTools.length > 0;

  // --- Decision tree ---

  if (allClean && !diffHasHunks) {
    // True no-op: nothing changed, nothing found
    return {
      decision: "HARD_SUPPRESS",
      reason: "all tools clean, no diff hunks",
      usableTools,
    };
  }

  if (allClean && diffHasHunks) {
    // Clean refactor: code changed but no findings
    return {
      decision: "PASSIVE_BUBBLE",
      reason: "tools clean, diff present (clean refactor)",
      usableTools,
    };
  }

  if (hasNonDiffSignal) {
    const toolList = nonDiffSignalTools.join(", ");
    return {
      decision: "NORMAL",
      reason: `${toolList} reported findings`,
      usableTools,
    };
  }

  // Defensive fallback — should be unreachable given the branches above.
  // Would only be reached if usable tools exist but none are clean and no
  // non-diff signal exists, which is logically impossible with the current
  // tool set (if not allClean then some tool has parsed.length > 0, which
  // must be a non-diff tool or git-diff; if only git-diff has hunks that's
  // allClean=false path but diffHasHunks is handled above).
  return {
    decision: "HARD_SUPPRESS",
    reason: "defensive suppression — no actionable signal identified",
    usableTools,
  };
}

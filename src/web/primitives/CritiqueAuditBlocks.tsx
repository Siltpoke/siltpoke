// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * CritiqueAuditBlocks — barrel re-export for the 6 transparent-audit
 * sections (A–F) of the per-critique detail panel in /history.
 *
 * Implementation files live under ./critique-audit/. This barrel
 * preserves the original import path so existing call sites
 * (Critic.tsx, CritiqueAuditCard.tsx, tests) keep working unchanged.
 *
 * Blocks:
 *   A — WHAT I READ       (files, user query, agent restatement, diff intent)
 *   B — INTENT ALIGNMENT  (side-by-side query vs restatement; placeholder)
 *   C — RUBRIC CHECKLIST  (13 rules with ✓ / ✗ / ⊘ per rule, grouped by tier)
 *   D — SIGNALS APPLIED   (preference-log / few-shot / repo-memory signals)
 *   E — VERDICT CHAIN     (reasoning → severity → category → critique_for_claude)
 *   F — COST              (tokens, cache hit %, $)
 */
export { RULE_EXPLAIN_BY_ID, SPAN_KIND_EXPLAIN } from "./critique-audit/rules-data";
export { BlockA, redactPath, type BlockAProps } from "./critique-audit/BlockA";
export { BlockC, type BlockCProps } from "./critique-audit/BlockC";
export {
  BlockD,
  type BlockDProps,
  type BlockDPreferenceStats,
} from "./critique-audit/BlockD";
export { BlockE, type BlockEProps } from "./critique-audit/BlockE";
export { BlockF, type BlockFProps } from "./critique-audit/BlockF";

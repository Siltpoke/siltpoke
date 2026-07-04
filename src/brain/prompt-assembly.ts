// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { CoreMemory, Fact, LearnedRule } from "../memory/memory";
import { readActiveStyleFacts } from "../memory/recall";
import type { RecentEntry } from "../memory/recent";
import {
  DEFAULT_MAX_RULES,
  selectRelevantRules,
} from "./rule-selector";

export const DEFAULT_RECENT_INJECTION_COUNT = 5;

export interface AssemblyInput {
  personalitySystemPrompt: string;
  memory: CoreMemory | null;
  recent: RecentEntry[];
  fileTypes?: Set<string>;
  maxRules?: number;
  recentInjectionCount?: number;
  /**
   * Optional structured tool-output section.
   * When provided, appended after memory/recent blocks before the closing instructions.
   * When omitted (undefined), behavior is unchanged.
   */
  toolOutputSection?: string;
  /**
   * Optional anti-examples block (few-shot retrieval).
   * When provided, appended after toolOutputSection.
   * Call `buildAntiExamplesBlock` from `src/few-shot/inject` to produce this value.
   */
  antiExamplesBlock?: string;
  /**
   * Optional caller-impact section.
   * When provided, appended after toolOutputSection (before anti-examples) so
   * the 1-hop "callers that may break" facts reach the Brain prompt. Produced by
   * `buildCallerImpactSection` from `src/critic/caller-impact/inject`.
   */
  callerImpactSection?: string;
}

function renderMemoryBlock(
  memory: CoreMemory,
  selectedRules: LearnedRule[],
  styleFacts: Fact[],
): string {
  const summary = memory.long_term_summary.trim();
  const rules = selectedRules
    .map((r, i) => `  ${i + 1}. (${r.category}) ${r.rule}`)
    .join("\n");

  const parts: string[] = ["<core_memory>"];
  if (summary) {
    parts.push("## Long-term summary", summary);
  }
  if (rules) {
    parts.push("## Learned rules — apply these on every review", rules);
  }
  // Communication-style facts only (kind:"style"); profile
  // trivia (boyfriend, colour, pets) is filtered out by readActiveStyleFacts (at
  // the caller) and never reaches the critic. Directive framing: honoring the
  // user's stated language / depth / tone in the critique is the point.
  if (styleFacts.length > 0) {
    parts.push(
      "## User communication style — honor these when writing your critique (language, depth, tone)",
      styleFacts.map((f) => `- ${f.text}`).join("\n"),
    );
  }
  parts.push("</core_memory>");
  return parts.join("\n");
}

function renderRecentBlock(recent: RecentEntry[]): string {
  const lines = recent
    .map((e) => {
      const tail = e.reason ? ` — reason: ${e.reason}` : "";
      const where =
        e.file && e.line !== undefined ? ` (${e.file}:${e.line})` : "";
      return `- [${e.ts}] ${e.critique_id} → ${e.verdict}${where}${tail}`;
    })
    .join("\n");

  return ["<recent_feedback>", lines, "</recent_feedback>"].join("\n");
}

export function assembleSystemPrompt(input: AssemblyInput): string {
  const blocks: string[] = [input.personalitySystemPrompt];

  const fileTypes = input.fileTypes ?? new Set<string>();
  const maxRules = input.maxRules ?? DEFAULT_MAX_RULES;
  const recentCap = input.recentInjectionCount ?? DEFAULT_RECENT_INJECTION_COUNT;

  const selectedRules = input.memory
    ? selectRelevantRules(input.memory.learned_rules, fileTypes, maxRules)
    : [];

  // Style facts alone fire the block (today summary + rules are
  // both empty in practice, so without this the critic never recalls). Computed
  // once here and threaded into renderMemoryBlock (avoids a duplicate filter).
  const styleFacts = input.memory ? readActiveStyleFacts(input.memory) : [];
  if (
    input.memory &&
    (input.memory.long_term_summary.trim().length > 0 ||
      selectedRules.length > 0 ||
      styleFacts.length > 0)
  ) {
    blocks.push("", renderMemoryBlock(input.memory, selectedRules, styleFacts));
  }

  const cappedRecent = input.recent.slice(-recentCap);
  if (cappedRecent.length > 0) {
    blocks.push("", renderRecentBlock(cappedRecent));
  }

  if (input.toolOutputSection !== undefined && input.toolOutputSection.length > 0) {
    blocks.push("", input.toolOutputSection);
  }

  if (input.callerImpactSection?.length) {
    blocks.push("", input.callerImpactSection);
  }

  if (input.antiExamplesBlock !== undefined && input.antiExamplesBlock.length > 0) {
    blocks.push("", input.antiExamplesBlock);
  }

  return blocks.join("\n");
}

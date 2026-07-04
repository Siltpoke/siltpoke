// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Static rubric rule descriptions + span-kind explanations.
 *
 * Used by:
 *   - Block C (renders the 13 rules with their tier + label + tooltip)
 *   - /help RubricRuleCard (renders the same prose from RULE_EXPLAIN_BY_ID)
 *   - SpanTree tooltip (SPAN_KIND_EXPLAIN)
 *
 * Extracted from CritiqueAuditBlocks.tsx.
 */

export interface RuleDesc {
  id: string;
  tier: 1 | 2 | 3;
  label: string;
  languages?: string;
  /**
   * Plain-English explanation for non-technical readers. Two parts:
   *   `what`: one sentence — what the rule looks for in your code.
   *   `why`:  one sentence — why catching this matters / what bug class
   *           it tends to surface.
   * Surfaced via the ℹ️ tooltip on each Block C rule row.
   */
  explain: { what: string; why: string };
}

export const ALL_RULES: RuleDesc[] = [
  // Tier 1 — deterministic
  {
    id: "god-file",
    tier: 1,
    label: "god-file (≥500 lines)",
    explain: {
      what: "Counts lines in each changed file; flags any that crossed 500.",
      why: "Big files usually do too many unrelated things, so any one change touches code that isn't related — that's where bugs hide.",
    },
  },
  {
    id: "test-gap",
    tier: 1,
    label: "test-gap (no test beside impl)",
    explain: {
      what: "Checks whether each new source file has a sibling test file (e.g. foo.ts → foo.test.ts).",
      why: "Code without tests breaks silently when you change it later. Catching the gap when the file is fresh is much cheaper than after a regression.",
    },
  },
  // Tier 2 — heuristic AST
  {
    id: "god-function",
    tier: 2,
    label: "god-function (≥50 lines or complexity)",
    explain: {
      what: "Walks each function and checks LOC + branching complexity.",
      why: "Long or deeply branchy functions are hard to test in isolation — split them into smaller pieces with clear names so each piece is easy to reason about.",
    },
  },
  {
    id: "deep-nesting",
    tier: 2,
    label: "deep-nesting (>4 levels)",
    explain: {
      what: "Flags if-inside-if-inside-if chains more than 4 deep.",
      why: "Deeply nested code is hard to read at a glance and easy to break when adding new branches. Early-return or guard clauses usually flatten it.",
    },
  },
  {
    id: "long-param-list",
    tier: 2,
    label: "long-param-list (>4 params)",
    explain: {
      what: "Counts positional parameters per function.",
      why: "Five+ positional args means callers have to remember the order — easy to swap two by accident. An options object is harder to misuse.",
    },
  },
  {
    id: "defensive-overreach",
    tier: 2,
    label: "defensive-overreach",
    explain: {
      what: "Detects try/catch blocks that swallow errors silently or guard against conditions that can't actually happen.",
      why: "Catching too aggressively hides real bugs and lets corrupted state propagate. Validate at the boundary, trust the inside.",
    },
  },
  {
    id: "sprawling-abstraction",
    tier: 2,
    label: "sprawling-abstraction",
    explain: {
      what: "Looks for abstractions (helpers, factories, base classes) that pull in many unrelated concerns at once.",
      why: "An abstraction that touches everything ends up coupling everything — small changes ripple far. Narrow it down to one job.",
    },
  },
  {
    id: "narrating-comment",
    tier: 2,
    label: "narrating-comment",
    explain: {
      what: "Spots comments that restate exactly what the next line of code says (e.g. // increment i  above i++).",
      why: "Comments should explain WHY, not WHAT — narration drifts as code changes and becomes misleading.",
    },
  },
  {
    id: "magic-number",
    tier: 2,
    label: "magic-number",
    explain: {
      what: "Flags unnamed numeric literals embedded in logic (not Zod schemas or HTTP status codes).",
      why: "When you read `if (x > 17)`, you don't know what 17 means. Give it a name (MAX_RETRIES) so the meaning travels with the value.",
    },
  },
  {
    id: "boolean-param",
    tier: 2,
    label: "boolean-param",
    explain: {
      what: "Detects function signatures with multiple boolean parameters or boolean flags that change behavior.",
      why: "At the call site you see `doThing(true, false)` and can't tell what they mean. An enum or options object reads itself.",
    },
  },
  {
    id: "commented-out-code",
    tier: 2,
    label: "commented-out-code",
    explain: {
      what: "Finds blocks of source code that are commented out (not natural-language notes).",
      why: "Dead commented code rots — readers can't tell if it's important. Git history already remembers what you deleted; delete it.",
    },
  },
  {
    id: "repo-memory-inconsistency",
    tier: 2,
    label: "repo-memory-inconsistency",
    explain: {
      what: "Compares the change against conventions siltpoke learned from prior work in this repo (stored in repo-memory).",
      why: "If the rest of the project uses pattern X and your change uses pattern Y, that drift makes the codebase harder for everyone to navigate.",
    },
  },
  {
    id: "repo-memory-convention",
    tier: 2,
    label: "repo-memory-convention",
    explain: {
      what: "Checks the change against explicit house rules captured in repo-memory (e.g. \"use ?? not ||\").",
      why: "Project conventions are agreements with future you and your collaborators. Following them keeps style coherent without lengthy reviews.",
    },
  },
  // Tier 3 — semantic (no concrete rules yet, placeholder group only)
];

/**
 * Public lookup for rule what/why prose. Used by both the inline ℹ
 * panel on Block C and the /help RubricRuleCard so the two surfaces
 * share a single source of truth.
 */
export const RULE_EXPLAIN_BY_ID: Record<string, { what: string; why: string }> =
  Object.fromEntries(ALL_RULES.map((r) => [r.id, r.explain]));

/** Public lookup for span-kind explanations used in tooltips on SpanTree dots. */
export const SPAN_KIND_EXPLAIN: Record<string, { what: string; why: string }> = {
  llm: {
    what: "A call to a language model — Brain (the critic) or Haiku (the summarizer).",
    why: "These are the slow, costly steps. Latency + token spend live here.",
  },
  tool: {
    what: "A deterministic local tool run — tsc, eslint, ripgrep, git-diff, secrets-scan.",
    why: "Tools are fast and produce factual evidence (file:line) the LLM judges against.",
  },
  rubric: {
    what: "The deterministic rule engine evaluating tier-1 file-level + tier-2 AST checks.",
    why: "Catches structural problems (long file, deep nesting, magic numbers) before Brain even runs — cheap and consistent.",
  },
  chain: {
    what: "Orchestration — the parent span that contains other spans for one turn.",
    why: "Gives you the wall-clock cost of the whole critique pipeline end-to-end.",
  },
  parser: {
    what: "Parsing Brain's JSON response into a typed Critique object.",
    why: "When Brain returns malformed JSON this span goes red — quick way to spot output-format regressions.",
  },
  persist: {
    what: "Writing the final critique + v2 sidecar + brain-calls log to disk.",
    why: "If persistence fails, the critique disappears even though Brain ran. Surface failures here.",
  },
};

// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Human-readable descriptions for every rubric rule.
 * Used by the /help page and the ? icon tooltip in the RUBRIC CHECKLIST block.
 */

export const RUBRIC_RULE_DESCRIPTIONS: Record<string, string> = {
  "god-file":
    "File exceeds 500 LOC. Indicates the file likely mixes multiple concerns and should be split. (ESLint max-lines recommends 100–500; ESLint default is 300; 500 is the AI-era upper bound per 2025 practitioner research.)",
  "test-gap":
    "Source diff >30 lines without matching test diff. Untested changes risk regression.",
  "god-function":
    "Function exceeds 50 LOC OR cognitive complexity >15. Hard to reason about, refactor candidate. (Thresholds: ESLint max-lines-per-function default 50; SonarQube cognitive complexity default 15.)",
  "deep-nesting":
    "Block nesting depth >3 (if/for/while/try/switch). Harms readability and increases bug risk. (Linux kernel + Shopify Ruby style guide both specify 3-level max.)",
  "long-param-list":
    "Function declares >4 positional params. Use an options object instead. (ESLint max-params default 3; Robert Martin discourages 4+; Refactoring Guru 3–4 threshold.)",
  "defensive-overreach":
    "try/catch wraps pure-CPU code OR catch silently logs and swallows. Indicates exception-as-flow-control.",
  "sprawling-abstraction":
    "New interface/class with exactly 1 implementer and 1 caller — premature abstraction.",
  "narrating-comment":
    "Comment tokens are a subset of the next-line tokens. Restates code instead of explaining intent.",
  "magic-number":
    "Numeric literal not in {0, 1, -1, 100} outside named constants, config, or tests.",
  "boolean-param":
    "One or more boolean positional args select behavior at the call site. Hard to read.",
  "commented-out-code":
    "Two or more consecutive comment lines parse as valid code. Likely dead code that should be deleted.",
  "repo-memory-inconsistency":
    "New code diverges from established patterns in similar files of this repo.",
  "repo-memory-convention":
    "New file violates a repo-wide naming or style convention detected in the existing tree.",
};

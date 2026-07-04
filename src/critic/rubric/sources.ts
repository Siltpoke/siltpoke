// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Source citations + rationale per rubric rule. Thresholds are anchored to
 * multiple public sources rather than subjective taste.
 *
 * Key threshold: god-file 500 LOC, backed by ESLint max-lines default 300,
 * ESLint recommended range 100–500, and 2025 AI-era practitioner research on
 * the 150–500 sweet spot.
 *
 * URLs verified live via WebFetch:
 *   ✓ eslint.org/docs/latest/rules/max-lines — default 300; range 100-500
 *   ✓ eslint.org/docs/latest/rules/max-lines-per-function — default 50
 *   ✓ eslint.org/docs/latest/rules/max-depth — default 4
 *   ✓ eslint.org/docs/latest/rules/max-params — default 3
 *   ✓ ruby-style-guide.shopify.dev — "no more than 3 levels of block nesting"
 *   ✓ google.github.io/styleguide/pyguide.html — "40 lines" function heuristic
 *   ✓ martinfowler.com/bliki/FunctionLength.html — "half-a-dozen lines smells"
 *   ✓ informit.com/articles/...p=1375308 — Robert Martin "more than 3 params
 *     very questionable" (Clean Code)
 *   ✓ devguide.trimble.com — "SonarQube cognitive complexity default 15"
 *   ✓ medium.com/@eamonn.faherty_58176 — 150–500 LOC AI-editor sweet spot
 *   ✓ addyo.substack.com/p/code-review-in-the-age-of-ai — >70% coverage gate;
 *     45% AI code has security flaws; 1.75x logic error rate
 *   ✓ google.github.io/eng-practices/.../looking-for.html — tests in same CL
 *   ✓ read.engineerscodex.com/p/the-boolean-trap — boolean param anti-pattern
 *   (original sources retained below per rule where still valid)
 *
 * Rubric provenance data (currently unconsumed by any screen).
 */

export interface RubricRuleSource {
  /** One-line "why this is bad" — engineering rationale */
  rationale: string;
  /** Threshold + source for the threshold number */
  threshold: string;
  /** Source URLs */
  sources: ReadonlyArray<{ label: string; url: string }>;
}

export const RUBRIC_RULE_SOURCES: Record<string, RubricRuleSource> = {
  "god-file": {
    rationale: "Files >500 LOC almost always mix multiple concerns — hard to reason about, hard to test in isolation. 500 is the AI-era upper bound: ESLint max-lines recommends 100–500, its default is 300, and 2025 practitioner research on AI code editors identifies 150–500 as the 'sweet spot' for context retention and diff quality.",
    threshold: "500 lines. ESLint max-lines default: 300; ESLint documented range: 100–500; eamonn-faherty 2025: 150–500 for AI editors; we trigger at 500 as a soft warning, well below an 800-line hard ceiling. SonarQube S104 defaults to 1,000 for Java (enterprise-lenient; not appropriate as a critic threshold).",
    sources: [
      { label: "ESLint max-lines rule — default 300, range 100–500", url: "https://eslint.org/docs/latest/rules/max-lines" },
      { label: "Right-Sizing Python Files: 150–500 Line Sweet Spot for AI Code Editors (2025)", url: "https://medium.com/@eamonn.faherty_58176/right-sizing-your-python-files-the-150-500-line-sweet-spot-for-ai-code-editors-340d550dcea4" },
      { label: "Code review best practices 2025 — 200–400 soft limit", url: "https://group107.com/blog/code-review-best-practices/" },
      { label: "Google eng-practices — complexity defined qualitatively", url: "https://google.github.io/eng-practices/review/reviewer/looking-for.html" },
    ],
  },

  "test-gap": {
    rationale: "Untested source changes are regression risk. Google mandates tests in the same CL; industry standard is 80% coverage. The 30-line threshold is a noise filter that suppresses trivial renames/typo fixes while catching substantive feature additions.",
    threshold: "30+ source lines added without matching test diff. No external source prescribes '30' exactly — this is a noise-filtering heuristic calibrated to the project's PR size patterns.",
    sources: [
      { label: "Google eng-practices — tests should be in the same CL", url: "https://google.github.io/eng-practices/review/reviewer/looking-for.html" },
      { label: "Google Testing Blog — 80% coverage goal", url: "https://testing.googleblog.com/2010/07/code-coverage-goal-80-and-no-less.html" },
      { label: "Addy Osmani — enforcing >70% coverage as a quality gate (2024-2025)", url: "https://addyo.substack.com/p/code-review-in-the-age-of-ai" },
    ],
  },

  "god-function": {
    rationale: "Functions that span >50 LOC OR have cognitive complexity >15 are statistically harder to reason about and more bug-prone. Robert Martin: 'should hardly ever be 20 lines long'; Google Python: 'exceeds 40 lines, think about splitting'; ESLint default is 50; SonarQube cognitive complexity default is 15.",
    threshold: "50 LOC (matches ESLint max-lines-per-function default exactly; Google Python ~40 from the other direction; Linux kernel 50); cognitive complexity >15 (SonarQube default; Trimble developer guide cites this explicitly).",
    sources: [
      { label: "ESLint max-lines-per-function — default 50", url: "https://eslint.org/docs/latest/rules/max-lines-per-function" },
      { label: "SonarSource — cognitive complexity default 15", url: "https://community.sonarsource.com/t/difference-between-cognitive-cyclomatic-complexity-quality-gate-and-rule/25558" },
      { label: "Trimble developer guide — SonarQube cognitive complexity default 15", url: "https://devguide.trimble.com/development-practices/managing-code-complexity/" },
      { label: "Google Python style guide — 40-line function heuristic", url: "https://google.github.io/styleguide/pyguide.html" },
      { label: "Martin Fowler — FunctionLength (half-a-dozen lines smells)", url: "https://martinfowler.com/bliki/FunctionLength.html" },
      { label: "Robert Martin — Clean Code: functions 'hardly ever 20 lines'", url: "https://www.informit.com/articles/article.aspx?p=1323426" },
      { label: "Linux kernel coding style", url: "https://docs.kernel.org/process/coding-style.html" },
    ],
  },

  "deep-nesting": {
    rationale: "Block nesting depth >3 (Torvalds: 'you're screwed') correlates strongly with bug density. Shopify Ruby style guide explicitly states the same limit. Guard clauses, early returns, and extracted helpers cure most cases.",
    threshold: "Indent depth >3 — trigger at depth 4+. Linux kernel + Shopify Ruby both explicit. ESLint max-depth default is 4 (slightly looser; allows up to 4 before flagging 5+), but the Linux/Shopify standard of 3-max is the more conservative and widely-recognized threshold for code reviews.",
    sources: [
      { label: "Linux kernel coding style — 'more than 3 levels, you're screwed'", url: "https://docs.kernel.org/process/coding-style.html" },
      { label: "Shopify Ruby style guide — 'avoid more than three levels of block nesting'", url: "https://ruby-style-guide.shopify.dev/" },
      { label: "ESLint max-depth — default 4", url: "https://eslint.org/docs/latest/rules/max-depth" },
    ],
  },

  "long-param-list": {
    rationale: "Functions with >4 positional params force callers to remember argument order (vs named keys). Robert Martin: 'more than three is very questionable'; ESLint default is 3; Refactoring Guru flags 3–4. The current 4-param threshold is the pragmatic middle ground — below it generates too many FP on constructors and React handlers.",
    threshold: ">4 positional params (Refactoring Guru upper bound). ESLint max-params default is 3 (stricter; too noisy for a critic). Robert Martin discourages 4+. Sandi Metz allows ≤5. `this/self/cls/ctx` excluded from count.",
    sources: [
      { label: "ESLint max-params — default 3", url: "https://eslint.org/docs/latest/rules/max-params" },
      { label: "Robert Martin / Clean Code — 'more than three very questionable'", url: "https://www.informit.com/articles/article.aspx?p=1375308" },
      { label: "Refactoring Guru — Long Parameter List (>3–4)", url: "https://refactoring.guru/smells/long-parameter-list" },
      { label: "Shopify Ruby style guide — 'avoid long parameter lists'", url: "https://ruby-style-guide.shopify.dev/" },
    ],
  },

  "defensive-overreach": {
    rationale: "AI-generated code frequently wraps pure-CPU code in try/catch then silently logs+swallows the exception — exception-as-flow-control. Hides real bugs. Addy Osmani (2024-2025) documents that 45% of AI-generated code contains security flaws and logic errors appear 1.75x more often than in human code — defensive overreach is a cited contributor.",
    threshold: "try/catch around code with no I/O OR catch body only calls `console.log` / `logger.*` / `pass`. Conservative: false-positive prone, prefer under-flag. No external numeric threshold exists — this is a pattern-matching heuristic.",
    sources: [
      { label: "Christian Haller — AI Code Slop (May 2026)", url: "https://www.christianhaller.me/blog/projectblog/2026-05-17-AI_slop_eng/" },
      { label: "Eng-Leadership — How to Avoid AI Code Slop", url: "https://newsletter.eng-leadership.com/p/how-to-avoid-ai-code-slop" },
      { label: "Addy Osmani — Code Review in the Age of AI (2024-2025)", url: "https://addyo.substack.com/p/code-review-in-the-age-of-ai" },
      { label: "CodeRabbit — AI code creates 1.7x more issues (2025)", url: "https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report" },
    ],
  },

  "sprawling-abstraction": {
    rationale: "New interface/abstract class with exactly 1 implementer + 1 caller in the same diff = premature abstraction. Sandi Metz: 'duplication is far cheaper than the wrong abstraction.' The Rule of Three says abstractions need ≥3 use sites to pay off. AI code specifically tends to over-abstract; Addy Osmani notes AI PRs are ~18% larger, suggesting over-engineering tendency.",
    threshold: "Exactly 1 `implements X` + 1 `: X` callsite across the diff.",
    sources: [
      { label: "Sandi Metz — The Wrong Abstraction (RailsConf 2014)", url: "https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction" },
      { label: "Understand Legacy Code — Rule of Three", url: "https://understandlegacycode.com/blog/refactoring-rule-of-three/" },
      { label: "Addy Osmani — AI PRs ~18% larger, 30% higher failure rate (2024-2025)", url: "https://addyo.substack.com/p/code-review-in-the-age-of-ai" },
    ],
  },

  "narrating-comment": {
    rationale: "Comments that restate the next line of code (e.g. `// increment counter` above `count++`) add noise without adding intent/why. Anthropic Code Review specifically targets this. A growing comment-to-code ratio is a documented sign of AI-degraded code quality.",
    threshold: "Comment tokens are a strict subset of the next non-comment line's tokens. Minimum 2 comment tokens (skip single-word labels). No external numeric threshold exists — this is a pattern-matching heuristic for 'what vs why' comments.",
    sources: [
      { label: "Anthropic Code Review launch (TechCrunch, March 2026)", url: "https://techcrunch.com/2026/03/09/anthropic-launches-code-review-tool-to-check-flood-of-ai-generated-code/" },
      { label: "Eng-Leadership — AI Code Slop (narrating comments listed explicitly)", url: "https://newsletter.eng-leadership.com/p/how-to-avoid-ai-code-slop" },
      { label: "codeant.ai 2026 guide — growing comment-to-code ratio as AI smell", url: "https://www.codeant.ai/blogs/code-smells-and-refactoring-guide" },
    ],
  },

  "magic-number": {
    rationale: "Bare numeric literals mid-function obscure intent. Fowler 'Magic Number' smell. Whitelist for genuinely-universal values: phpmnd (PHP Magic Number Detector) explicitly exempts 0 and 1 by default; CppCoreGuidelines ES.45 discussion confirms this convention; -1 is a standard sentinel; 100 is universal for percentages.",
    threshold: "Numeric literal ∉ {0, 1, -1, 100} AND NOT on RHS of `const NAME =` AND file path NOT matching `*config*` / `*constants*` / `*test*` / `*spec*`.",
    sources: [
      { label: "Refactoring Guru — Magic Number (Fowler catalog)", url: "https://refactoring.guru/refactoring/smells" },
      { label: "phpmnd — 0 and 1 exempt by default", url: "https://github.com/povils/phpmnd" },
      { label: "CppCoreGuidelines ES.45 — magic numbers in math operations", url: "https://github.com/isocpp/CppCoreGuidelines/issues/1861" },
      { label: "luzkan smells catalog — magic number taxonomy", url: "https://luzkan.github.io/smells/magic-number/" },
    ],
  },

  "boolean-param": {
    rationale: "`foo(true, false)` at the call site forces the reader to look up which positional means what. Engineer's Codex: 'boolean trap' — call sites are unclear without keyword args. ariya.io coined the 'Hall of API Shame: Boolean Trap' (2011); still an active lint discussion in ruff (Python linter) in 2025.",
    threshold: "≥1 boolean literal positional arg in a call with 2+ positional args. Cap per file at 3 triggers (spam reduction).",
    sources: [
      { label: "Engineer's Codex — The Boolean Trap", url: "https://read.engineerscodex.com/p/the-boolean-trap" },
      { label: "ariya.io — Hall of API Shame: Boolean Trap (2011, still widely cited)", url: "https://ariya.io/2011/08/hall-of-api-shame-boolean-trap" },
      { label: "ruff issue #23582 — add boolean-trap lint rule (2025)", url: "https://github.com/astral-sh/ruff/issues/23582" },
      { label: "Refactoring Guru — Code Smells catalog", url: "https://refactoring.guru/refactoring/smells" },
    ],
  },

  "commented-out-code": {
    rationale: "≥2 consecutive comment lines that parse as valid code are almost certainly dead code (forgotten debugging, rollback in progress). In 2024, 94% of developers use Git (Stack Overflow Developer Survey) — git history is available to every team, so keeping dead code in comments is 'digital hoarding' (refine.dev). Delete or move to a feature flag.",
    threshold: "≥2 consecutive line-comments whose stripped body re-parses via tree-sitter without error. Section dividers (`// ---`) excluded.",
    sources: [
      { label: "Refactoring Guru — Commented-Out Code (Dispensables)", url: "https://refactoring.guru/refactoring/smells" },
      { label: "refine.dev — code comments guide ('digital hoarding')", url: "https://refine.dev/blog/code-comments/" },
      { label: "Stack Overflow Developer Survey 2024 — 94% use Git", url: "https://survey.stackoverflow.co/2024/" },
    ],
  },

  "repo-memory-inconsistency": {
    rationale: "New code that diverges from established patterns in nearby files (logger import style, error-handling shape, naming) hurts cognitive load for the next reader. AI 'convention blindness' smell (Haller 2026). CodeRabbit's 2025 study found AI code creates 1.7x more issues than human code, with convention drift as a primary cause.",
    threshold: "New file in directory where ≥80% of existing files share a pattern AND new file violates it. Built on the repo-memory index (per-file Haiku summaries). No external source prescribes 80% exactly — this is a confidence threshold to reduce false positives.",
    sources: [
      { label: "Christian Haller — AI Code Slop: convention blindness (May 2026)", url: "https://www.christianhaller.me/blog/projectblog/2026-05-17-AI_slop_eng/" },
      { label: "CodeRabbit — AI code creates 1.7x more issues (2025)", url: "https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report" },
      { label: "Addy Osmani — AI PRs 24% more incidents, 30% higher change failure rate", url: "https://addyo.substack.com/p/code-review-in-the-age-of-ai" },
    ],
  },

  "repo-memory-convention": {
    rationale: "File naming conventions (kebab-case vs camelCase, suffix patterns like `*.test.ts`) carry meaning. New files that violate the repo-wide convention create discoverability friction. AI convention blindness extends to naming: AI generates names that are locally plausible but globally inconsistent with the existing tree.",
    threshold: "Repo-memory detects a convention with ≥80% confidence (≥80% of existing files match) AND new file violates it.",
    sources: [
      { label: "Christian Haller — AI Code Slop: convention blindness (naming) (May 2026)", url: "https://www.christianhaller.me/blog/projectblog/2026-05-17-AI_slop_eng/" },
      { label: "Eng-Leadership — AI Code Slop (convention blindness pattern)", url: "https://newsletter.eng-leadership.com/p/how-to-avoid-ai-code-slop" },
    ],
  },
};

/**
 * Top-level provenance — the curated, ranked design source for the
 * entire 13-rule rubric.
 */
export const RUBRIC_PROVENANCE = {
  stream: "'Good code' engineering principles → mechanical rubric",
  rationale_summary:
    "Rules are NOT subjective taste. Each threshold is anchored to multiple public sources: god-file 500 LOC (ESLint max-lines default 300; ESLint range 100–500; 2025 AI-era research 150–500 sweet spot); the 50 LOC / cc 15, nesting >3, params >4 thresholds independently confirmed by ESLint defaults, Shopify Ruby style guide, Google Python style guide, Martin Fowler, and Robert Martin. AI-specific smells (defensive-overreach, sprawling-abstraction, narrating-comment, repo-memory-*) backed by Haller 2026, Eng-Leadership, Anthropic Code Review, CodeRabbit 1.7x study, Addy Osmani.",
};

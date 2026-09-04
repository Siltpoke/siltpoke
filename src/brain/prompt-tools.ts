// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Critic prompt assembly with structured tool output.
 *
 *
 * Pure functions — no IO, no side effects.
 */

import { formatReviewSubjectBlock } from "../critic/tools/review-subject";
import type {
  EslintFinding,
  GitDiffHunk,
  RipgrepMatch,
  ToolName,
  ToolResult,
  TscDiagnostic,
} from "../critic/tools/types";
import {
  type DiffCoverage,
  describeCoverage,
  formatCoverageNotice,
  selectHunksForBudget,
} from "./hunk-selection";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ToolOutputSection = {
  /** Markdown-formatted tool-output block ready to embed in the critic prompt. */
  section: string;
  /**
   * `section` with the partial-coverage notice removed — the variant the
   * evidence-guard must use as its citation corpus.
   *
   * The guard's only test is whether a cited snippet appears verbatim in the
   * corpus (`evidence-guard.ts` `reasonItemFails`). Every other byte of
   * `section` is tool-derived — diff bodies, diagnostics, matched lines — so
   * "appears verbatim" means "the tool really said this". The coverage notice
   * is the one part siltpoke writes itself, in prose, and it is quotable:
   * `Not shown: 10 generated.` is a valid 10-240 char snippet, so a critique
   * could cite it against any changed file and be stamped `verified` while
   * pointing at nothing about the code.
   *
   * Keeping the two apart is what stops the fix for one honesty defect from
   * opening another.
   */
  citationSection: string;
  /**
   * What the budget cut, as FACTS rather than as prose in the prompt.
   *
   * The prompt asks the reviewer to declare partial coverage in `reasoning`,
   * and nothing verifies that it did (`schema.ts` has `reasoning` optional on
   * the path that runs). So the honest signal cannot come from the model —
   * siltpoke counts this itself and the surfaces state it on the review the
   * user reads. `null` when every hunk fitted.
   */
  diffCoverage: DiffCoverage | null;
  /**
   * Raw concatenated stdout from every tool — used by the evidence-guard substring check.
   * NOT normalized, NOT trimmed: verbatim bytes from each tool's raw field.
   */
  evidenceCorpus: string;
};

// ---------------------------------------------------------------------------
// Per-tool format budget caps
// ---------------------------------------------------------------------------

const TSC_BUDGET = 20;
const ESLINT_BUDGET = 20;
const RIPGREP_BUDGET = 50;
const RIPGREP_TEXT_MAX = 120;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NON_OK_STATUSES = new Set([
  "not_applicable",
  "not_installed",
  "timeout",
  "error",
  "output_too_large",
]);

function isNonOk(result: ToolResult): boolean {
  return NON_OK_STATUSES.has(result.status);
}

function formatTscBlock(parsed: TscDiagnostic[]): string {
  const capped = parsed.slice(0, TSC_BUDGET);
  const remaining = parsed.length - capped.length;
  const lines = capped.map(
    (d) =>
      `- \`${d.file}:${d.line}:${d.col}\` — ${d.code} ${d.severity}: ${d.message}`,
  );
  if (remaining > 0) {
    lines.push(`- ... (${remaining} more, errors-first)`);
  }
  return lines.join("\n");
}

function formatEslintBlock(parsed: EslintFinding[]): string {
  const capped = parsed.slice(0, ESLINT_BUDGET);
  const remaining = parsed.length - capped.length;
  const lines = capped.map(
    (d) =>
      `- \`${d.file}:${d.line}:${d.col}\` — ${d.ruleId} ${d.severity}: ${d.message}`,
  );
  if (remaining > 0) {
    lines.push(`- ... (${remaining} more)`);
  }
  return lines.join("\n");
}

/**
 * Render the diff block twice: once as the Brain sees it, and once without the
 * coverage notice for the evidence-guard's citation corpus. See
 * `ToolOutputSection.citationSection` for why they must differ.
 */
/**
 * Restrict the raw `git diff` stdout to the files that actually reached the
 * prompt.
 *
 * `evidenceCorpus` carries each tool's UNTRUNCATED stdout so a citation copied
 * from a body the formatter shortened still matches. For git-diff that meant
 * the FULL diff — including every hunk the budget cut. The guard's only test is
 * verbatim presence, so a critique could quote a file the reviewer was never
 * shown and be stamped `verified`, while the coverage notice in the same prompt
 * told it not to. Scoping the corpus to the shown files is what makes the
 * notice's instruction enforceable rather than advisory.
 *
 * Scoped per FILE, not per hunk: within a shown file the raw text is exactly
 * what the untruncated corpus exists for. The residual, stated rather than
 * implied — an omitted hunk of a file that IS shown remains citable.
 */
function scopeDiffRawToFiles(raw: string, shown: ReadonlySet<string>): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let keeping = false;
  let sawHeader = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      sawHeader = true;
      // `diff --git a/<path> b/<path>` — read the b-side, which is the name
      // run-git-diff pairs hunks with.
      const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      keeping = m !== null && shown.has(m[1]!);
    }
    if (keeping) out.push(line);
  }
  // A shape this parser does not recognise (no `diff --git` header at all —
  // stderr text, a `--stat` style output) is passed through untouched rather
  // than silently emptied: dropping a corpus we failed to parse would turn
  // legitimate citations into unverified ones.
  if (!sawHeader) return raw;
  return out.join("\n");
}

function formatGitDiffBlock(
  parsed: GitDiffHunk[],
  linterFiles: readonly string[],
): { shown: string; citable: string; shownFiles: Set<string>; coverage: DiffCoverage | null } {
  const { kept: capped, omitted } = selectHunksForBudget(parsed, { linterFiles });

  // Group hunks by file for rendering
  const byFile = new Map<string, GitDiffHunk[]>();
  for (const hunk of capped) {
    const existing = byFile.get(hunk.file);
    if (existing !== undefined) {
      existing.push(hunk);
    } else {
      byFile.set(hunk.file, [hunk]);
    }
  }

  const parts: string[] = [];
  for (const [file, hunks] of byFile.entries()) {
    parts.push(`#### ${file}`);
    for (const hunk of hunks) {
      parts.push("```diff", hunk.header, hunk.body, "```");
    }
  }

  const citable = parts.join("\n");
  let coverage: DiffCoverage | null = null;
  if (omitted.length > 0) {
    parts.push(...formatCoverageNotice(capped.length, omitted));
    coverage = describeCoverage(capped.length, omitted);
  }

  return {
    shown: parts.join("\n"),
    citable,
    shownFiles: new Set(byFile.keys()),
    coverage,
  };
}

function formatRipgrepBlock(parsed: RipgrepMatch[]): string {
  const capped = parsed.slice(0, RIPGREP_BUDGET);
  const remaining = parsed.length - capped.length;
  const lines = capped.map((m) => {
    const text = m.text.length > RIPGREP_TEXT_MAX
      ? m.text.slice(0, RIPGREP_TEXT_MAX)
      : m.text;
    return `- \`${m.file}:${m.line}\` — ${text}`;
  });
  if (remaining > 0) {
    lines.push(`- ... (${remaining} more)`);
  }
  return lines.join("\n");
}

const TOOL_LABELS: Record<ToolName, string> = {
  tsc: "tsc diagnostics (top 20)",
  eslint: "eslint findings (top 20)",
  "git-diff": "git diff (changes)",
  ripgrep: "ripgrep matches (top 50)",
};

const TOOL_SECTION_HEADERS: Record<ToolName, string> = {
  tsc: "### tsc diagnostics (top 20)",
  eslint: "### eslint findings (top 20)",
  "git-diff": "### git diff (changes)",
  ripgrep: "### ripgrep matches (top 50)",
};

// Short header used in "clean" one-liners
const TOOL_SHORT_NAMES: Record<ToolName, string> = {
  tsc: "tsc",
  eslint: "eslint",
  "git-diff": "git diff",
  ripgrep: "ripgrep",
};

// ---------------------------------------------------------------------------
// buildToolOutputSection
// ---------------------------------------------------------------------------

/**
 * Build the structured tool-output section + raw evidence corpus.
 *
 * Per spec PQ4 lock B:
 * - tsc: top-20 diagnostics errors-first, alphabetical-by-file, by line
 * - eslint: top-20 same shape as tsc
 * - git-diff: unified diff per file with head-truncate body at 30 lines (already done by runner)
 * - ripgrep: top-50 matches, alphabetical
 * - tools with status !== "ok" are LISTED in a header block (skipped tools), not in the body
 * - evidenceCorpus is the RAW (untruncated) stdout from every tool, concatenated with separators
 *
 * Pure function: no IO, no side effects.
 */
export function buildToolOutputSection(
  results: Record<ToolName, ToolResult>,
): ToolOutputSection {
  const toolOrder: ToolName[] = ["tsc", "eslint", "git-diff", "ripgrep"];

  // Separate ok tools (may have body blocks) from skipped tools
  const skippedEntries: Array<{ name: ToolName; status: string }> = [];
  const okResults: Array<{ name: ToolName; result: ToolResult }> = [];

  for (const name of toolOrder) {
    const result = results[name];
    if (result === undefined) continue;

    if (isNonOk(result)) {
      skippedEntries.push({ name, status: result.status });
    } else {
      okResults.push({ name, result });
    }
  }

  // Collect ran-tool names and skipped names for header
  const ranNames = okResults.map((e) => e.name).join(", ");
  const skippedParts = skippedEntries.map((e) => `${e.name} (${e.status})`).join(", ");

  const headerLines: string[] = ["## Tool output", ""];
  if (ranNames) {
    headerLines.push(`**Tools ran:** ${ranNames}`);
  }
  if (skippedParts) {
    headerLines.push(`**Tools skipped:** ${skippedParts}`);
  }
  headerLines.push("");

  // Files a linter complained about — used to rank git-diff hunks (defect ③).
  //
  // Read from `parsed` on the RESULTS rather than by re-parsing the formatted
  // blocks: same file set either way (both runners already cap `parsed` at 20
  // via their own sortAndCap, and the format budgets are also 20), but reading
  // the structured field cannot drift from the rendering.
  //
  // In siltpoke's OWN repo this list is usually empty on the eslint side — the
  // repo has no eslint config, so `runEslint` exits non-zero and the result is
  // `status: "error"`. The linter key therefore mostly earns its keep in
  // adopter repos, not here.
  const linterFiles: string[] = [];
  const tscResult = results.tsc;
  if (tscResult !== undefined && !isNonOk(tscResult) && tscResult.tool === "tsc") {
    for (const d of tscResult.parsed) linterFiles.push(d.file);
  }
  const eslintResult = results.eslint;
  if (eslintResult !== undefined && !isNonOk(eslintResult) && eslintResult.tool === "eslint") {
    for (const d of eslintResult.parsed) linterFiles.push(d.file);
  }

  // Build body blocks for ok tools.
  const bodyParts: string[] = [];
  // Positions in `bodyParts` whose citable variant differs from what the Brain is
  // shown — each one is a block carrying siltpoke's own prose alongside real tool
  // output (the partial-coverage notice, the review-subject notice). Recorded as
  // parts so `citationSection` can be rebuilt from the same pieces, rather than
  // recovered by string-surgery on the finished section.
  const citableOverrides: Array<{ index: number; text: string }> = [];
  // Files whose hunks actually reached the prompt — null while no git-diff
  // block was rendered, which leaves the raw corpus untouched.
  let shownDiffFiles: Set<string> | null = null;
  let diffCoverage: DiffCoverage | null = null;

  for (const { name, result } of okResults) {
    if (name === "tsc") {
      const r = result as Extract<ToolResult, { tool: "tsc" }>;
      if (r.parsed.length === 0) {
        bodyParts.push(`### ${TOOL_SHORT_NAMES[name]} — clean (no findings)`);
      } else {
        bodyParts.push(TOOL_SECTION_HEADERS[name]);
        bodyParts.push("");
        bodyParts.push(formatTscBlock(r.parsed));
      }
    } else if (name === "eslint") {
      const r = result as Extract<ToolResult, { tool: "eslint" }>;
      if (r.parsed.length === 0) {
        bodyParts.push(`### ${TOOL_SHORT_NAMES[name]} — clean (no findings)`);
      } else {
        bodyParts.push(TOOL_SECTION_HEADERS[name]);
        bodyParts.push("");
        bodyParts.push(formatEslintBlock(r.parsed));
      }
    } else if (name === "git-diff") {
      const r = result as Extract<ToolResult, { tool: "git-diff" }>;
      if (r.parsed.length === 0) {
        bodyParts.push(`### ${TOOL_SHORT_NAMES[name]} — clean (no findings)`);
      } else {
        const diffBlock = formatGitDiffBlock(r.parsed, linterFiles);
        shownDiffFiles = diffBlock.shownFiles;
        diffCoverage = diffBlock.coverage;
        bodyParts.push(TOOL_SECTION_HEADERS[name]);
        bodyParts.push("");
        // Multi-commit fallback only: name the one commit whose message the diff
        // may be judged against. Without it the reviewer sees N commits' hunks and
        // one undelimited message soup, and has twice filed an accusatory false
        // positive off the mismatch. It goes into `section` but NOT into
        // `citationSection`: like the coverage notice, it is siltpoke's own prose,
        // and the evidence guard must not accept it as something a tool said.
        if (r.reviewSubject !== undefined) {
          const subjectBlock = formatReviewSubjectBlock(r.reviewSubject);
          bodyParts.push(subjectBlock.shown);
          citableOverrides.push({ index: bodyParts.length - 1, text: subjectBlock.citable });
          bodyParts.push("");
        }
        bodyParts.push(diffBlock.shown);
        citableOverrides.push({ index: bodyParts.length - 1, text: diffBlock.citable });
      }
    } else if (name === "ripgrep") {
      const r = result as Extract<ToolResult, { tool: "ripgrep" }>;
      if (r.parsed.length === 0) {
        bodyParts.push(`### ${TOOL_SHORT_NAMES[name]} — clean (no findings)`);
      } else {
        bodyParts.push(TOOL_SECTION_HEADERS[name]);
        bodyParts.push("");
        bodyParts.push(formatRipgrepBlock(r.parsed));
      }
    }
    bodyParts.push("");
  }

  const section = [...headerLines, ...bodyParts].join("\n").trimEnd();

  const citableParts = [...bodyParts];
  for (const o of citableOverrides) {
    citableParts[o.index] = o.text;
  }
  const citationSection = [...headerLines, ...citableParts].join("\n").trimEnd();

  // Build evidence corpus: concatenate RAW stdout from every tool (non-empty raws only),
  // verbatim — no normalization.
  const rawParts: string[] = [];
  for (const name of toolOrder) {
    if (name === "git-diff" && shownDiffFiles !== null) {
      const r = results[name];
      if (r !== undefined && r.raw.length > 0) {
        const scoped = scopeDiffRawToFiles(r.raw, shownDiffFiles);
        if (scoped.length > 0) rawParts.push(scoped);
      }
      continue;
    }
    const result = results[name];
    if (result !== undefined && result.raw.length > 0) {
      rawParts.push(result.raw);
    }
  }
  const evidenceCorpus = rawParts.join("\n--- corpus separator ---\n");

  return { section, citationSection, evidenceCorpus, diffCoverage };
}

// ---------------------------------------------------------------------------
// buildPassiveBubblePrompt
// ---------------------------------------------------------------------------

/**
 * Options shape for the intent-aware overload.
 * Callers may pass `{ files, hunks, intent? }` directly.
 */
export interface PassiveBubbleOpts {
  files: number;
  hunks: number;
  intent?: { classification: string; confidence: number };
}

/**
 * Build the passive-bubble prompt for the PASSIVE_BUBBLE gate path.
 *
 * Accepts two calling conventions for backward compatibility:
 *   1. Legacy: `buildPassiveBubblePrompt(gitDiffToolResult)` — extracts file/hunk
 *      counts from the parsed diff; intent defaults to unknown (neutral verb).
 *   2. New: `buildPassiveBubblePrompt({ files, hunks, intent? })` — callers
 *      pass pre-computed counts and an optional intent classification so the verb
 *      ("refactor" vs "change") is contextually accurate.
 *
 * Rule: "refactor" wording is used only when `intent.classification === "refactor"`.
 * All other intents (bugfix, chore, exploration, unknown) use neutral "change" wording.
 *
 * Pure function — no IO, no side effects.
 */
export function buildPassiveBubblePrompt(
  diffOrOpts: Extract<ToolResult, { tool: "git-diff" }> | PassiveBubbleOpts,
): string {
  let fileCount: number;
  let hunkCount: number;
  let intent: { classification: string; confidence: number } | undefined;

  if ("tool" in diffOrOpts) {
    // Legacy call path: ToolResult shape
    const hunks = diffOrOpts.parsed;
    hunkCount = hunks.length;
    fileCount = new Set(hunks.map((h) => h.file)).size;
    intent = undefined;
  } else {
    // New call path: PassiveBubbleOpts shape
    fileCount = diffOrOpts.files;
    hunkCount = diffOrOpts.hunks;
    intent = diffOrOpts.intent;
  }

  const isRefactor = intent?.classification === "refactor";
  const verbPast = isRefactor ? "completed a refactor" : "made a change";
  const fileWord = fileCount === 1 ? "file" : "files";
  const hunkWord = hunkCount === 1 ? "hunk" : "hunks";

  return (
    `The user just ${verbPast}. ` +
    `${fileCount} ${fileWord} changed, ${hunkCount} ${hunkWord} across the diff. ` +
    `All linters and the search-for-issues pass came back clean. ` +
    `Emit a brief, happy-mood bubble acknowledging the clean work — ` +
    `no critique_for_claude needed (set it to empty string "" in your JSON output). ` +
    `evidence array should be empty [] in this mode.`
  );
}

// Re-export the label map for downstream consumers that need to render tool names
export { TOOL_LABELS };

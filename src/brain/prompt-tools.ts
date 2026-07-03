// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Critic prompt assembly with structured tool output.
 *
 *
 * Pure functions — no IO, no side effects.
 */

import type {
  ToolName,
  ToolResult,
  TscDiagnostic,
  EslintFinding,
  GitDiffHunk,
  RipgrepMatch,
} from "../critic/tools/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ToolOutputSection = {
  /** Markdown-formatted tool-output block ready to embed in the critic prompt. */
  section: string;
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
const GIT_DIFF_HUNK_BUDGET = 20;
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

function formatGitDiffBlock(parsed: GitDiffHunk[]): string {
  const capped = parsed.slice(0, GIT_DIFF_HUNK_BUDGET);
  const omitted = parsed.length - capped.length;

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

  if (omitted > 0) {
    parts.push(`(+${omitted} more hunks omitted)`);
  }

  return parts.join("\n");
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

  // Build body blocks for ok tools
  const bodyParts: string[] = [];

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
        bodyParts.push(TOOL_SECTION_HEADERS[name]);
        bodyParts.push("");
        bodyParts.push(formatGitDiffBlock(r.parsed));
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

  // Build evidence corpus: concatenate RAW stdout from every tool (non-empty raws only),
  // verbatim — no normalization.
  const rawParts: string[] = [];
  for (const name of toolOrder) {
    const result = results[name];
    if (result !== undefined && result.raw.length > 0) {
      rawParts.push(result.raw);
    }
  }
  const evidenceCorpus = rawParts.join("\n--- corpus separator ---\n");

  return { section, evidenceCorpus };
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

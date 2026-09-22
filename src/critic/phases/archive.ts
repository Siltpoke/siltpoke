// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// Archive phase: write the v2 sidecar + build the prompt sections that
// surface diff-summary and rubric evidence to the Brain.

import type { BrainContext, V2ResultFields } from "../types";
import type { DiffSummary } from "../tools/run-diff-summary";
import type { CapturedIntent } from "../intent/capture";
import type { RubricTrigger } from "../rubric/types";

/**
 * Build the v2 evidence block from rubric triggers for the critique frontmatter.
 * Returns a YAML-safe multi-line string ready to embed in the --- block.
 */
function buildEvidenceBlock(triggers: RubricTrigger[]): string {
  if (triggers.length === 0) return "evidence: []";
  const items = triggers.slice(0, 20).map((t) =>
    `  - rule_id: ${t.rule_id}\n    tier: ${t.tier}\n    severity: ${t.severity}\n    file: ${t.file}\n    line: ${t.line}\n    message: "${t.message.replace(/"/g, '\\"').replace(/\n/g, " ")}"`
  );
  return `evidence:\n${items.join("\n")}`;
}

/**
 * Brain produced empty critique_for_claude even when Haiku flagged real
 * concerns. This section is short, structured, and reasoning-friendly.
 */
export function buildDiffSummarySection(summary: DiffSummary): string {
  const blocks: string[] = ["## Diff summary (Haiku pre-pass)", ""];
  if (summary.intent && summary.intent.length > 0) {
    blocks.push(`**Intent:** ${summary.intent}`);
    blocks.push("");
  }
  if (summary.key_changes.length > 0) {
    blocks.push("**Key changes:**");
    for (const k of summary.key_changes.slice(0, 8)) blocks.push(`- ${k}`);
    blocks.push("");
  }
  if (summary.risks.length > 0) {
    blocks.push("**Risks flagged by pre-pass — address each in your critique unless you have grounds to disagree:**");
    for (const r of summary.risks.slice(0, 6)) blocks.push(`- ${r}`);
    blocks.push("");
    blocks.push("If any risk is concrete and actionable, mention it in `critique_for_claude` and elevate `severity` from `info` to at least `low`. Do NOT silently emit info-only when risks exist.");
  }
  blocks.push("");
  return blocks.join("\n");
}

/**
 * How many triggers this section shows. Exported as one constant because the
 * section and its citation corpus MUST cap at the same place: a corpus longer
 * than the section would certify a line the reviewer was never shown.
 */
const RUBRIC_SECTION_CAP = 20;

/** Bounds copied from `evidenceItemSchema.snippet` (src/brain/schema.ts). */
const CITABLE_MIN_LEN = 10;
const CITABLE_MAX_LEN = 240;

/**
 * The trigger's own source line when the reviewer could legally cite it, else
 * `null`. Three independent reasons to refuse, each named rather than merged:
 *
 * 1. NOT SOURCE — the rule synthesized the string (`snippet_is_source` absent).
 *    Offering it would let siltpoke's own prose pass a check whose whole job is
 *    to ask whether a tool really said this. Absent means refused, so a rule
 *    added later is uncitable until its author marks it.
 * 2. MULTI-LINE — `god-file` cites `src.slice(0, 200)`, which spans several
 *    lines and is usually cut mid-token. It would wreck the one-bullet-per-
 *    finding shape and hands the reviewer an arbitrary fragment as "evidence".
 * 3. OUTSIDE THE BAND — under `min(10)` the evidence item is dropped at parse,
 *    over `max(240)` it is truncated with an ellipsis, and the truncated form
 *    then fails the verbatim check anyway. A worse offer than no offer.
 *
 * A refused trigger still appears in the section — the finding is real — it
 * just carries no `code:` line.
 *
 * Trimmed because the rendered line and the corpus entry must be the same
 * bytes, and the rendered one cannot keep leading indentation.
 */
export function citableRubricSnippet(trigger: RubricTrigger): string | null {
  if (trigger.snippet_is_source !== true) return null;
  if (trigger.snippet.includes("\n")) return null;
  const trimmed = trigger.snippet.trim();
  if (trimmed.length < CITABLE_MIN_LEN || trimmed.length > CITABLE_MAX_LEN) return null;
  return trimmed;
}

export function buildRubricEvidenceSection(triggers: RubricTrigger[]): string {
  const capped = triggers.slice(0, RUBRIC_SECTION_CAP);
  const lines = capped.flatMap((t) => {
    const head = `- [${t.severity.toUpperCase()}] \`${t.file}:${t.line}\` — ${t.rule_id}: ${t.message}`;
    const code = citableRubricSnippet(t);
    return code === null ? [head] : [head, `  code: ${code}`];
  });
  return [
    "## Rubric evidence",
    "",
    "The following structural issues were detected by the rubric engine before this call:",
    "",
    ...lines,
    "",
    "Incorporate these observations into your critique where relevant. Do NOT hallucinate additional findings.",
  ].join("\n");
}

/**
 * The source lines behind this section, for the evidence guard's corpus.
 *
 * Same role as the caller-impact and reverse-deps token lists in normal.ts: the
 * text is read off disk by a deterministic rule engine, so quoting it verbatim
 * is not a fabrication and the guard should say so. Without this the section is
 * unciteable by construction — every snippet in it is checked against a corpus
 * built from four tools the rubric is not one of.
 *
 * The rule MESSAGES are deliberately absent, for the reason the Haiku diff
 * summary is absent: siltpoke's own prose must not pass a check that exists to
 * ask whether a tool really said this.
 */
export function rubricEvidenceCitationTokens(triggers: RubricTrigger[]): string[] {
  const out: string[] = [];
  for (const t of triggers.slice(0, RUBRIC_SECTION_CAP)) {
    const code = citableRubricSnippet(t);
    if (code !== null) out.push(code);
  }
  return out;
}

/**
 * Build the captured-intent YAML block for the v2 frontmatter.
 * Uses YAML literal block scalar (|) to preserve newlines in multi-line strings.
 */
function buildCapturedIntentBlock(ci: CapturedIntent | undefined): string {
  const indent = (s: string): string =>
    s.split("\n").map((l) => `  ${l}`).join("\n");

  const queryLine = ci && ci.user_raw_query !== null
    ? `user_raw_query: |\n${indent(ci.user_raw_query)}`
    : "user_raw_query: null";

  const replyLine = ci && ci.agent_reply !== null
    ? `agent_reply: |\n${indent(ci.agent_reply)}`
    : "agent_reply: null";

  return [queryLine, replyLine].join("\n");
}

/**
 * Write a v2 sidecar archive file with schema_version:2 frontmatter alongside
 * the standard critique. Fail-soft: errors are swallowed.
 *
 * File: {stateBase}/critiques/archive/{day}/{id}.v2.md
 */
export async function writeV2Archive(
  stateBase: string,
  critiqueId: string,
  brainContext: BrainContext,
  v2: V2ResultFields,
  changedFiles: string[] = [],
): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const day = new Date().toISOString().slice(0, 10);
  const archiveDir = join(stateBase, "critiques", "archive", day);
  await mkdir(archiveDir, { recursive: true });

  const triggers = v2.rubricTriggers ?? [];
  const evidenceBlock = buildEvidenceBlock(triggers);
  const intentClass = v2.intentResult?.classification ?? "unknown";
  const intentConf = v2.intentResult?.confidence ?? 0;
  const signalSrc = v2.intentResult?.signal_source ?? "none";

  // Captured intent fields. Use YAML literal block scalar (|)
  // to preserve newlines and indentation in multi-line strings.
  const ci = v2.capturedIntent;
  const capturedIntentBlock = buildCapturedIntentBlock(ci);

  // Bug 2 fix: write changed_files block so Block A shows real file list.
  const changedFilesBlock = changedFiles.length > 0
    ? `changed_files:\n${changedFiles.map((f) => `  - ${f}`).join("\n")}`
    : "changed_files: []";

  const frontmatter = [
    "---",
    `schemaVersion: 2`,
    `critique_id: ${critiqueId}`,
    `session_id: ${brainContext.sessionId}`,
    `cwd: ${brainContext.cwd}`,
    `intent_classification: ${intentClass}`,
    `intent_confidence: ${intentConf}`,
    `signal_sources: ${signalSrc}`,
    `rubric_trigger_count: ${triggers.length}`,
    `rubric_suppressed_count: ${v2.rubricSuppressedCount ?? 0}`,
    changedFilesBlock,
    evidenceBlock,
    capturedIntentBlock,
    "---",
  ].join("\n");

  const body = `\n# V2 Evidence Sidecar\n\nThis file records structured evidence from the rubric + intent pipeline.\nSee \`${critiqueId}.md\` for the full critique.\n`;

  const filePath = join(archiveDir, `${critiqueId}.v2.md`);
  await writeFile(filePath, frontmatter + body, "utf8");
}

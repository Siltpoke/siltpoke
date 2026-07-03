// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
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

export function buildRubricEvidenceSection(triggers: RubricTrigger[]): string {
  const capped = triggers.slice(0, 20);
  const lines = capped.map(
    (t) => `- [${t.severity.toUpperCase()}] \`${t.file}:${t.line}\` — ${t.rule_id}: ${t.message}`,
  );
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

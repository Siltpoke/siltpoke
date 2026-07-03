#!/usr/bin/env bun
/**
 * eval-run.ts — Eval harness runner for siltpoke critic pipeline.
 *
 * Usage:
 *   bun scripts/eval-run.ts --fast   # mock pipeline, no API calls
 *   bun scripts/eval-run.ts          # real mode (not yet implemented)
 */
import { join } from "node:path";
import { classifyIntent } from "../src/critic/intent/classifier";
import { runRubric } from "../src/critic/rubric/engine";
import { ALL_RUBRIC_RULES } from "../src/critic/rubric/rules";
import { scanSecrets } from "../src/critic/security/secrets-scan";
import type { RubricInput } from "../src/critic/rubric/types";
import { loadFixtures, runFixture } from "../src/eval/harness";
import { formatReport } from "../src/eval/metrics";

const FIXTURES_DIR = join(import.meta.dir, "../src/eval/fixtures");
const args = process.argv.slice(2);
const isFast = args.includes("--fast");

function print(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

if (!isFast) {
  print(
    "Real mode not yet implemented; use --fast for mock pipeline (no API cost).",
  );
  process.exit(0);
}

// ── Mock runCritique ─────────────────────────────────────────────────────────

interface AddedLineEntry {
  line: number;
  text: string;
}

interface DiffHunkEntry {
  file: string;
  addedLines: AddedLineEntry[] | number[];
}

function normaliseAddedLines(raw: AddedLineEntry[] | number[]): number[] {
  return raw.map((l) => (typeof l === "number" ? l : l.line));
}

function normaliseAddedLineObjects(
  raw: AddedLineEntry[] | number[],
): AddedLineEntry[] {
  return raw.map((l) =>
    typeof l === "number" ? { line: l, text: "" } : l,
  );
}

function buildGodFileTriggers(
  fileLineCounts: Record<string, number>,
): Array<{
  rule_id: string;
  tier: 1;
  severity: "high";
  file: string;
  line: number;
  end_line: number;
  snippet: string;
  message: string;
}> {
  const results = [];
  for (const [file, lines] of Object.entries(fileLineCounts)) {
    if (lines > 800) {
      results.push({
        rule_id: "god-file",
        tier: 1 as const,
        severity: "high" as const,
        file,
        line: 1,
        end_line: lines,
        snippet: `(synthetic: file is ${lines} lines)`,
        message: `File is ${lines} lines (threshold: 800).`,
      });
    }
  }
  return results;
}

/**
 * Fast mock: runs intent classifier + rubric rules + secrets scan locally.
 * Returns a synthetic BrainOutputV2-shaped object — no API calls made.
 */
async function mockRunCritique(
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const userMessage = String(input.user_message ?? "");
  const commitMsg =
    input.commit_msg != null ? String(input.commit_msg) : null;
  const diffFiles = (input.diff_files as string[] | undefined) ?? [];
  const diffHunksRaw = (input.diff_hunks as DiffHunkEntry[] | undefined) ?? [];
  const fileLineCounts =
    (input.file_line_counts as Record<string, number> | undefined) ?? {};

  const changed_file_exts = new Set(
    diffFiles.map((f) => {
      const m = f.match(/\.([^./]+)$/);
      return m ? m[1].toLowerCase() : "";
    }),
  );

  const intent = classifyIntent({
    user_message: userMessage,
    commit_msg: commitMsg,
    changed_file_exts,
  });

  const changedFiles =
    diffFiles.length > 0 ? diffFiles : Object.keys(fileLineCounts);

  const diffHunks: RubricInput["diffHunks"] = diffHunksRaw.map((h) => ({
    file: h.file,
    addedLines: normaliseAddedLines(h.addedLines),
  }));

  const rubricResult = await runRubric(
    { cwd: process.cwd(), changedFiles, diffHunks },
    ALL_RUBRIC_RULES,
  );

  const secretsTriggers = diffHunksRaw.flatMap((h) =>
    scanSecrets({
      file: h.file,
      addedLines: normaliseAddedLineObjects(h.addedLines),
    }),
  );

  const allTriggers = [
    ...rubricResult.triggers,
    ...secretsTriggers,
    ...buildGodFileTriggers(fileLineCounts),
  ];

  const evidence = allTriggers.map((t) => ({
    rule_id: t.rule_id,
    tier: t.tier,
    severity: t.severity,
    file: t.file,
    line: t.line,
    message: t.message,
  }));

  const isLargeDiff =
    input.large_diff === true ||
    (input.diff_text != null && String(input.diff_text).length > 2000);
  const largeDiffNote = isLargeDiff
    ? " [diff truncated — large diff detected]"
    : "";
  const critique_for_claude =
    intent.classification === "bugfix"
      ? `Looks like a targeted fix. Suggested change: verify the null guard covers all call sites.${largeDiffNote}`
      : `Suggested change: review the ${evidence.length} finding(s) above before merging.${largeDiffNote}`;

  return { intent, evidence, critique_for_claude, _mock: true };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  print(`Loading fixtures from ${FIXTURES_DIR} ...\n`);
  const fixtures = await loadFixtures(FIXTURES_DIR);

  if (fixtures.length === 0) {
    print("No fixtures found — nothing to run.");
    process.exit(0);
  }

  print(`Running ${fixtures.length} fixture(s) in --fast mode ...\n`);

  const results = await Promise.all(
    fixtures.map((f) => runFixture(f, mockRunCritique)),
  );

  print(formatReport(results));

  const anyFailed = results.some((r) => !r.passed);
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error("eval-run fatal:", err);
  process.exit(1);
});

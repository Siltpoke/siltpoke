// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The glue around the injection alert, for every caller (NORMAL, PASSIVE_BUBBLE, the legacy
 * Stop-hook path): `reviewAlert` is the impure half (works out the two directories the pure
 * `alertForReview` needs, once per review); `scanReviewInputs` / `safeScan` assemble the rule
 * scan's input (pure, and never throw).
 */
import { homedir } from "node:os";
import type { BrainProviderMeta } from "../brain/provider";
import type { InjectionSuspectedItem } from "../brain/schema";
import type { ToolCallsField } from "../brain/tool-calls";
import { gitRepoRoot } from "../utils/git-root";
import { alertForReview, type InjectionAlert } from "./injection-alert";
import { mergeScans, type ScanResult, scanHunks, scanNotes } from "./injection-scan";
import type { ToolResult } from "./tools/types";

/**
 * The cwd the reviewer's tools really ran in, so a relative tool path resolves where the
 * reviewer resolved it. claude is spawned with no `cwd` (src/brain/brain.ts runBrainCall —
 * deliberately, so it does not load the project's CLAUDE.md), so it runs in siltpoke's own
 * `process.cwd()`. codex gets `-C <cwd>` from `resolveReviewerCwd` (src/brain/providers/codex.ts
 * runCodexCall) — the session cwd, or `process.cwd()` when that is empty. Other families
 * record no tool calls, so the value is unused for them and they fall through to the codex
 * rule. It is not where they ran: agy runs in a fresh empty dir per call
 * (src/brain/providers/agy-cwd.ts).
 */
export function reviewerToolCwd(provider: BrainProviderMeta["name"], sessionCwd: string, processCwd: string = process.cwd()): string {
  if (provider === "claude") return processCwd;
  return sessionCwd === "" ? processCwd : sessionCwd;
}

/**
 * The rule scan for one review: the diff hunks (when the diff tool ran ok) and the project
 * notes block exactly as the prompt carried it (`undefined` when this reviewer gets none).
 */
export function scanReviewInputs(gitDiff: ToolResult, notes?: string): ScanResult {
  return safeScan(() =>
    mergeScans(
      gitDiff.tool === "git-diff" && gitDiff.status === "ok" ? scanHunks(gitDiff.parsed) : mergeScans(),
      notes ? scanNotes(notes) : mergeScans(),
    ),
  );
}

/** The scan only warns: if it throws, the review goes on with no scan signals. */
export function safeScan(run: () => ScanResult): ScanResult {
  try {
    return run();
  } catch (err) {
    console.warn(`[siltpoke] injection scan failed: ${err instanceof Error ? err.message : String(err)}`);
    return mergeScans();
  }
}

export interface ReviewAlertInput {
  items: InjectionSuspectedItem[] | undefined;
  /** What the model was given (system prompt + user message). */
  readText: string;
  toolCalls: ToolCallsField | undefined;
  /** The session cwd from the hook payload. */
  cwd: string;
  provider: BrainProviderMeta["name"];
  /** Rule-scan of the project text this review saw. Required: every caller decides what it scanned. */
  scan: ScanResult;
}

export async function reviewAlert(input: ReviewAlertInput): Promise<InjectionAlert | undefined> {
  // The repository, not the session cwd: a session opened in a subdir still owns the whole repo.
  const projectRoot = (await gitRepoRoot(input.cwd)) ?? input.cwd;
  const reviewerCwd = reviewerToolCwd(input.provider, input.cwd);
  return alertForReview(input.items, input.readText, input.toolCalls, projectRoot, homedir(), reviewerCwd, input.scan.signals) ?? undefined;
}

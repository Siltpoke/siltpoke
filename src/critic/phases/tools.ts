// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
// Tools phase: runTools + git-diff fallback to recent commits + on-disk
// critic snapshot. Returns the toolResults the rest of the pipeline reads
// from, plus the snapshot id for the result envelope.

import { runTools as defaultRunTools } from "../tools/run-tools";
import { runRecentCommitsDiff } from "../tools/run-git-diff";
import { writeCriticSnapshot } from "../writeSnapshot";
import { ALL_TOOL_NAMES, recordToolRun } from "../../state/critic-counters";
import type { ProjectCapabilities } from "../capabilities";
import type { CriticSource } from "../types";

export interface ToolsPhaseArgs {
  cwd: string;
  changedFiles: string[];
  caps: ProjectCapabilities;
  homeBase: string | undefined;
  source: CriticSource;
  sessionId: string;
  runToolsFn: typeof defaultRunTools;
}

export type ToolsPhaseResult =
  | { ok: true; toolResults: Awaited<ReturnType<typeof defaultRunTools>>; diffSnapshotId: string | undefined; diffBody: string }
  | { ok: false; reason: string };

/**
 * Run all applicable tools, then patch git-diff with last-N commits when the
 * working tree is clean, then write a snapshot to disk for the /critic page.
 * Returns the resolved toolResults (with possibly-patched git-diff) + the
 * diffBody (raw diff text used by the diff-summary pre-pass).
 *
 * Fail-soft on per-tool errors via toolResults[name].status; only an
 * unexpected throw from runToolsFn itself surfaces as { ok: false }.
 */
export async function runToolsPhase(args: ToolsPhaseArgs): Promise<ToolsPhaseResult> {
  const { cwd, changedFiles, caps, homeBase, source, sessionId, runToolsFn } = args;

  let toolResults: Awaited<ReturnType<typeof defaultRunTools>>;
  try {
    toolResults = await runToolsFn({ cwd, changedFiles, caps });
  } catch (err) {
    const reason = `runTools threw unexpectedly: ${err}`;
    console.error(`[siltpoke] runCritic [${source}] HARD_SUPPRESS — ${reason}`);
    return { ok: false, reason };
  }

  // Record per-tool status telemetry (fire-and-forget; failure is swallowed).
  // Iterate ONLY the four real tool cells — runTools also returns
  // securityFindings / owaspHints / webSearchSources, which are NOT ToolResults;
  // iterating Object.entries() over them recorded bogus tool names and threw a
  // TypeError per extra key inside recordToolRun.
  if (homeBase !== undefined) {
    for (const name of ALL_TOOL_NAMES) {
      void recordToolRun(homeBase, name, toolResults[name].status);
    }
  }

  // Fallback to last-N commits when the working tree is clean — otherwise
  // a developer who commits frequently never produces a snapshot, AND
  // Brain has no diff context to reason from on the post-commit Stop hook.
  // We patch BOTH (a) the toolResults["git-diff"] payload that Brain reads
  // and (b) the on-disk snapshot the /critic page renders.
  //
  // Guarded by status === "ok" so we only kick in for the legit
  // "working tree clean" case — never when git-diff explicitly failed
  // (not_applicable / not_installed / timeout / error). That keeps the
  // `review` CLI's "no usable evidence" abstention path working.
  const gd = toolResults["git-diff"];
  if (gd.tool === "git-diff" && gd.status === "ok") {
    const gdRawNow = typeof gd.raw === "string" ? gd.raw : "";
    if (gdRawNow.trim().length === 0) {
      try {
        const fallback = await runRecentCommitsDiff({ cwd });
        if (fallback) {
          // Replace empty git-diff result with the recent-commits body so
          // buildToolOutputSection includes it in Brain's prompt AND
          // classifyToolOutput sees hunks (so we hit PASSIVE_BUBBLE
          // instead of HARD_SUPPRESS on a "clean refactor").
          toolResults["git-diff"] = {
            tool: "git-diff",
            status: "ok",
            parsed: fallback.parsed,
            raw: fallback.raw,
          };
        }
      } catch {
        // non-fatal — leave git-diff result unchanged
      }
    }
  }

  // Capture git-diff snapshot to disk so /critic page can show "what
  // siltpoke was looking at" alongside the comment/critique. Fail-soft.
  let diffSnapshotId: string | undefined;
  const gdFinal = toolResults["git-diff"];
  const diffBody =
    gdFinal.tool === "git-diff" && typeof gdFinal.raw === "string" ? gdFinal.raw : "";
  if (homeBase !== undefined && diffBody.trim().length > 0) {
    const snap = await writeCriticSnapshot(homeBase, sessionId, diffBody);
    diffSnapshotId = snap?.id;
  }

  return { ok: true, toolResults, diffSnapshotId, diffBody };
}

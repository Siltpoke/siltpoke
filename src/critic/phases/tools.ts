// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// Tools phase: runTools + git-diff fallback to recent commits + on-disk
// critic snapshot. Returns the toolResults the rest of the pipeline reads
// from, plus the snapshot id for the result envelope.

import { ALL_TOOL_NAMES, recordToolRun } from "../../state/critic-counters";
import type { ProjectCapabilities } from "../capabilities";
import { runRecentCommitsDiff } from "../tools/run-git-diff";
import type { runTools as defaultRunTools } from "../tools/run-tools";
import type { CriticSource } from "../types";
import { writeCriticSnapshot } from "../writeSnapshot";

export interface ToolsPhaseArgs {
  cwd: string;
  changedFiles: string[];
  caps: ProjectCapabilities;
  homeBase: string | undefined;
  source: CriticSource;
  sessionId: string;
  runToolsFn: typeof defaultRunTools;
  /**
   * Tracing context, forwarded verbatim to `runTools` so each tool invocation
   * emits its own `siltpoke.tool.<name>` child span under the turn.
   *
   * This field is failure **F9.1** in the critic failure register: the spans
   * were written, `run-tools.test.ts` proved they fire, and no caller ever
   * passed a context — so across 84 days of traces not one was ever recorded.
   * `undefined` keeps the old silence, which is what every non-traced caller
   * (the `review` CLI, most tests) still wants.
   */
  tracing?: Parameters<typeof defaultRunTools>[0]["tracing"];
  /**
   * The unit of work under review (`<lastReviewedHead>..HEAD`, spec D2),
   * forwarded verbatim to `runTools`. Present only when the review-unit gate
   * named a boundary; absent for a forced review on a clean tree and for every
   * caller that predates the axis.
   */
  revisionRange?: string;
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
  const {
    cwd, changedFiles, caps, homeBase, source, sessionId, runToolsFn, tracing, revisionRange,
  } = args;

  let toolResults: Awaited<ReturnType<typeof defaultRunTools>>;
  try {
    toolResults = await runToolsFn({
      cwd,
      changedFiles,
      caps,
      tracing,
      ...(revisionRange !== undefined ? { revisionRange } : {}),
    });
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
  //
  // NOT taken when the caller named a revision range. The range already IS the
  // unit of work, so an empty result there means "this unit changed nothing git
  // can show" — and answering that by pasting three commits' log back in is how
  // the #668 shape (one commit's message sitting over another commit's hunks)
  // would walk back in through the door D2 exists to close.
  const gd = toolResults["git-diff"];
  if (revisionRange === undefined && gd.tool === "git-diff" && gd.status === "ok") {
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
            // Names the one commit a scope claim may be made against. Only the
            // fallback sets it — the blob spans several commits, and without it the
            // reviewer has judged a top message against a lower commit's hunks.
            reviewSubject: fallback.reviewSubject,
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

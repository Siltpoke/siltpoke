// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { spawnWithTimeout } from "../critic/spawn";
import { recordSessionCommits, type WhyHost } from "../repo-graph/why-index";
import { readSessionBaseline } from "./session-baseline";

export interface MaybeRecordWhyInput {
  cwd: string; sessionId: string; transcriptPath: string; host: WhyHost; stopTime: string;
  runRevParse?: (cwd: string) => Promise<{ exitCode: number; stdout: string }>;
  runGit?: (argv: string[], cwd: string) => Promise<{ exitCode: number; stdout: string }>;
}

const defaultRevParse = async (cwd: string) => {
  const r = await spawnWithTimeout({ argv: ["git", "rev-parse", "HEAD"], cwd, timeoutMs: 5000 });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout };
};

export async function maybeRecordWhy(input: MaybeRecordWhyInput): Promise<void> {
  try {
    // Same root cause as the oracle's `no_baseline_sha`: this used to read the
    // single per-cwd slot and bail when the id differed, so a second concurrent
    // session silently switched WHY-recording off for the first one. The shared
    // reader looks up this session's own record — see session-baseline.ts.
    const b = readSessionBaseline(input.cwd, input.sessionId);
    if (b === null) return;
    // A LATE capture is HEAD partway through the session, not HEAD before it, so
    // `baselineSha..headSha` below would not be "what this session did". Skip it
    // — this keeps the behaviour identical to before `resolveOrCaptureSessionHeadSha`
    // existed, where such a session had no record at all and returned here. The
    // enqueue path wants a non-null sha and does not read its value; this path
    // reads the value and must refuse one it cannot interpret. Widening WHY
    // recording is a separate decision, not a side effect of fixing the oracle.
    if (b.late_capture) return;
    const head = await (input.runRevParse ?? defaultRevParse)(input.cwd);
    if (head.exitCode !== 0) return;
    const headSha = head.stdout.trim();
    if (!headSha || headSha === b.head_sha) return;                                     // no commits this session
    await recordSessionCommits({
      cwd: input.cwd, sessionId: input.sessionId, transcriptPath: input.transcriptPath, host: input.host,
      baselineSha: b.head_sha, capturedAt: b.captured_at, headSha, stopTime: input.stopTime, runGit: input.runGit,
    });
  } catch { /* never break Stop */ }
}

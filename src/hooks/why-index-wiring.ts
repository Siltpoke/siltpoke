// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { spawnWithTimeout } from "../critic/spawn";
import { recordSessionCommits, type WhyHost } from "../repo-graph/why-index";
import { readSessionBaseline } from "./session-baseline";

const TRANSCRIPT_DIR_HOST: Record<string, WhyHost> = {
  ".claude": "claude-code", ".codebuddy": "codebuddy", ".qoder": "qoder",
  ".codex": "codex", ".gemini": "antigravity",
};

/** Host that owns a transcript path, by its `~/.<host>/` path segment (POSIX or Windows separators). */
export function hostFromTranscriptPath(p: string | undefined): WhyHost | null {
  if (!p) return null;
  for (const seg of p.split(/[\\/]/)) {
    const h = TRANSCRIPT_DIR_HOST[seg];
    if (h) return h;
  }
  return null;
}

/**
 * Label for `why-index.json`'s `host`, decided per event. Order:
 *  1. the payload stamp (`event.siltpoke_host`) — set only by the agy / codex Stop normalizers;
 *  2. the event's own `transcript_path` (`~/.codebuddy/...` etc.) — correct even when the process
 *     env is wrong: source installs register on-stop.ts with no SILTPOKE_HOST, and the daemon
 *     route runs handleStopHook with the daemon's env, which may be stale or unset;
 *  3. `SILTPOKE_HOST` — exported by hooks/stop.sh and hook-guard for plugin installs of
 *     claude / qoder / codebuddy, and by the agy / codex wrappers; NOT set for source installs
 *     or the daemon route; env family "agy" maps to the label "antigravity";
 *  4. default "claude-code".
 * Before [57] only (1) was read, so codebuddy and qoder were labelled "claude-code".
 */
export function resolveWhyHost(siltpokeHost: string | undefined, envHost?: string, transcriptPath?: string): WhyHost {
  const fromStamp = siltpokeHost === "agy" || siltpokeHost === "antigravity" ? "antigravity"
    : siltpokeHost === "codex" ? "codex" : null;
  if (fromStamp) return fromStamp;
  const fromPath = hostFromTranscriptPath(transcriptPath);
  if (fromPath) return fromPath;
  if (envHost === "agy" || envHost === "antigravity") return "antigravity";
  if (envHost === "codex" || envHost === "codebuddy" || envHost === "qoder") return envHost;
  return "claude-code";
}

export interface MaybeRecordWhyInput {
  cwd: string; sessionId: string; transcriptPath: string; host: WhyHost; stopTime: string;
  runRevParse?: (cwd: string) => Promise<{ exitCode: number; stdout: string }>;
  runGit?: (argv: string[], cwd: string) => Promise<{ exitCode: number; stdout: string }>;
}

const defaultRevParse = async (cwd: string) => {
  const r = await spawnWithTimeout({ argv: ["git", "rev-parse", "HEAD"], cwd, timeoutMs: 5000 });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout };
};

/** The Stop-hook call site: label the host from the event (see resolveWhyHost), then record. */
export async function recordWhyForEvent(
  event: { cwd?: string; transcript_path?: string; siltpoke_host?: string },
  sessionId: string,
  env: NodeJS.ProcessEnv,
  seams?: Pick<MaybeRecordWhyInput, "runRevParse" | "runGit">,
): Promise<void> {
  if (!event.cwd) return;
  await maybeRecordWhy({
    cwd: event.cwd,
    sessionId,
    transcriptPath: event.transcript_path!,
    host: resolveWhyHost(event.siltpoke_host, env.SILTPOKE_HOST, event.transcript_path),
    stopTime: new Date().toISOString(),
    ...seams,
  });
}

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

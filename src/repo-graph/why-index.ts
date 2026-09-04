// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnWithTimeout } from "../critic/spawn";

export type WhyHost = "claude-code" | "codex" | "codebuddy" | "antigravity";
export interface WhyIndexSession { session_id: string; transcript_path: string; host: WhyHost; recorded_at: string }
export interface WhyIndex { [sha: string]: { sessions: WhyIndexSession[] } }
export type RunGit = (argv: string[], cwd: string) => Promise<{ exitCode: number; stdout: string }>;
export interface RecordInput {
  cwd: string; sessionId: string; transcriptPath: string; host: WhyHost;
  baselineSha: string; capturedAt: string; headSha: string; stopTime: string; runGit?: RunGit;
}

const GIT_TIMEOUT_MS = 5000;
function storePath(cwd: string): string { return join(cwd, ".siltpoke", "why-index.json"); }

// Atomic write (tmp file + rename) — mirrors src/repo-graph/store.ts's atomicWriteJson.
// A plain writeFile can be killed mid-write (OOM/SIGKILL, real on this machine with
// concurrent sessions), leaving a truncated/invalid file; readWhyIndex's catch-all then
// returns {} and the NEXT recordSessionCommits silently clobbers every prior sessions[]
// entry. rename() is atomic on the same filesystem, so readers only ever see whole-old
// or whole-new, never partial.
async function atomicWriteIndex(path: string, data: WhyIndex): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

export async function readWhyIndex(cwd: string): Promise<WhyIndex> {
  try {
    const parsed = JSON.parse(await readFile(storePath(cwd), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as WhyIndex) : {};
  } catch { return {}; }
}

const defaultRunGit: RunGit = async (argv, cwd) => {
  const r = await spawnWithTimeout({ argv: ["git", ...argv], cwd, timeoutMs: GIT_TIMEOUT_MS });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout };
};

export async function recordSessionCommits(input: RecordInput): Promise<void> {
  const runGit = input.runGit ?? defaultRunGit;
  // git log (NOT rev-list — rev-list has no --format/--no-commit-header). --no-merges:
  // a `git merge main` never claims WHY for unrelated upstream commits. One "sha iso" per line.
  const argv = ["log", "--no-merges", "--format=%H %cI", `${input.baselineSha}..${input.headSha}`];
  const { exitCode, stdout } = await runGit(argv, input.cwd);
  if (exitCode !== 0) return;                                   // any git failure ⇒ no write, never a wrong link
  const lo = Date.parse(input.capturedAt);
  const hi = Date.parse(input.stopTime);
  const idx = await readWhyIndex(input.cwd);
  for (const line of stdout.split("\n")) {
    const m = /^([0-9a-f]{40}) (\S+)$/.exec(line.trim());
    if (!m) continue;
    const sha = m[1]!;
    const t = Date.parse(m[2]!);
    if (Number.isNaN(t) || t < lo || t > hi) continue;         // committer-time window bound
    const entry = idx[sha] ?? { sessions: [] };
    if (!entry.sessions.some((s) => s.session_id === input.sessionId)) {
      entry.sessions.push({ session_id: input.sessionId, transcript_path: input.transcriptPath, host: input.host, recorded_at: input.stopTime });
    }
    idx[sha] = entry;
  }
  await mkdir(join(input.cwd, ".siltpoke"), { recursive: true });
  await atomicWriteIndex(storePath(input.cwd), idx);
}

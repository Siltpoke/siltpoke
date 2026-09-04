// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { spawnWithTimeout } from "../critic/spawn";

export interface BlameEntry { sha: string; committerDate: string }
export type BlameResult =
  | { kind: "commits"; entries: BlameEntry[] }
  | { kind: "uncommitted" }
  | { kind: "missing" }
  | { kind: "error"; detail: string };
export type RunGit = (argv: string[], cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export interface BlameInput { cwd: string; file: string; startLine?: number; endLine?: number; runGit?: RunGit }

const ZERO_SHA = "0000000000000000000000000000000000000000";
const GIT_TIMEOUT_MS = 5000;

const defaultRunGit: RunGit = async (argv, cwd) => {
  const r = await spawnWithTimeout({ argv: ["git", ...argv], cwd, timeoutMs: GIT_TIMEOUT_MS });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout, stderr: r.stderr };
};

export async function blameLines(input: BlameInput): Promise<BlameResult> {
  const runGit = input.runGit ?? defaultRunGit;
  const range = input.startLine !== undefined && input.endLine !== undefined ? ["-L", `${input.startLine},${input.endLine}`] : [];
  // -M / -C: attribute moved/copied lines to their original commit (survives renames-in-blame).
  const argv = ["blame", "--porcelain", "-M", "-C", ...range, "--", input.file];
  const { exitCode, stdout, stderr } = await runGit(argv, input.cwd);
  if (exitCode !== 0) {
    if (/no such path|does not exist|no such file/i.test(stderr)) return { kind: "missing" };
    return { kind: "error", detail: stderr.trim() || `git blame exit ${exitCode}` };
  }
  const entries: BlameEntry[] = [];
  const seen = new Set<string>();
  let curSha: string | null = null;
  let sawZero = false;
  for (const line of stdout.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(line);
    if (header) { curSha = header[1]!; if (curSha === ZERO_SHA) sawZero = true; continue; }
    const ct = /^committer-time (\d+)$/.exec(line);
    if (ct && curSha && curSha !== ZERO_SHA && !seen.has(curSha)) {
      seen.add(curSha);
      entries.push({ sha: curSha, committerDate: new Date(Number(ct[1]) * 1000).toISOString() });
    }
  }
  if (sawZero) return { kind: "uncommitted" };                                  // any uncommitted line ⇒ not one honest commit
  if (entries.length === 0) return { kind: "error", detail: "blame output parsed to zero commits" };
  return { kind: "commits", entries };
}

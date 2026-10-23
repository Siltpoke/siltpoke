// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

/**
 * The git top-level of `dir` (`git rev-parse --show-toplevel`, symlink-resolved by
 * git). `null` when `dir` is empty, not in a git repo, or `git` is missing — callers
 * fall back; this never throws. An empty `dir` is refused rather than spawned:
 * `cwd: ""` would run git in this process's own cwd and name the wrong repo.
 */
export async function gitRepoRoot(dir: string): Promise<string | null> {
  if (dir === "") return null;
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (proc.exitCode !== 0) return null;
    return out.trim();
  } catch {
    return null;
  }
}

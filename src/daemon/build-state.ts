// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Daemon build-state — boot SHA capture + staleness derivation.
 *
 * The $1.45 scenario: a 5h-stale daemon silently ran outdated code. This module
 * lets the daemon report which siltpoke SOURCE-repo commit it booted from and
 * how far behind current repo HEAD it is.
 *
 * Two layers:
 *   - Impure edge (captureBootBuild / makeGitProbe): shells to git, walks up to
 *     the nearest `.git`. NEVER throws — git absent / non-git / error → nulls.
 *   - Pure core (computeStaleness): given bootSha + headSha + an injected git
 *     probe, derives { headSha, commitsBehind, state }. Unit-tested without
 *     shelling. Never a misleading number — non-ancestor / null → "unknown".
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type DaemonState = "current" | "behind" | "unknown";

export interface BootBuild {
  bootSha: string | null;
  bootTime: string | null;
}

export interface Staleness {
  headSha: string | null;
  commitsBehind: number | null;
  state: DaemonState;
}

/**
 * Injected git seam for the pure derivation. Both methods return null on any
 * git error so the pure fn never has to know about shelling.
 */
export interface GitProbe {
  /** current siltpoke repo HEAD, or null on error. */
  headSha(): string | null;
  /** true iff `ancestor` is an ancestor of `descendant`; null on error. */
  isAncestor(ancestor: string, descendant: string): boolean | null;
  /** count of commits in `<from>..<to>`, or null on error. */
  countBetween(from: string, to: string): number | null;
}

/**
 * Pure staleness derivation. No shelling — the probe is injected.
 *
 *   bootSha === headSha            → commitsBehind 0,   state "current"
 *   bootSha ancestor of HEAD (N>0) → commitsBehind N,   state "behind"
 *   bootSha null / not ancestor /
 *     any probe error              → commitsBehind null, state "unknown"
 */
export function computeStaleness(
  bootSha: string | null,
  headSha: string | null,
  probe: GitProbe,
): Staleness {
  if (!bootSha || !headSha) {
    return { headSha, commitsBehind: null, state: "unknown" };
  }
  if (bootSha === headSha) {
    return { headSha, commitsBehind: 0, state: "current" };
  }
  const ancestor = probe.isAncestor(bootSha, headSha);
  if (ancestor !== true) {
    // not-ancestor (force-push / rebase) OR probe error → unknown, never a number.
    return { headSha, commitsBehind: null, state: "unknown" };
  }
  const count = probe.countBetween(bootSha, headSha);
  if (count === null || count <= 0) {
    return { headSha, commitsBehind: null, state: "unknown" };
  }
  return { headSha, commitsBehind: count, state: "behind" };
}

/**
 * Dashboard staleness-banner predicate. Pure —
 * mirrors `brainUnhealthySignal`'s `{ show, line }` shape so the SSR strip reads
 * the same way the brain-health strip does.
 *
 *   state "behind"  → show, "⚠ daemon N commits behind — restart to pick up changes"
 *   state "current" → no strip (no false nag on an up-to-date daemon)
 *   state "unknown" → no strip (the doctor check carries "unknown"; don't nag
 *                     installed-plugin users who have no advancing HEAD)
 *
 * Defensive: a "behind" state with a non-positive / null commitsBehind is an
 * inconsistent signal (the endpoint never emits it) → suppress rather than
 * render "N commits" with a bogus N.
 */
export interface StalenessSignal {
  show: boolean;
  /** One-liner for the strip, "" when show=false. */
  line: string;
}

export function stalenessBannerSignal(
  state: DaemonState,
  commitsBehind: number | null,
): StalenessSignal {
  if (state !== "behind") return { show: false, line: "" };
  if (commitsBehind === null || commitsBehind <= 0) {
    return { show: false, line: "" };
  }
  return {
    show: true,
    line: `⚠ daemon ${commitsBehind} commits behind — restart to pick up changes`,
  };
}

/** Walk up from a start dir to the nearest dir containing `.git`. null if none. */
export function findSourceRepoRoot(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function gitOut(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Impure boot capture. Resolves the siltpoke source repo from the module
 * location (NOT the user's cwd), reads HEAD SHA + committer time. Never throws.
 */
export function captureBootBuild(startDir: string = import.meta.dir): BootBuild {
  const repoRoot = findSourceRepoRoot(startDir);
  if (!repoRoot) return { bootSha: null, bootTime: null };
  const bootSha = gitOut(repoRoot, ["rev-parse", "HEAD"]);
  if (!bootSha) return { bootSha: null, bootTime: null };
  const bootTime = gitOut(repoRoot, ["log", "-1", "--format=%cI", "HEAD"]);
  return { bootSha, bootTime: bootTime || null };
}

/** Build a real git probe bound to the siltpoke source repo. */
export function makeGitProbe(startDir: string = import.meta.dir): GitProbe {
  const repoRoot = findSourceRepoRoot(startDir);
  return {
    headSha: () => (repoRoot ? gitOut(repoRoot, ["rev-parse", "HEAD"]) : null),
    isAncestor: (ancestor, descendant) => {
      if (!repoRoot) return null;
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
          cwd: repoRoot,
          stdio: "ignore",
        });
        return true;
      } catch (err) {
        // exit 1 = not an ancestor (a real answer); other exit = git error → null.
        const code = (err as { status?: number }).status;
        return code === 1 ? false : null;
      }
    },
    countBetween: (from, to) => {
      if (!repoRoot) return null;
      const out = gitOut(repoRoot, ["rev-list", "--count", `${from}..${to}`]);
      if (out === null) return null;
      const n = Number.parseInt(out, 10);
      return Number.isFinite(n) ? n : null;
    },
  };
}

// --- cached boot value (computed once at first read) -----------------------

let cachedBoot: BootBuild | null = null;

/** Cached boot build — captured once on first call, reused thereafter. */
export function readBootBuild(): BootBuild {
  if (cachedBoot === null) cachedBoot = captureBootBuild();
  return cachedBoot;
}

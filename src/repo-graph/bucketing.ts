// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Generic architecture bucketing primitive.
 *
 * Replaces the old depth-2 `fileToSubdir` + hardcoded well-known-root list
 * with ONE purely structural mechanism: branch-point descent + gap-descend.
 * Zero hardcoded directory / framework / repo names (red line, enforced by
 * the zero-name grep guard in `tests/repo-graph/bucketing.test.ts`).
 *
 * Algorithm:
 *   - Top-level namespaces (the immediate children of the repo root) are never
 *     useful containers on their own → always descend into each.
 *   - Within a subtree: compress single-child directory chains (radix-tree /
 *     IDE "compact middle packages").
 *   - At a branch point (>= 2 child directories): if the largest child holds
 *     more than `gapThreshold`x the files of the second-largest AND itself has
 *     deeper directories, it is a catch-all parent → recurse into it and keep
 *     the siblings whole. Otherwise every child is a container, whole.
 *   - A hard `depthCap` on path-segment count bounds recursion on any
 *     adversarial tree; a capped stop is recorded in `depthCapHits`.
 *
 * The gap threshold `8` and depth cap `16` are M1-measured structural choices
 * (gap sits in the empty zone (3, 19.9); cap = deepest real path x2 headroom),
 * NOT tuned constants — any threshold in [4, 18] yields byte-identical output.
 */

/** M1-locked gap threshold (largest/second-largest file count). */
export const DEFAULT_GAP_THRESHOLD = 8;

/** M1-locked hard recursion cap, measured in path segments. */
export const DEFAULT_DEPTH_CAP = 16;

export interface DeriveContainersOptions {
  /** Catch-all trigger: largest-child / second-largest-child file-count ratio. */
  gapThreshold?: number;
  /** Hard recursion bound (path-segment count). */
  depthCap?: number;
}

export interface DeriveContainersResult {
  /** Sorted container prefixes (each with a trailing slash). */
  containers: string[];
  /** Prefixes where the depth cap forced a stop (boundedness marker). */
  depthCapHits: string[];
}

/**
 * Map a file path to the DEEPEST container that prefixes it, or null when no
 * container contains it (a loose file at a namespace level — honestly has no
 * container, never force-bucketed). Containers carry a trailing slash, so the
 * prefix test is segment-safe (`src/web/` never swallows `src/website/x.ts`).
 */
export function containerForPath(
  filePath: string,
  containers: readonly string[],
): string | null {
  let best: string | null = null;
  for (const c of containers) {
    if (filePath.startsWith(c) && (best === null || c.length > best.length)) {
      best = c;
    }
  }
  return best;
}

/**
 * Immediate sub-directories of `prefix` ("" for the repo root), mapped to the
 * count of files anywhere beneath each. A path segment counts as a directory
 * iff a file sits deeper than it. No segment text is ever inspected.
 */
function childDirs(prefix: string, paths: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of paths) {
    if (prefix && !p.startsWith(prefix)) continue;
    const rest = prefix ? p.slice(prefix.length) : p;
    const slash = rest.indexOf("/");
    if (slash < 0) continue; // a file directly in `prefix`, not a sub-directory
    const dir = rest.slice(0, slash);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return counts;
}

/**
 * Derive architecture containers from a flat repo-relative file-path list.
 * Pure: depends only on path structure + file counts.
 */
export function deriveContainers(
  filePaths: string[],
  opts: DeriveContainersOptions = {},
): DeriveContainersResult {
  const gapThreshold = opts.gapThreshold ?? DEFAULT_GAP_THRESHOLD;
  const depthCap = opts.depthCap ?? DEFAULT_DEPTH_CAP;

  const containers: string[] = [];
  const depthCapHits: string[] = [];

  // Branch point (>= 2 child dirs): recurse into a dominant catch-all (and
  // keep the siblings whole), else every child is a container whole.
  const emitBranch = (
    prefix: string,
    depth: number,
    kids: Map<string, number>,
  ): void => {
    const sorted = [...kids.entries()].sort((a, b) => b[1] - a[1]);
    const [largest, second] = sorted;
    if (largest === undefined || second === undefined) return; // unreachable: size >= 2
    const dominantPrefix = `${prefix}${largest[0]}/`;
    const isCatchAll =
      largest[1] / second[1] > gapThreshold &&
      childDirs(dominantPrefix, filePaths).size >= 1;
    if (isCatchAll) {
      expand(dominantPrefix, depth + 1); // recurse into the catch-all
      for (const [dir] of sorted.slice(1)) containers.push(`${prefix}${dir}/`);
    } else {
      for (const [dir] of sorted) containers.push(`${prefix}${dir}/`);
    }
  };

  const expand = (prefix: string, depth: number): void => {
    if (depth >= depthCap) {
      containers.push(prefix);
      depthCapHits.push(prefix);
      return;
    }
    const kids = childDirs(prefix, filePaths);
    if (kids.size === 0) {
      containers.push(prefix); // leaf directory (only files beneath)
      return;
    }
    if (kids.size === 1) {
      const [only] = [...kids.keys()];
      if (only !== undefined) expand(`${prefix}${only}/`, depth + 1); // compress chain
      return;
    }
    emitBranch(prefix, depth, kids);
  };

  // Repo-root children are top-level namespaces → always descend into each.
  const rootKids = [...childDirs("", filePaths).entries()].sort(
    (a, b) => b[1] - a[1],
  );
  for (const [dir] of rootKids) expand(`${dir}/`, 1);

  containers.sort();
  return { containers, depthCapHits };
}

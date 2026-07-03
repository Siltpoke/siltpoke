// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * File-level drill label disambiguation.
 *
 * Within ONE drill scope (the files of a single container), give each file the
 * shortest trailing path suffix that makes its basename unambiguous. Files whose
 * basename is already unique render just the basename — no path noise. The rule
 * is purely structural: it keys on basename collision + path-segment comparison,
 * never on any framework or filename constant.
 */

/** Minimal shape needed for disambiguation (a subset of the renderer's FileRec). */
export interface LabelableFile {
  /** Basename, e.g. `page.tsx`. */
  name: string;
  /** Full path, e.g. `app/works/[id]/page.tsx`. Last segment === name. */
  path: string;
}

const segmentsOf = (p: string): string[] => p.split("/").filter(Boolean);

/**
 * Returns a display label per file, aligned to the input order.
 * - Unique basename → the basename verbatim (no added parent path).
 * - Colliding basename → the shortest trailing `k`-segment suffix (k ≥ 2) that
 *   is unique among the files sharing that basename. Each colliding file gets
 *   its own minimal depth, so `[id]/page.tsx` and `auth/page.tsx` can differ.
 */
export function shortestUniqueLabels(files: ReadonlyArray<LabelableFile>): string[] {
  const indicesByBase = new Map<string, number[]>();
  files.forEach((f, i) => {
    const arr = indicesByBase.get(f.name);
    if (arr) arr.push(i);
    else indicesByBase.set(f.name, [i]);
  });

  return files.map((f, i) => {
    const group = indicesByBase.get(f.name);
    if (!group || group.length === 1) return f.name; // unique → no path noise

    const segs = segmentsOf(f.path);
    const others = group.filter((j) => j !== i).map((j) => segmentsOf(files[j]!.path));
    // k = 1 is just the basename (known to collide). Grow the suffix until it is
    // unique against every same-basename sibling.
    for (let k = 2; k <= segs.length; k++) {
      const suffix = segs.slice(-k).join("/");
      const collides = others.some((o) => o.slice(-k).join("/") === suffix);
      if (!collides) return suffix;
    }
    return segs.join("/"); // identical paths (degenerate) → full path
  });
}

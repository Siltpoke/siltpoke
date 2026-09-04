// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Shared test double for `ImportersDeps`, used by every disk-awareness test
 * file (importers.test.ts, reverse-deps.test.ts, ...) so the fake stays a
 * single source of truth instead of drifting per-file.
 */
import { posix } from "node:path";
import type { ImportersDeps } from "../../../src/critic/disk-awareness/importers";

// The fake ripgrep returns EVERY line of EVERY file (honoring the queried basenames from args) —
// it must NOT pre-filter by import syntax, or importersOf's own IMPORT_LINE/extractSpec logic goes
// untested and a mutation dropping that filter survives (cross-family finding). importersOf does
// the filtering; the fake only mimics `rg -n`.
export const fakeDeps = (files: Record<string, string>): ImportersDeps => ({
  listFiles: () => Object.keys(files),
  // Backs the multi-line `import type` block filter (importers.ts's TYPE_ONLY_BLOCK) with
  // the SAME in-memory `files` map the fake ripgrep already reads — so a test can exercise
  // the real filtering logic (not the pre-fix over-count) without touching real disk.
  readFile: (file: string) => files[file] ?? "",
  ripgrep: (args: string[]) => {
    const wanted = args.filter((a) => !a.startsWith("-")); // basenames rg was asked to find
    const lines: string[] = [];
    for (const [p, c] of Object.entries(files)) {
      c.split("\n").forEach((line, i) => {
        if (wanted.length === 0 || wanted.some((w) => line.includes(w))) lines.push(`${p}:${i + 1}:${line}`);
      });
    }
    return { code: 0, stdout: lines.join("\n") };
  },
  // Real POSIX resolution against the file set — a wrong-normalization impl must not pass by luck.
  resolver: (src: string, rawTarget: string) => {
    if (!rawTarget.startsWith(".")) {
      const bare = rawTarget.endsWith(".ts") ? rawTarget : `${rawTarget}.ts`;
      return files[bare] !== undefined ? bare : null;
    }
    const joined = posix.normalize(posix.join(posix.dirname(src), rawTarget));
    const withExt = joined.endsWith(".ts") ? joined : `${joined}.ts`;
    return files[withExt] !== undefined
      ? withExt
      : files[`${joined}/index.ts`] !== undefined
        ? `${joined}/index.ts`
        : null;
  },
});

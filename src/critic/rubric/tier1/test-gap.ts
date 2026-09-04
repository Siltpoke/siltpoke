// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Tier-1 test-gap rubric — Slice ② (disk-level test-gap + new-vs-modified split).
 *
 * The pre-existing gate is unchanged: source file, `added > THRESHOLD_LINES`, no
 * in-diff matching test. What changes is the FIRE decision once that gate passes:
 * instead of always firing `med`, it now consults the disk (via Task 1's
 * `importersOf(..., { scope: "tests" })`) to ask whether a real, resolver-confirmed
 * test file imports this source — and whether the source itself is NEW or MODIFIED
 * (via a `git cat-file -e HEAD:<path>` probe).
 *
 *   NEW,      no disk test  -> fires med (real uncovered new file)
 *   NEW,      disk test     -> suppressed (a resolver-confirmed, runtime-importing disk
 *                               test resolves to this file — the substrate's
 *                               TYPE_ONLY_BLOCK filter (importers.ts) now also excludes a
 *                               multi-line `import type` block, so this is a real runtime
 *                               test, not a type-only decoy; see that filter's docblock
 *                               for the one narrow residual it doesn't defend against — a
 *                               same-spec double-import, one type-only one runtime, in a
 *                               single file)
 *   MODIFIED, no disk test  -> fires med (real gap, unchanged from before)
 *   MODIFIED, disk test     -> downgrade to a `low` note (can't prove the NEW lines
 *                               are covered by an untouched test, but a real test
 *                               exists — softer signal than a silent no-op or a full
 *                               med alarm)
 *   degraded lookup         -> FAIL-OPEN: abstain, no fire, no note. An IO/parse
 *                               failure on the disk check must never manufacture a
 *                               test-gap trigger.
 *
 * Fail-soft throughout: the disk lookup and the isNewFile probe are each wrapped so
 * a throw degrades gracefully (lookup -> degraded/abstain; isNewFile -> the MODIFIED
 * branch) rather than propagating. This rule never throws.
 *
 * Seams are rule-local (module-level `__setTestGapDeps`), NOT a change to the shared
 * `RubricInput` — other tier-1/tier-2 rules don't need disk awareness, and widening
 * the shared input type for one rule would leak this rule's plumbing everywhere.
 */
import { importersOf } from "../../disk-awareness/importers";
import type { ImportersResult } from "../../disk-awareness/importers";
import { canonicalPath } from "../../disk-awareness/path";
import type { RubricRule, RubricTrigger } from "../types";

const THRESHOLD_LINES = 30;
const TEST_PATTERN = /(\.test\.|\.spec\.|^tests?\/|\btest\/|\b__tests__\/)/i;

export interface TestGapDeps {
  importers?: typeof importersOf;
  /** default: `git cat-file -e HEAD:<canonicalPath(file)>` fails (exit !== 0) ⇒ new. */
  isNewFile?: (file: string, cwd: string) => boolean;
}

// Module-level, rule-local seam. Tests MUST reset via `__setTestGapDeps({})` in
// `afterEach` — this is a REPLACE, not a merge, so `{}` fully clears to production
// defaults for both `importers` and `isNewFile`.
let currentDeps: TestGapDeps = {};

export function __setTestGapDeps(d: TestGapDeps): void {
  currentDeps = d;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// "Absent from HEAD at this canonical path" — a back-slash path makes git exit 128
// (confirmed: `git cat-file -e 'HEAD:src\mod.ts'` fails even when `src/mod.ts` exists at
// HEAD) and would be misread as new, so this always canonicalizes first. (A leading `./`
// does NOT reproduce this on the git version tested here — git normalizes it internally —
// so the defense is specifically for back-slash/other non-canonical separators, not `./`.)
// `HEAD:<path>` resolves from the git ROOT, not cwd (fix C): in a subdirectory / monorepo cwd a
// committed file would be misread as NEW (git cat-file exits 128) and it would SUPPRESS instead of
// downgrading a modified file. `git rev-parse --show-prefix` returns cwd's path relative to the
// repo root (trailing slash, or empty at root); prepending it makes the lookup root-relative.
// Fail-soft: if --show-prefix fails, prefix falls back to "".
function gitShowPrefix(cwd: string): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--show-prefix"], { cwd });
  if ((proc.exitCode ?? 1) !== 0) return "";
  return proc.stdout.toString().trim();
}

function defaultIsNewFile(file: string, cwd: string): boolean {
  const prefix = gitShowPrefix(cwd);
  const proc = Bun.spawnSync(
    ["git", "cat-file", "-e", `HEAD:${prefix}${canonicalPath(file)}`],
    { cwd },
  );
  return (proc.exitCode ?? 1) !== 0;
}

function fireMed(src: string, added: number): RubricTrigger {
  return {
    rule_id: "test-gap",
    tier: 1,
    severity: "med",
    file: src,
    line: 1,
    snippet: `+${added} lines added to ${src}`,
    message: "no test in this diff and none on disk",
    suggested_fix: `Add a test in tests/ matching ${src.split("/").pop()}`,
  };
}

// Downgrade note: a disk test exists but wasn't touched this diff, so coverage of
// the NEW lines can't be proven — visible (RubricSeverity has no "info"), but not
// alarm-level since a real test for this file does exist.
function softNote(src: string, added: number): RubricTrigger {
  return {
    rule_id: "test-gap",
    tier: 1,
    severity: "low",
    file: src,
    line: 1,
    snippet: `+${added} lines added to ${src}`,
    message: `+${added} lines added to \`${src}\`; its disk test wasn't touched this diff — confirm the new code is covered.`,
    suggested_fix: `Touch the disk test for ${src.split("/").pop()} in this diff, or confirm existing coverage covers the new lines.`,
  };
}

export const testGapRule: RubricRule = {
  id: "test-gap",
  tier: 1,
  languages: ["*"],
  async run(input) {
    const t0 = performance.now();
    const triggers: RubricTrigger[] = [];
    const deps = currentDeps;

    const sourceFiles = new Set<string>();
    const testFiles = new Set<string>();
    const linesAddedPerFile = new Map<string, number>();

    for (const hunk of input.diffHunks) {
      const isTest = TEST_PATTERN.test(hunk.file);
      if (isTest) testFiles.add(hunk.file);
      else sourceFiles.add(hunk.file);
      linesAddedPerFile.set(hunk.file, (linesAddedPerFile.get(hunk.file) ?? 0) + hunk.addedLines.length);
    }

    for (const src of sourceFiles) {
      const added = linesAddedPerFile.get(src) ?? 0;
      if (added <= THRESHOLD_LINES) continue;

      const base = src.replace(/\.(tsx?|jsx?|py)$/, "");
      const hasMatchingTest = [...testFiles].some((t) => t.includes(base.split("/").pop() ?? ""));
      if (hasMatchingTest) continue; // covered in this diff already — unchanged gate

      // Disk-level check (Task 1 substrate). Wrapped fail-soft: a throw from the
      // injected (or production) importers lookup must never propagate — it folds
      // into the same degraded/abstain path as an explicit degraded:true result, and
      // so does an undefined `.get()` (a dep that never populated the canonical key).
      const diskRaw = safe(
        () =>
          (deps.importers ?? importersOf)([src], { cwd: input.cwd, scope: "tests" }).get(canonicalPath(src)),
        undefined,
      );
      const disk: ImportersResult = (await diskRaw) ?? { importers: [], truncated: false, degraded: true };
      if (disk.degraded) continue; // FAIL-OPEN: abstain, never fire off a failed lookup

      const hasDiskTest = disk.importers.length > 0;
      // Fail-soft: a throw from isNewFile is treated as "modified" (never propagates,
      // never misread as new).
      const isNew = safe(() => (deps.isNewFile ?? defaultIsNewFile)(src, input.cwd), false);

      if (isNew) {
        if (!hasDiskTest) triggers.push(fireMed(src, added)); // real uncovered new file
        // else: a real disk test resolves to this new file — suppress
      } else {
        if (hasDiskTest) triggers.push(softNote(src, added)); // downgrade — can't prove NEW lines covered
        else triggers.push(fireMed(src, added)); // real gap
      }
    }

    return { rule_id: "test-gap", triggers, duration_ms: performance.now() - t0 };
  },
};

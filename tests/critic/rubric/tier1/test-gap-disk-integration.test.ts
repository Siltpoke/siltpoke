// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Task 4 (Slice ②): disk-level test-gap — new-vs-modified split.
 *
 * Real-git / real-ripgrep production-path fixtures, split out of
 * `test-gap-disk.test.ts` to stay under the 400 LOC cap. The mocked
 * control-matrix + resolver-confirmation tests live in that companion file.
 *
 * Per .superpowers/sdd/2026-07-25-critic-disk-awareness/task-4-brief.md.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setTestGapDeps, testGapRule } from "../../../../src/critic/rubric/tier1/test-gap";
import { getRgBin } from "../../../../src/critic/tools/rg-bin";

// MANDATORY — module-level seam leaks between tests otherwise (cross-family finding).
afterEach(() => __setTestGapDeps({}));

// rg-availability (cross-family finding): a skip-on-missing-rg test can silently pass
// forever while production rg is broken. Detect real rg presence ONCE; if rg is present but
// the real call errors on a valid fixture, that's a genuine production break and must FAIL.
function isRgAvailable(): boolean {
  try {
    const probe = Bun.spawnSync([getRgBin(), "--version"]);
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}
const rgAvailable = isRgAvailable();

function git(dir: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd: dir });
  if ((proc.exitCode ?? 1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

function mkGitRepo(committed: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-test-gap-disk-"));
  for (const [rel, content] of Object.entries(committed)) {
    const full = join(dir, rel);
    mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    writeFileSync(full, content);
  }
  git(dir, ["init", "-q"]);
  git(dir, ["-c", "user.email=test@test.com", "-c", "user.name=test", "add", "-A"]);
  git(dir, ["-c", "user.email=test@test.com", "-c", "user.name=test", "commit", "-q", "-m", "initial"]);
  return dir;
}

describe("test-gap — production-path fixture (real files + real rg + real resolver)", () => {
  it.skipIf(!rgAvailable)(
    "[production-path] modified src/mod.ts with a real tests/mod.test.ts on disk (not in diff) → downgrade note",
    async () => {
      const dir = mkGitRepo({ "src/mod.ts": "export const x = 1;\n" });
      try {
        mkdirSync(join(dir, "tests"), { recursive: true });
        writeFileSync(join(dir, "tests", "mod.test.ts"), "import { x } from '../src/mod';\n");

        __setTestGapDeps({}); // real seams
        const result = await testGapRule.run({
          cwd: dir,
          changedFiles: [join(dir, "src/mod.ts")],
          diffHunks: [{ file: "src/mod.ts", addedLines: Array.from({ length: 40 }, (_, i) => i + 1) }],
        });
        expect(result.triggers).toHaveLength(1);
        expect(result.triggers[0]?.severity).toBe("low");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!rgAvailable)(
    "[production-path] modified src/mod.ts with the ONLY test under tests/helpers/ → fires (helpers excluded by scope:'tests')",
    async () => {
      const dir = mkGitRepo({ "src/mod.ts": "export const x = 1;\n" });
      try {
        mkdirSync(join(dir, "tests", "helpers"), { recursive: true });
        writeFileSync(join(dir, "tests", "helpers", "mod-helper.ts"), "import { x } from '../../src/mod';\n");

        __setTestGapDeps({}); // real seams
        const result = await testGapRule.run({
          cwd: dir,
          changedFiles: [join(dir, "src/mod.ts")],
          diffHunks: [{ file: "src/mod.ts", addedLines: Array.from({ length: 40 }, (_, i) => i + 1) }],
        });
        expect(result.triggers).toHaveLength(1);
        expect(result.triggers[0]?.severity).toBe("med");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!rgAvailable)(
    "[production-path] NEW file (absent from HEAD) with no disk test → fires (med), real git+rg",
    async () => {
      const dir = mkGitRepo({ "README.md": "seed\n" }); // seed commit, src/new.ts never committed
      try {
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "new.ts"), "export const y = 2;\n");

        __setTestGapDeps({});
        const result = await testGapRule.run({
          cwd: dir,
          changedFiles: [join(dir, "src/new.ts")],
          diffHunks: [{ file: "src/new.ts", addedLines: Array.from({ length: 40 }, (_, i) => i + 1) }],
        });
        expect(result.triggers).toHaveLength(1);
        expect(result.triggers[0]?.severity).toBe("med");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // --- Finding 1 (review follow-up): the flagship NEW-file case, real substrate ---------
  //
  // Prior to the importers.ts TYPE_ONLY_BLOCK fix, a NEW untested source file whose ONLY
  // test-dir reference was a multi-line `import type {...} from '<source>'` block (type-
  // only, zero runtime) was SILENTLY SUPPRESSED: the substrate over-counted the block as a
  // runtime importer -> hasDiskTest=true on the NEW branch -> suppress -> triggers: []. That
  // defeated the rule's flagship "NEW + uncovered -> must fire" case. This fixture drives
  // the REAL substrate (no mocked importers/isNewFile) end-to-end to prove it now fires.
  it.skipIf(!rgAvailable)(
    "[production-path] NEW file whose ONLY test-dir reference is a multi-line `import type` block → FIRES (med), not silently suppressed",
    async () => {
      const dir = mkGitRepo({ "README.md": "seed\n" }); // src/new.ts never committed -> NEW
      try {
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "new.ts"), "export interface Y { a: number }\n");
        mkdirSync(join(dir, "tests"), { recursive: true });
        // Type-only, multi-line — zero runtime coverage of src/new.ts.
        writeFileSync(
          join(dir, "tests", "new-type-only.test.ts"),
          'import type {\n  Y,\n} from "../src/new";\n\nconst y: Y = { a: 1 };\n',
        );

        __setTestGapDeps({}); // real seams — the whole point of this fixture
        const result = await testGapRule.run({
          cwd: dir,
          changedFiles: [join(dir, "src/new.ts")],
          diffHunks: [{ file: "src/new.ts", addedLines: Array.from({ length: 40 }, (_, i) => i + 1) }],
        });
        expect(result.triggers).toHaveLength(1);
        expect(result.triggers[0]?.severity).toBe("med");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // --- Finding 2 (review follow-up): defaultIsNewFile's un-mocked decision path ---------
  //
  // defaultIsNewFile is what decides suppress-vs-downgrade in PRODUCTION. The two normal
  // cases (modified-with-real-test, new-absent-from-HEAD) are already covered above; these
  // three exercise the defended EDGES via the real, un-mocked `git cat-file` route.

  it.skipIf(!rgAvailable)(
    "[production-path] first-commit repo (no HEAD yet) → treated as new (documented, acceptable)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "siltpoke-test-gap-disk-"));
      try {
        // git init, but NO commit -> HEAD does not resolve yet.
        git(dir, ["init", "-q"]);
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "fresh.ts"), "export const z = 3;\n");

        __setTestGapDeps({});
        const result = await testGapRule.run({
          cwd: dir,
          changedFiles: [join(dir, "src/fresh.ts")],
          diffHunks: [{ file: "src/fresh.ts", addedLines: Array.from({ length: 40 }, (_, i) => i + 1) }],
        });
        // `git cat-file -e HEAD:...` fails when there's no HEAD at all -> isNewFile=true.
        // No disk test either -> fires med. Documents the accepted "first commit = new"
        // behavior rather than degrading or throwing.
        expect(result.triggers).toHaveLength(1);
        expect(result.triggers[0]?.severity).toBe("med");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!rgAvailable)(
    "[production-path] a renamed path (never committed under its new name) → treated as new (documented behavior)",
    async () => {
      const dir = mkGitRepo({ "src/old.ts": "export const w = 4;\n" }); // committed under the OLD name
      try {
        // Simulate the rename by writing content under a NEW path that git has never seen —
        // defaultIsNewFile only ever sees the path string, not file history/similarity, so
        // this is indistinguishable from a brand-new file to it. Documenting the behavior,
        // not asserting it's semantically ideal for a pure rename.
        writeFileSync(join(dir, "src", "renamed.ts"), "export const w = 4;\n");

        __setTestGapDeps({});
        const result = await testGapRule.run({
          cwd: dir,
          changedFiles: [join(dir, "src/renamed.ts")],
          diffHunks: [{ file: "src/renamed.ts", addedLines: Array.from({ length: 40 }, (_, i) => i + 1) }],
        });
        expect(result.triggers).toHaveLength(1);
        expect(result.triggers[0]?.severity).toBe("med");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!rgAvailable)(
    "[production-path] a back-slash (non-canonical) diff path still resolves against HEAD correctly → downgrade, not misclassified as new",
    async () => {
      // Proves canonicalPath()'s defense inside defaultIsNewFile actually matters: without
      // it, `git cat-file -e 'HEAD:src\mod.ts'` exits 128 (confirmed on this git version —
      // NOT the `./`-prefix case, which this git version normalizes fine) and the file would
      // be misread as NEW, wrongly suppressing instead of downgrading. See the mutation
      // check right below this fixture.
      const dir = mkGitRepo({ "src/mod.ts": "export const x = 1;\n" });
      try {
        mkdirSync(join(dir, "tests"), { recursive: true });
        writeFileSync(join(dir, "tests", "mod.test.ts"), "import { x } from '../src/mod';\n");

        __setTestGapDeps({});
        const result = await testGapRule.run({
          cwd: dir,
          changedFiles: [join(dir, "src/mod.ts")],
          diffHunks: [{ file: "src\\mod.ts", addedLines: Array.from({ length: 40 }, (_, i) => i + 1) }],
        });
        expect(result.triggers).toHaveLength(1);
        expect(result.triggers[0]?.severity).toBe("low"); // MODIFIED (correct) + disk test -> downgrade
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // --- Round 2 review follow-up: same-spec type+runtime double-import must not false-fire --
  //
  // Round 1's TYPE_ONLY_BLOCK fix dropped ALL hits for a (file, spec) pair once ANY type-only
  // import of that spec existed in the file — including a genuine runtime import of the same
  // spec elsewhere in the file. Real-world pattern (tests/memory/consolidate.test.ts:8-9,
  // ~6.3% of test files at authoring time):
  //   import { consolidate, other } from '../src/consolidate';   <- runtime
  //   import type { ConsolidateOpts } from '../src/consolidate'; <- type-only, same spec
  // This silently dropped the runtime importer, making ② FALSE-FIRE test-gap on a file that
  // genuinely IS tested — safe direction (over-fire, not silent-suppress) but common enough
  // to corrode trust. This fixture uses the exact real shape as its content.
  it.skipIf(!rgAvailable)(
    "[production-path] a disk test importing the SAME spec both type-only and at runtime → still counts as a real test (downgrade, not a false med fire)",
    async () => {
      const dir = mkGitRepo({
        "src/consolidate.ts": "export const consolidate = 1; export interface ConsolidateOpts { a: number }\n",
      });
      try {
        mkdirSync(join(dir, "tests"), { recursive: true });
        writeFileSync(
          join(dir, "tests", "consolidate.test.ts"),
          'import { consolidate } from "../src/consolidate";\n' +
            'import type { ConsolidateOpts } from "../src/consolidate";\n',
        );

        __setTestGapDeps({}); // real seams
        const result = await testGapRule.run({
          cwd: dir,
          changedFiles: [join(dir, "src/consolidate.ts")],
          diffHunks: [{ file: "src/consolidate.ts", addedLines: Array.from({ length: 40 }, (_, i) => i + 1) }],
        });
        // Correct: MODIFIED + a real (runtime-confirmed) disk test -> downgrade. A regression
        // to round-1's bug would drop the runtime hit entirely -> hasDiskTest=false -> a
        // spurious med fire on an actually-tested file.
        expect(result.triggers).toHaveLength(1);
        expect(result.triggers[0]?.severity).toBe("low");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

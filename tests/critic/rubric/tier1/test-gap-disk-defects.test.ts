// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Cross-family review follow-up (final fix wave) — rule-level production-path
 * fixtures (real git + real ripgrep + real resolver) for:
 *   C — defaultIsNewFile must resolve HEAD:<path> from the git ROOT, not cwd
 *       (subdirectory / monorepo cwd) so a committed file isn't misread as NEW.
 *   B — a NEW file whose ONLY disk reference is an inline `import { type X }`
 *       (TS 4.5) must still FIRE (type-only ≠ coverage); a MIXED import counts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setTestGapDeps, testGapRule } from "../../../../src/critic/rubric/tier1/test-gap";
import { getRgBin } from "../../../../src/critic/tools/rg-bin";

afterEach(() => __setTestGapDeps({}));

function isRgAvailable(): boolean {
  try {
    return Bun.spawnSync([getRgBin(), "--version"]).exitCode === 0;
  } catch {
    return false;
  }
}
const rgAvailable = isRgAvailable();

function git(dir: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd: dir });
  if ((proc.exitCode ?? 1) !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
}

function mkGitRepo(committed: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-test-gap-defect-"));
  for (const [rel, content] of Object.entries(committed)) {
    const full = join(dir, rel);
    mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    writeFileSync(full, content);
  }
  git(dir, ["init", "-q"]);
  git(dir, ["-c", "user.email=t@t.com", "-c", "user.name=t", "add", "-A"]);
  git(dir, ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "initial"]);
  return dir;
}

const bigHunk = (file: string) => [{ file, addedLines: Array.from({ length: 40 }, (_, i) => i + 1) }];

describe("test-gap — fix C: subdirectory cwd (HEAD:<path> is root-relative)", () => {
  it.skipIf(!rgAvailable)(
    "[production-path] a committed file, cwd = a SUBDIRECTORY → classified MODIFIED (downgrade), not NEW (suppress)",
    async () => {
      // `sub/mod.ts` + its disk test are BOTH committed. With cwd = <repo>/sub and the diff hunk
      // path `mod.ts`, `defaultIsNewFile` must prepend `git rev-parse --show-prefix` (= "sub/")
      // so `git cat-file -e HEAD:sub/mod.ts` succeeds → MODIFIED → downgrade (low). Mutation:
      // drop the --show-prefix prefixing → `HEAD:mod.ts` resolves from root → exit 128 → misread
      // as NEW → NEW+disk-test suppresses → 0 triggers → RED.
      const dir = mkGitRepo({
        "sub/mod.ts": "export const x = 1;\n",
        "sub/mod.test.ts": "import { x } from './mod';\n",
      });
      try {
        __setTestGapDeps({}); // real seams
        const result = await testGapRule.run({
          cwd: join(dir, "sub"),
          changedFiles: [join(dir, "sub/mod.ts")],
          diffHunks: bigHunk("mod.ts"),
        });
        expect(result.triggers).toHaveLength(1);
        expect(result.triggers[0]?.severity).toBe("low");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("test-gap — fix B: inline `import { type X }` on the NEW-file path", () => {
  it.skipIf(!rgAvailable)(
    "[production-path] NEW file whose ONLY disk reference is `import { type Foo } from '<src>'` → FIRES (med), not suppressed",
    async () => {
      // The cardinal case: a NEW source file's only test-dir reference is a pure inline-type
      // import (zero runtime). It must NOT be treated as covered. Mutation: drop the
      // isAllInlineTypeLine guard in importers.ts → the import counts as runtime → hasDiskTest
      // → suppressed → 0 triggers → RED.
      const dir = mkGitRepo({ "README.md": "seed\n" }); // src/new.ts never committed → NEW
      try {
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "new.ts"), "export interface Foo { a: number }\n");
        mkdirSync(join(dir, "tests"), { recursive: true });
        writeFileSync(
          join(dir, "tests", "new-inline-type.test.ts"),
          'import { type Foo } from "../src/new";\n\nconst f: Foo = { a: 1 };\n',
        );
        __setTestGapDeps({});
        const result = await testGapRule.run({
          cwd: dir,
          changedFiles: [join(dir, "src/new.ts")],
          diffHunks: bigHunk("src/new.ts"),
        });
        expect(result.triggers).toHaveLength(1);
        expect(result.triggers[0]?.severity).toBe("med");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!rgAvailable)(
    "[production-path] NEW file whose disk reference is a MIXED `import { type A, real } from '<src>'` → counts as a real test → SUPPRESSED",
    async () => {
      // A mixed import keeps a runtime binding, so it IS a real runtime importer — a NEW file
      // covered by it is (correctly) suppressed. Guards against over-excluding mixed imports.
      const dir = mkGitRepo({ "README.md": "seed\n" });
      try {
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "new.ts"), "export const real = 1; export interface A { a: number }\n");
        mkdirSync(join(dir, "tests"), { recursive: true });
        writeFileSync(
          join(dir, "tests", "new-mixed.test.ts"),
          'import { type A, real } from "../src/new";\n\nreal;\nconst a: A = { a: 1 };\n',
        );
        __setTestGapDeps({});
        const result = await testGapRule.run({
          cwd: dir,
          changedFiles: [join(dir, "src/new.ts")],
          diffHunks: bigHunk("src/new.ts"),
        });
        expect(result.triggers).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

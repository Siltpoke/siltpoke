// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Cross-family review follow-up (final fix wave): substrate defects in
 * `importers.ts` that the same-family review missed. One block per fix:
 *   A — test-dir spelling (__tests__ / singular test/ helpers)
 *   B — inline `import { type X }` (TS 4.5) type-only detection
 *   D — ripgrep basename treated as a literal, not a regex
 *   E — two fail-OPEN holes (listFiles + resolver infra failure -> degrade)
 *   G — IMPORT_LINE closing-brace alt must match a trailing-specifier line
 *
 * Each `it` is written so the named mutation (reverting the specific fix) turns
 * it RED. FIX C lives in the rule (test-gap.ts) and is covered by the
 * production-path git fixtures in tests/critic/rubric/tier1.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { importersOf } from "../../../src/critic/disk-awareness/importers";
import { getRgBin } from "../../../src/critic/tools/rg-bin";
import { fakeDeps } from "./fixtures";

// ---------------------------------------------------------------------------
// FIX A — every accepted test-dir spelling recognized consistently.
// ---------------------------------------------------------------------------
describe("importersOf — fix A: test-dir spelling parity", () => {
  it("KEEPS a `__tests__/`-only importer (source IS tested → no substrate false-fire)", () => {
    // src/pay/__tests__/foo-check.ts has NO `.test.`/`.spec.` in its name — it is a test
    // ONLY by virtue of the `__tests__/` dir. Without TEST_GLOB recognizing `__tests__/`,
    // scope:"tests" drops it, the source looks untested, and ② false-fires. Mutation: revert
    // TEST_GLOB (drop the `__tests__` alt) → this importer vanishes → RED.
    const files = {
      "src/pay/charge.ts": "export const c = 1;",
      "src/pay/__tests__/foo-check.ts": "import { c } from '../charge';",
    };
    const res = importersOf(["src/pay/charge.ts"], { cwd: "/r", scope: "tests", deps: fakeDeps(files) });
    expect(res.get("src/pay/charge.ts")!.importers).toContain("src/pay/__tests__/foo-check.ts");
  });

  it("EXCLUDES a singular `test/helpers/` importer (helper, not a real test → still fires on an untested file)", () => {
    // `test/helpers/build.ts` (SINGULAR `test/`) matches TEST_GLOB via `tests?/`, but the old
    // NON_TEST_DIR only excluded `tests/helpers` (plural). Counting a helper as a real test
    // SUPPRESSES a genuinely-untested new file — the cardinal false-negative. Mutation: revert
    // NON_TEST_DIR (plural-only) → this helper counts as a test → RED.
    const files = {
      "src/pay/charge.ts": "export const c = 1;",
      "test/helpers/build.ts": "import { c } from '../../src/pay/charge';",
    };
    const res = importersOf(["src/pay/charge.ts"], { cwd: "/r", scope: "tests", deps: fakeDeps(files) });
    expect(res.get("src/pay/charge.ts")!.importers).not.toContain("test/helpers/build.ts");
  });
});

// ---------------------------------------------------------------------------
// FIX B — inline `import { type X }` (TS 4.5) is type-only, not runtime.
// ---------------------------------------------------------------------------
describe("importersOf — fix B: inline type specifiers", () => {
  it("EXCLUDES an all-inline-type single-line import `import { type Foo } from '<spec>'`", () => {
    // Pure type-only coverage — must NOT count as a runtime importer. Mutation: drop the
    // isAllInlineTypeLine guard in isRealHit → wrongly counted → RED.
    const files = { "src/a/foo.ts": "export interface Foo { a: number }", "src/c.ts": "import { type Foo } from './a/foo';" };
    const res = importersOf(["src/a/foo.ts"], { cwd: "/r", scope: "imports", deps: fakeDeps(files) });
    expect(res.get("src/a/foo.ts")!.importers).not.toContain("src/c.ts");
  });

  it("KEEPS a MIXED single-line import `import { type A, b } from '<spec>'` (runtime binding present)", () => {
    // A runtime specifier `b` makes this a real runtime importer — must NOT be over-excluded.
    const files = { "src/a/foo.ts": "export const b = 1;", "src/c.ts": "import { type A, b } from './a/foo';" };
    const res = importersOf(["src/a/foo.ts"], { cwd: "/r", scope: "imports", deps: fakeDeps(files) });
    expect(res.get("src/a/foo.ts")!.importers).toContain("src/c.ts");
  });

  it("EXCLUDES an all-inline-type MULTI-LINE block `import {\\n type X,\\n} from '<spec>'`", () => {
    // rg sees only the closing `} from` line; the all-type block is detected against the file's
    // FULL TEXT via INLINE_NAMED_BLOCK. Mutation: drop the INLINE_NAMED_BLOCK clause in
    // typeOnlySpecsIn → the closing-brace hit is no longer filtered → wrongly counted → RED.
    const files = { "src/a/foo.ts": "export interface X { a: number }", "src/c.ts": 'import {\n  type X,\n  type Y,\n} from "./a/foo";' };
    const res = importersOf(["src/a/foo.ts"], { cwd: "/r", scope: "imports", deps: fakeDeps(files) });
    expect(res.get("src/a/foo.ts")!.importers).not.toContain("src/c.ts");
  });

  it("KEEPS a MIXED multi-line import (a type-only specifier alongside a runtime one)", () => {
    const files = { "src/a/foo.ts": "export const b = 1;", "src/c.ts": 'import {\n  type A,\n  b,\n} from "./a/foo";' };
    const res = importersOf(["src/a/foo.ts"], { cwd: "/r", scope: "imports", deps: fakeDeps(files) });
    expect(res.get("src/a/foo.ts")!.importers).toContain("src/c.ts");
  });
});

// ---------------------------------------------------------------------------
// FIX E — infra failure must degrade (fail-OPEN), never fire off a broken index.
// ---------------------------------------------------------------------------
describe("importersOf — fix E: fail-open on infra failure", () => {
  it("throwing listFiles (with working ripgrep) → ALL results degraded", () => {
    const files = { "src/a.ts": "export const x = 1;", "src/c.ts": "import { x } from './a';" };
    const deps = { ...fakeDeps(files), listFiles: () => { throw new Error("rg --files exploded"); } };
    const res = importersOf(["src/a.ts"], { cwd: "/r", scope: "imports", deps });
    expect(res.get("src/a.ts")!.degraded).toBe(true);
  });

  it("empty listFiles index for a NON-empty changed set → degraded (unusable index)", () => {
    const files = { "src/a.ts": "export const x = 1;", "src/c.ts": "import { x } from './a';" };
    const deps = { ...fakeDeps(files), listFiles: () => [] as string[] };
    const res = importersOf(["src/a.ts"], { cwd: "/r", scope: "imports", deps });
    expect(res.get("src/a.ts")!.degraded).toBe(true);
  });

  it("throwing resolver → the affected file's result degraded (not a silent candidate drop)", () => {
    // A real candidate exists (src/c.ts), so the resolver IS invoked; its throw must degrade,
    // not be swallowed to `null` and dropped. Mutation: revert to `safe(..., null)` → degraded
    // stays false and importers is [] → ② would fire off a failed resolver → RED.
    const files = { "src/a.ts": "export const x = 1;", "src/c.ts": "import { x } from './a';" };
    const deps = { ...fakeDeps(files), resolver: () => { throw new Error("resolver exploded"); } };
    const res = importersOf(["src/a.ts"], { cwd: "/r", scope: "imports", deps });
    expect(res.get("src/a.ts")!.degraded).toBe(true);
  });

  it("rg exit code 1 (no matches) is NOT degraded — empty is a valid answer", () => {
    // Preserve the existing contract: only rg exit > 1 / a throw degrades.
    const deps = {
      listFiles: () => ["src/a.ts"],
      ripgrep: () => ({ code: 1, stdout: "" }),
    };
    const res = importersOf(["src/a.ts"], { cwd: "/r", scope: "imports", deps });
    expect(res.get("src/a.ts")!.degraded).toBe(false);
    expect(res.get("src/a.ts")!.importers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FIX G — closing-brace alt must match a trailing-specifier closing line.
// ---------------------------------------------------------------------------
describe("importersOf — fix G: trailing-specifier closing line", () => {
  it("finds an importer whose closing line is `  baz } from '<spec>'` (last specifier before the brace)", () => {
    // Biome sometimes emits the last specifier on the closing-brace line. rg returns ONLY that
    // line (it holds the basename). The old `^\s*\}\s*from` anchor missed it → dropped importer.
    // Mutation: restore the `^` anchor on IMPORT_LINE's closing alt → RED.
    const files = { "src/mod.ts": "export const x = 1;", "src/c.ts": 'import {\n  foo,\n  bar,\n  baz } from "./mod";' };
    const res = importersOf(["src/mod.ts"], { cwd: "/r", scope: "imports", deps: fakeDeps(files) });
    expect(res.get("src/mod.ts")!.importers).toContain("src/c.ts");
  });
});

// ---------------------------------------------------------------------------
// FIX D — ripgrep basename matched literally (production path, real rg).
// ---------------------------------------------------------------------------
function isRgAvailable(): boolean {
  try {
    return Bun.spawnSync([getRgBin(), "--version"]).exitCode === 0;
  } catch {
    return false;
  }
}
const rgAvailable = isRgAvailable();

function mkdtempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-importers-defect-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("importersOf — fix D: metachar basenames matched literally (real rg)", () => {
  it.skipIf(!rgAvailable)(
    "[production-path] finds importers of `src/[id].ts` AND `src/foo+bar.ts` via --fixed-strings",
    () => {
      // `foo+bar` as a REGEX means `fo` + one-or-more `o` + `bar` = `foobar` — it would MISS the
      // literal `foo+bar` importer line entirely. `[id]` as a regex is a char class. Both are
      // matched literally only with -F. Mutation: remove --fixed-strings → the foo+bar importer
      // is missed → RED.
      const dir = mkdtempRepo({
        "src/[id].ts": "export const a = 1;\n",
        "src/foo+bar.ts": "export const b = 2;\n",
        "src/consume-id.ts": "import { a } from './[id]';\n",
        "src/consume-plus.ts": "import { b } from './foo+bar';\n",
      });
      try {
        const idRes = importersOf(["src/[id].ts"], { cwd: dir, scope: "imports" });
        const plusRes = importersOf(["src/foo+bar.ts"], { cwd: dir, scope: "imports" });
        expect(idRes.get("src/[id].ts")!.importers).toContain("src/consume-id.ts");
        expect(plusRes.get("src/foo+bar.ts")!.importers).toContain("src/consume-plus.ts");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

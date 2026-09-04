// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  importersOf,
  MAX_CANDIDATES,
  MAX_RESULTS,
  rgArgs,
} from "../../../src/critic/disk-awareness/importers";
import { getRgBin } from "../../../src/critic/tools/rg-bin";
import { fakeDeps } from "./fixtures";

describe("importersOf — resolver confirmation", () => {
  it("keeps only importers that resolve to the changed file, dropping same-basename decoys", () => {
    const files = {
      "src/a/foo.ts": "export const x = 1;", // changed file
      "src/b/foo.ts": "export const y = 2;", // DECOY same basename, different dir
      "src/consumer.ts": "import { x } from './a/foo';", // real importer of src/a/foo.ts
      "src/decoy-consumer.ts": "import { y } from './b/foo';", // imports the DECOY, not our file
    };
    const res = importersOf(["src/a/foo.ts"], { cwd: "/repo", scope: "imports", deps: fakeDeps(files) });
    expect(res.get("src/a/foo.ts")!.importers).toEqual(["src/consumer.ts"]);
  });
});

describe("importersOf — substrate behavior", () => {
  it("excludes a bare string-literal path (snapshot data), not an import", () => {
    const files = {
      "src/pay/refund.ts": "export const r = 1;",
      "tests/snap.test.ts": "const p = 'src/pay/refund.ts'; // string, not an import",
    };
    const res = importersOf(["src/pay/refund.ts"], { cwd: "/r", scope: "tests", deps: fakeDeps(files) });
    expect(res.get("src/pay/refund.ts")!.importers).toEqual([]);
  });

  it("marks degraded when ripgrep fails, never throws, returns empty importers", () => {
    const throwing = {
      ripgrep: () => {
        throw new Error("rg missing");
      },
      listFiles: () => [],
    };
    const res = importersOf(["src/a.ts"], { cwd: "/r", scope: "imports", deps: throwing });
    expect(res.get("src/a.ts")).toEqual({ importers: [], truncated: false, degraded: true });
  });

  it("sets truncated when candidates exceed MAX_CANDIDATES", () => {
    const files: Record<string, string> = { "src/types.ts": "export type T = 1;" };
    for (let i = 0; i < MAX_CANDIDATES + 5; i++) files[`src/c${i}.ts`] = "import './types';";
    const res = importersOf(["src/types.ts"], { cwd: "/r", scope: "imports", deps: fakeDeps(files) });
    expect(res.get("src/types.ts")!.truncated).toBe(true);
  });

  it("caps confirmed importers at MAX_RESULTS even when candidates stay under MAX_CANDIDATES", () => {
    // Isolates the MAX_RESULTS break (~importers.ts:234-237) from the MAX_CANDIDATES cap
    // (~importers.ts:225-228): 25 candidates is well under MAX_CANDIDATES(60), so the
    // candidate-cap branch never fires here — only the confirmed-importer-count break can
    // be responsible for stopping at 20. The pre-existing MAX_CANDIDATES test used 65
    // candidates, which trips BOTH caps and can't isolate this one.
    const files: Record<string, string> = { "src/types.ts": "export type T = 1;" };
    const N = 25; // > MAX_RESULTS(20), well under MAX_CANDIDATES(60)
    for (let i = 0; i < N; i++) files[`src/c${i}.ts`] = "import './types';";
    const res = importersOf(["src/types.ts"], { cwd: "/r", scope: "imports", deps: fakeDeps(files) });
    expect(res.get("src/types.ts")!.importers.length).toBe(MAX_RESULTS);
    expect(res.get("src/types.ts")!.truncated).toBe(true);
  });
});

describe("importersOf — import form coverage", () => {
  it.each([
    ["static import", "import { x } from './a/foo';", true],
    ["export-from", "export { x } from './a/foo';", true],
    ["cjs require", "const x = require('./a/foo');", true],
    ["dynamic import", "const x = await import('./a/foo');", true],
    ["type-only", "import type { X } from './a/foo';", false], // NOT runtime coverage
    ["string literal", "const p = './a/foo';", false], // not an import position
  ])("import form: %s counted=%p", (_name, line, counted) => {
    const files = { "src/a/foo.ts": "export const x=1;", "src/c.ts": line };
    const res = importersOf(["src/a/foo.ts"], { cwd: "/r", scope: "imports", deps: fakeDeps(files) });
    expect(res.get("src/a/foo.ts")!.importers.includes("src/c.ts")).toBe(counted);
  });

  it("counts a Biome-wrapped multi-line import (rg only sees the closing `} from` line)", () => {
    // This is siltpoke's own dominant formatting for 2+ named bindings — without the
    // closing-brace continuation handling in IMPORT_LINE, rg's single-line hit on the
    // closing `} from "./a/foo";` line has no `import`/`export ... from` token on it and
    // gets silently dropped (a real HIGH-severity under-detection found in review).
    const files = {
      "src/a/foo.ts": "export const x=1;",
      "src/c.ts": 'import {\n  x,\n  y,\n} from "./a/foo";',
    };
    const res = importersOf(["src/a/foo.ts"], { cwd: "/r", scope: "imports", deps: fakeDeps(files) });
    expect(res.get("src/a/foo.ts")!.importers).toContain("src/c.ts");
  });

  it("REGRESSION: a multi-line `import type` block is correctly excluded, not over-counted", () => {
    // Previously a KNOWN LIMITATION: rg's hit is the closing `} from` line only — the
    // `import type {` opener is 2 lines above and out of view, so the single-line TYPE_ONLY
    // regex couldn't exclude it, over-counting the block as a runtime importer. Fixed by
    // TYPE_ONLY_BLOCK, which matches the whole block against the candidate file's FULL TEXT
    // (JS regex character classes span newlines natively, no rg context-line parsing
    // needed). This test now pins the FIXED behavior so a future regression is a visible
    // diff here.
    const files = {
      "src/a/foo.ts": "export const x=1;",
      "src/c.ts": 'import type {\n  X,\n} from "./a/foo";',
    };
    const res = importersOf(["src/a/foo.ts"], { cwd: "/r", scope: "imports", deps: fakeDeps(files) });
    expect(res.get("src/a/foo.ts")!.importers).not.toContain("src/c.ts");
  });

  it("a multi-line `import type` block does NOT suppress a genuine multi-line runtime import of the same file", () => {
    // The fix must not throw out real coverage: a separate runtime import of the same
    // target from a DIFFERENT file must still count, even when another file's multi-line
    // type-only block also references the target.
    const files = {
      "src/a/foo.ts": "export const x=1;",
      "src/type-only.ts": 'import type {\n  X,\n} from "./a/foo";', // excluded
      "src/real.ts": 'import {\n  x,\n} from "./a/foo";', // still counted
    };
    const res = importersOf(["src/a/foo.ts"], { cwd: "/r", scope: "imports", deps: fakeDeps(files) });
    const importers = res.get("src/a/foo.ts")!.importers;
    expect(importers).not.toContain("src/type-only.ts");
    expect(importers).toContain("src/real.ts");
  });

  it("readFile throwing degrades that file's hits fail-soft, without aborting the whole lookup", () => {
    const files = {
      "src/a/foo.ts": "export const x=1;",
      "src/c.ts": 'import type {\n  X,\n} from "./a/foo";',
    };
    const deps = { ...fakeDeps(files), readFile: () => { throw new Error("read failed"); } };
    const res = importersOf(["src/a/foo.ts"], { cwd: "/r", scope: "imports", deps });
    // readFile failure -> can't prove src/c.ts's block is type-only -> falls back to the
    // pre-fix over-count posture for THAT file only (fail-soft, not an abort/degraded lookup).
    expect(res.get("src/a/foo.ts")!.degraded).toBe(false);
    expect(res.get("src/a/foo.ts")!.importers).toContain("src/c.ts");
  });

  it("REGRESSION (round 2): a file importing the SAME spec both type-only AND at runtime is KEPT as an importer", () => {
    // Round-1 fix's residual, found live in review: TYPE_ONLY_BLOCK operating at (file,spec)
    // granularity dropped ALL hits for that spec in that file, including a genuine runtime
    // one. Real pattern (tests/memory/consolidate.test.ts:8-9, ~6.3% of test files at
    // authoring time):
    //   import { consolidate, other } from '../src/consolidate';   <- runtime, complete on one line
    //   import type { ConsolidateOpts } from '../src/consolidate'; <- type-only, same spec
    // The runtime import is a COMPLETE single-line hit (never closing-brace-only), so
    // CLOSING_BRACE_ONLY correctly keeps it regardless of the sibling type-only import.
    const files = {
      "src/consolidate.ts": "export const consolidate = 1; export const other = 2;",
      "tests/consolidate.test.ts":
        'import { consolidate, other } from "../src/consolidate";\n' +
        'import type { ConsolidateOpts } from "../src/consolidate";\n',
    };
    const res = importersOf(["src/consolidate.ts"], { cwd: "/r", scope: "tests", deps: fakeDeps(files) });
    expect(res.get("src/consolidate.ts")!.importers).toContain("tests/consolidate.test.ts");
  });
});

describe("importersOf — scope:'tests' filtering", () => {
  it("excludes a tests/helpers importer, excludes a non-test src importer, keeps a real test file", () => {
    // The one pre-existing scope:"tests" test (`excludes a bare string-literal path`) used a
    // source path that was ALREADY a test file, so TEST_GLOB/NON_TEST_DIR never had a real
    // candidate to accept-or-reject — this is exactly the mode Task 4's test-gap rubric
    // consumes, so it needs its own dedicated coverage.
    const files = {
      "src/pay/charge.ts": "export const c = 1;", // changed file
      "tests/helpers/setup.ts": "import { c } from '../../src/pay/charge';", // EXCLUDED: NON_TEST_DIR
      "src/other.ts": "import { c } from './pay/charge';", // EXCLUDED: TEST_GLOB doesn't match (not a test path)
      "tests/foo.test.ts": "import { c } from '../src/pay/charge';", // KEPT: real test file
    };
    const res = importersOf(["src/pay/charge.ts"], { cwd: "/r", scope: "tests", deps: fakeDeps(files) });
    const importers = res.get("src/pay/charge.ts")!.importers;
    expect(importers).not.toContain("tests/helpers/setup.ts");
    expect(importers).not.toContain("src/other.ts");
    expect(importers).toContain("tests/foo.test.ts");
  });
});

describe("rgArgs", () => {
  it("passes basenames as bare positional args (not swallowed by a flag)", () => {
    const args = rgArgs(["foo", "bar"]);
    const wanted = args.filter((a) => !a.startsWith("-"));
    expect(wanted).toEqual(["foo", "bar"]);
  });

  it("emits no args for an empty basename list", () => {
    const args = rgArgs([]);
    expect(args.filter((a) => !a.startsWith("-"))).toEqual([]);
  });
});

// rg-availability (cross-family finding): a skip-on-missing-rg test can silently pass forever
// while production rg/rgArgs is broken. Detect real rg presence ONCE; if rg is present but the
// real call errors on a valid fixture, that's a genuine production break and must FAIL, not skip.
function isRgAvailable(): boolean {
  try {
    const probe = Bun.spawnSync([getRgBin(), "--version"]);
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}
const rgAvailable = isRgAvailable();

function mkdtempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-importers-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("importersOf — production path", () => {
  it.skipIf(!rgAvailable)(
    "[production-path] finds a real importer using real rg + real resolveImportTarget",
    () => {
      const dir = mkdtempRepo({
        "src/a/foo.ts": "export const x = 1;\n",
        "src/consumer.ts": "import { x } from './a/foo';\n",
      });
      try {
        const res = importersOf(["src/a/foo.ts"], { cwd: dir, scope: "imports" }); // NO deps → real seams
        expect(res.get("src/a/foo.ts")!.degraded).toBe(false);
        expect(res.get("src/a/foo.ts")!.importers).toContain("src/consumer.ts");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

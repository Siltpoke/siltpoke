import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GrepCallerResolver,
  type SearchFn,
  type SearchMatch,
} from "../../../src/critic/caller-impact/caller-resolver.ts";
import { getRgBin } from "../../../src/critic/tools/rg-bin.ts";

// CallerResolver finds CROSS-FILE call sites of a changed function. These
// tests inject a fake search (arrays of {file,line,text}) so they run without a
// real `rg` binary and the aggregation/classification logic is exercised
// deterministically. One fixture test uses the real `rg` (skipped if absent).

/** Build a fake SearchFn that always returns the given matches with ok:true. */
function fakeSearch(matches: SearchMatch[]): SearchFn {
  return async () => ({ matches, ok: true });
}

const CWD = "/repo";

describe("GrepCallerResolver", () => {
  test("cross-file caller counted; def in excluded file excluded from callers", async () => {
    const search = fakeSearch([
      { file: "def.ts", line: 3, text: "export function foo(a) { return a; }" },
      { file: "a.ts", line: 10, text: "  const x = foo(1);" },
    ]);
    const resolver = new GrepCallerResolver(search);
    const set = await resolver.resolveCallers("foo", {
      cwd: CWD,
      excludeFiles: ["def.ts"],
    });
    expect(set).toEqual({
      callers: [{ file: "a.ts", line: 10 }],
      defs: 1,
      ambiguous: false,
      callsiteCount: 1,
      unavailable: false,
    });
  });

  test("two definitions ⇒ ambiguous, defs:2; cross-file calls still counted", async () => {
    const search = fakeSearch([
      { file: "def1.ts", line: 1, text: "function foo() {}" },
      { file: "def2.ts", line: 1, text: "function foo() {}" },
      { file: "a.ts", line: 5, text: "foo();" },
      { file: "b.ts", line: 9, text: "  return foo();" },
    ]);
    const resolver = new GrepCallerResolver(search);
    const set = await resolver.resolveCallers("foo", {
      cwd: CWD,
      excludeFiles: ["def1.ts", "def2.ts"],
    });
    expect(set.ambiguous).toBe(true);
    expect(set.defs).toBe(2);
    expect(set.callsiteCount).toBe(2);
    expect(set.callers).toEqual([
      { file: "a.ts", line: 5 },
      { file: "b.ts", line: 9 },
    ]);
    expect(set.unavailable).toBe(false);
  });

  test("non-TS matches (a doc mention) are NOT counted as callers", async () => {
    // runRipgrep doesn't pass --type ts, so a function name quoted in a .md /
    // .json file shows up in matches; it must not become a fabricated caller.
    const search = fakeSearch([
      { file: "def.ts", line: 1, text: "export function foo() {}" },
      { file: "docs/journal.md", line: 42, text: "  const block = foo(); // example" },
      { file: "package.json", line: 9, text: '    "x": "foo()"' },
      { file: "src/real.ts", line: 7, text: "  return foo();" },
    ]);
    const set = await new GrepCallerResolver(search).resolveCallers("foo", {
      cwd: CWD,
      excludeFiles: ["def.ts"],
    });
    expect(set.callers).toEqual([{ file: "src/real.ts", line: 7 }]);
    expect(set.callsiteCount).toBe(1);
  });

  test("overload signatures in one file ⇒ defs:1, NOT ambiguous", async () => {
    // 3 grep hits for one overloaded function in a single file must read as one
    // definition place, not three — otherwise ambiguous would falsely fire.
    const search = fakeSearch([
      { file: "def.ts", line: 1, text: "export function foo(a: string): string;" },
      { file: "def.ts", line: 2, text: "export function foo(a: number): number;" },
      { file: "def.ts", line: 3, text: "export function foo(a: any): any { return a; }" },
      { file: "a.ts", line: 7, text: "  return foo(1);" },
    ]);
    const set = await new GrepCallerResolver(search).resolveCallers("foo", {
      cwd: CWD,
      excludeFiles: ["def.ts"],
    });
    expect(set.defs).toBe(1);
    expect(set.ambiguous).toBe(false);
    expect(set.callers).toEqual([{ file: "a.ts", line: 7 }]);
  });

  test("block comment `/* foo() */` is NOT a fabricated caller", async () => {
    const search = fakeSearch([
      { file: "def.ts", line: 1, text: "function foo() {}" },
      { file: "a.ts", line: 4, text: "  /* deprecated: call foo() instead */" },
      { file: "a.ts", line: 6, text: "  foo();" },
    ]);
    const set = await new GrepCallerResolver(search).resolveCallers("foo", {
      cwd: CWD,
      excludeFiles: ["def.ts"],
    });
    // only the real call at a.ts:6, not the comment at a.ts:4
    expect(set.callers).toEqual([{ file: "a.ts", line: 6 }]);
    expect(set.callsiteCount).toBe(1);
  });

  test("zero callers ⇒ empty callers, callsiteCount 0", async () => {
    const search = fakeSearch([
      { file: "def.ts", line: 2, text: "function foo() {}" },
    ]);
    const resolver = new GrepCallerResolver(search);
    const set = await resolver.resolveCallers("foo", {
      cwd: CWD,
      excludeFiles: ["def.ts"],
    });
    expect(set.callers).toEqual([]);
    expect(set.callsiteCount).toBe(0);
    expect(set.defs).toBe(1);
    expect(set.ambiguous).toBe(false);
  });

  test("call site in an EXCLUDED file is filtered from callers", async () => {
    const search = fakeSearch([
      { file: "def.ts", line: 1, text: "function foo() {}" },
      { file: "def.ts", line: 20, text: "  foo();" }, // same (changed) file → not cross-file
      { file: "a.ts", line: 4, text: "foo();" },
    ]);
    const resolver = new GrepCallerResolver(search);
    const set = await resolver.resolveCallers("foo", {
      cwd: CWD,
      excludeFiles: ["def.ts"],
    });
    expect(set.callers).toEqual([{ file: "a.ts", line: 4 }]);
    expect(set.callsiteCount).toBe(1);
  });

  test("comment line `// foo()` is not counted as a caller", async () => {
    const search = fakeSearch([
      { file: "a.ts", line: 7, text: "  // foo() is deprecated" },
      { file: "a.ts", line: 8, text: "   * see foo() for details" },
      { file: "a.ts", line: 9, text: "  const y = bar(); // foo()" },
      { file: "a.ts", line: 10, text: "  foo();" },
    ]);
    const resolver = new GrepCallerResolver(search);
    const set = await resolver.resolveCallers("foo", {
      cwd: CWD,
      excludeFiles: [],
    });
    expect(set.callers).toEqual([{ file: "a.ts", line: 10 }]);
    expect(set.callsiteCount).toBe(1);
  });

  test("absolute-path match + cwd-relative excludeFiles ⇒ correct exclusion", async () => {
    const search = fakeSearch([
      { file: "/repo/def.ts", line: 1, text: "function foo() {}" },
      { file: "/repo/def.ts", line: 12, text: "  foo();" }, // excluded (abs → rel == def.ts)
      { file: "/repo/a.ts", line: 6, text: "foo();" },
    ]);
    const resolver = new GrepCallerResolver(search);
    const set = await resolver.resolveCallers("foo", {
      cwd: CWD,
      excludeFiles: ["def.ts"], // cwd-relative
    });
    expect(set.callers).toEqual([{ file: "a.ts", line: 6 }]);
    expect(set.callsiteCount).toBe(1);
    expect(set.defs).toBe(1);
  });

  test("duplicate file:line callers are deduped", async () => {
    const search = fakeSearch([
      { file: "a.ts", line: 10, text: "foo();" },
      { file: "a.ts", line: 10, text: "foo();" },
    ]);
    const resolver = new GrepCallerResolver(search);
    const set = await resolver.resolveCallers("foo", {
      cwd: CWD,
      excludeFiles: [],
    });
    expect(set.callers).toEqual([{ file: "a.ts", line: 10 }]);
    expect(set.callsiteCount).toBe(1);
  });

  test("search throws ⇒ unavailable:true, no throw", async () => {
    const search: SearchFn = async () => {
      throw new Error("rg blew up");
    };
    const resolver = new GrepCallerResolver(search);
    const set = await resolver.resolveCallers("foo", {
      cwd: CWD,
      excludeFiles: [],
    });
    expect(set).toEqual({
      callers: [],
      defs: 0,
      ambiguous: false,
      callsiteCount: 0,
      unavailable: true,
    });
  });

  test("search reports ok:false ⇒ unavailable:true", async () => {
    const search: SearchFn = async () => ({ matches: [], ok: false });
    const resolver = new GrepCallerResolver(search);
    const set = await resolver.resolveCallers("foo", {
      cwd: CWD,
      excludeFiles: [],
    });
    expect(set.unavailable).toBe(true);
    expect(set.callers).toEqual([]);
  });
});

// --- Real-rg fixture test (skipped when ripgrep is not installed) ---

function realRgAvailable(): boolean {
  try {
    // Resolve the SAME binary the resolver uses (Cursor-bundled rg here, not the
    // PATH shim), so this fixture actually exercises the default-ctor real path.
    const r = spawnSync(getRgBin(), ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

const rgTest = realRgAvailable() ? test : test.skip;

describe("GrepCallerResolver — real rg fixture", () => {
  rgTest("finds the cross-file caller over a real tmp dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caller-resolver-"));
    try {
      writeFileSync(
        join(dir, "def.ts"),
        "export function widget(a: number) {\n  return a + 1;\n}\n",
      );
      writeFileSync(
        join(dir, "use.ts"),
        'import { widget } from "./def.ts";\nconst v = widget(2);\nconsole.log(v);\n',
      );
      // default ctor → real ripgrep
      const resolver = new GrepCallerResolver();
      const set = await resolver.resolveCallers("widget", {
        cwd: dir,
        excludeFiles: ["def.ts"],
      });
      expect(set.unavailable).toBe(false);
      expect(set.callers).toEqual([{ file: "use.ts", line: 2 }]);
      expect(set.callsiteCount).toBe(1);
      expect(set.defs).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

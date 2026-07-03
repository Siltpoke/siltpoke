import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChangedFunction,
  extractChangedFunctions,
  type ImageReader,
  parseUnifiedDiff,
} from "../../../src/critic/caller-impact/changed-functions";

// ---------------------------------------------------------------------------
// parseUnifiedDiff — isolated unit tests with hand-written diffs
// ---------------------------------------------------------------------------

describe("parseUnifiedDiff", () => {
  test("body edit: records added new line + removed old line", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "index 111..222 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-line2old",
      "+line2new",
      " line3",
    ].join("\n");

    const [fd] = parseUnifiedDiff(diff);
    expect(fd.oldPath).toBe("x.ts");
    expect(fd.newPath).toBe("x.ts");
    expect([...fd.addedNewLines].sort((a, b) => a - b)).toEqual([2]);
    expect([...fd.removedOldLines].sort((a, b) => a - b)).toEqual([2]);
  });

  test("multi-line hunk counters advance correctly across context", () => {
    const diff = [
      "--- a/y.ts",
      "+++ b/y.ts",
      "@@ -10,4 +10,5 @@",
      " ctxA",
      " ctxB",
      "+inserted",
      " ctxC",
      "-deleted",
      " ctxD",
    ].join("\n");

    const [fd] = parseUnifiedDiff(diff);
    // new-side: 10 ctxA, 11 ctxB, 12 inserted, 13 ctxC, 14 ctxD
    expect([...fd.addedNewLines]).toEqual([12]);
    // old-side: 10 ctxA, 11 ctxB, 12 ctxC, 13 deleted, 14 ctxD
    expect([...fd.removedOldLines]).toEqual([13]);
  });

  test("/dev/null pure-add: oldPath null, all body lines are adds", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,3 @@",
      "+l1",
      "+l2",
      "+l3",
      "\\ No newline at end of file",
    ].join("\n");

    const [fd] = parseUnifiedDiff(diff);
    expect(fd.oldPath).toBeNull();
    expect(fd.newPath).toBe("new.ts");
    expect([...fd.addedNewLines].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect([...fd.removedOldLines]).toEqual([]);
  });

  test("/dev/null pure-delete: newPath null, all body lines are removes", () => {
    const diff = [
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b",
    ].join("\n");

    const [fd] = parseUnifiedDiff(diff);
    expect(fd.oldPath).toBe("gone.ts");
    expect(fd.newPath).toBeNull();
    expect([...fd.removedOldLines].sort((a, b) => a - b)).toEqual([1, 2]);
    expect([...fd.addedNewLines]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration via a REAL git diff (tmp git repo)
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

async function run(cwd: string, argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.t",
    },
  });
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${argv.join(" ")} exited ${exit}: ${err}`);
  }
  return out;
}

/**
 * Build a tmp git repo: commit `pre`, write `post`, return the diff +
 * an ImageReader (pre = `git show HEAD:file`, post = working-tree read).
 */
async function gitScenario(
  file: string,
  pre: string,
  post: string,
): Promise<{ diff: string; images: ImageReader }> {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-cf-"));
  tmpDirs.push(dir);
  await run(dir, ["git", "init", "-q"]);
  writeFileSync(join(dir, file), pre);
  await run(dir, ["git", "add", "."]);
  await run(dir, ["git", "commit", "-q", "-m", "pre"]);
  writeFileSync(join(dir, file), post);
  const diff = await run(dir, ["git", "diff"]);

  const { readFileSync, existsSync } = await import("node:fs");
  const images: ImageReader = {
    // pre-image = the committed HEAD blob; null if the path is not tracked.
    pre: (p: string) => {
      const r = Bun.spawnSync(["git", "show", `HEAD:${p}`], { cwd: dir });
      return r.exitCode === 0 ? r.stdout.toString() : null;
    },
    // post-image = the working-tree file; null if it no longer exists.
    post: (p: string) =>
      existsSync(join(dir, p)) ? readFileSync(join(dir, p), "utf8") : null,
  };

  return { diff, images };
}

function byName(fns: ChangedFunction[]): Record<string, ChangedFunction> {
  const m: Record<string, ChangedFunction> = {};
  for (const f of fns) m[f.name] = f;
  return m;
}

describe("extractChangedFunctions (real git diff)", () => {
  test("body-only edit inside foo (multi-fn file) → only foo modified", async () => {
    const pre = [
      "export function foo() {",
      "  return 1;",
      "}",
      "",
      "export function bar() {",
      "  return 2;",
      "}",
      "",
    ].join("\n");
    const post = [
      "export function foo() {",
      "  return 42;",
      "}",
      "",
      "export function bar() {",
      "  return 2;",
      "}",
      "",
    ].join("\n");

    const { diff, images } = await gitScenario("x.ts", pre, post);
    const fns = await extractChangedFunctions(diff, images, "ts");
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe("foo");
    expect(fns[0].kind).toBe("modified");
    expect(fns.find((f) => f.name === "bar")).toBeUndefined();
  });

  test("whitespace/blank-line change between two functions → []", async () => {
    const pre = [
      "export function foo() {",
      "  return 1;",
      "}",
      "",
      "export function bar() {",
      "  return 2;",
      "}",
      "",
    ].join("\n");
    // Insert a blank line in the gap between foo and bar (touches neither body).
    const post = [
      "export function foo() {",
      "  return 1;",
      "}",
      "",
      "",
      "export function bar() {",
      "  return 2;",
      "}",
      "",
    ].join("\n");

    const { diff, images } = await gitScenario("x.ts", pre, post);
    const fns = await extractChangedFunctions(diff, images, "ts");
    expect(fns).toEqual([]);
  });

  test("new function baz added, foo untouched → only baz added", async () => {
    const pre = [
      "export function foo() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    const post = [
      "export function foo() {",
      "  return 1;",
      "}",
      "",
      "export function baz() {",
      "  return 3;",
      "}",
      "",
    ].join("\n");

    const { diff, images } = await gitScenario("x.ts", pre, post);
    const fns = await extractChangedFunctions(diff, images, "ts");
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe("baz");
    expect(fns[0].kind).toBe("added");
  });

  test("function qux deleted → only qux removed", async () => {
    const pre = [
      "export function foo() {",
      "  return 1;",
      "}",
      "",
      "export function qux() {",
      "  return 9;",
      "}",
      "",
    ].join("\n");
    const post = [
      "export function foo() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");

    const { diff, images } = await gitScenario("x.ts", pre, post);
    const fns = await extractChangedFunctions(diff, images, "ts");
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe("qux");
    expect(fns[0].kind).toBe("removed");
  });

  test("rename oldName → newName surfaces removed(old) + added(new)", async () => {
    const pre = [
      "export function oldName() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    const post = [
      "export function newName() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");

    const { diff, images } = await gitScenario("x.ts", pre, post);
    const fns = await extractChangedFunctions(diff, images, "ts");
    const m = byName(fns);
    expect(m.oldName?.kind).toBe("removed");
    expect(m.newName?.kind).toBe("added");
  });

  test("post-image with a syntax error → no throw", async () => {
    const pre = [
      "export function foo() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    // Unbalanced braces — tree-sitter will produce ERROR nodes but not throw.
    const post = [
      "export function foo() {",
      "  return 1;",
      "  // missing close brace below",
      "export function bar( {{{",
      "",
    ].join("\n");

    const { diff, images } = await gitScenario("x.ts", pre, post);
    let fns: ChangedFunction[] = [];
    await expect(
      (async () => {
        fns = await extractChangedFunctions(diff, images, "ts");
      })(),
    ).resolves.toBeUndefined();
    expect(Array.isArray(fns)).toBe(true);
  });

  test("edit inside a nested helper flags only the inner fn, not the outer", async () => {
    const pre = [
      "export function outer() {",
      "  function inner() {",
      "    return 1;",
      "  }",
      "  return inner();",
      "}",
      "",
    ].join("\n");
    const post = [
      "export function outer() {",
      "  function inner() {",
      "    return 42;",
      "  }",
      "  return inner();",
      "}",
      "",
    ].join("\n");

    const { diff, images } = await gitScenario("x.ts", pre, post);
    const fns = await extractChangedFunctions(diff, images, "ts");
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe("inner");
    expect(fns[0].kind).toBe("modified");
    expect(fns.find((f) => f.name === "outer")).toBeUndefined();
  });

  test("duplicate inner names: only the edited instance is modified", async () => {
    const pre = [
      "export function a() {",
      "  function inner() {",
      "    return 1;",
      "  }",
      "  return inner();",
      "}",
      "export function b() {",
      "  function inner() {",
      "    return 2;",
      "  }",
      "  return inner();",
      "}",
      "",
    ].join("\n");
    const post = [
      "export function a() {",
      "  function inner() {",
      "    return 1;",
      "  }",
      "  return inner();",
      "}",
      "export function b() {",
      "  function inner() {",
      "    return 99;", // only b's inner edited
      "  }",
      "  return inner();",
      "}",
      "",
    ].join("\n");

    const { diff, images } = await gitScenario("x.ts", pre, post);
    const fns = await extractChangedFunctions(diff, images, "ts");
    // Both inner functions share the name; only the edited instance (lines 8-10
    // in the post image) is flagged, and neither outer is.
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe("inner");
    expect(fns[0].kind).toBe("modified");
    expect(fns[0].lineRange.start).toBe(8);
    expect(fns.find((f) => f.name === "a" || f.name === "b")).toBeUndefined();
  });
});

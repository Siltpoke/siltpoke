/**
 * Other (non-code) files are listed at index time into `other-files.json`,
 * beside — never inside — graph.json, so the code graph and everything built
 * on it (Generate prompt, critic resolver) is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexBuild } from "../../src/repo-graph/builder";
import { readGraph, readOtherFiles, writeOtherFiles } from "../../src/repo-graph/store";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-other-files-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("other-files store", () => {
  it("round-trips", async () => {
    const dir = join(tmp, "store");
    await writeOtherFiles(dir, { schemaVersion: 1, files: ["README.md", "docs/a.md"], truncated: false });
    expect(await readOtherFiles(dir)).toEqual({ schemaVersion: 1, files: ["README.md", "docs/a.md"], truncated: false });
  });

  it("an index built before this file existed reads as null (show nothing, not 'zero other files')", async () => {
    expect(await readOtherFiles(join(tmp, "missing"))).toBeNull();
  });

  it("a malformed file reads as null", async () => {
    const dir = join(tmp, "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "other-files.json"), JSON.stringify({ schemaVersion: 1, files: "nope" }));
    expect(await readOtherFiles(dir)).toBeNull();
  });
});

describe("other files follow .gitignore", () => {
  // Smoke on agent-runtime (2026-10-16): 28 "other files", most of them
  // __pycache__/*.pyc, and an empty __pycache__ band. The repo's .gitignore
  // already says to ignore them; an untracked .env must not even be named.
  const write = (root: string, rel: string, body = "x\n") => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };

  it("a git repo lists only files git would show (tracked + untracked-not-ignored)", async () => {
    const repo = join(tmp, "g");
    const home = join(tmp, "home-g");
    write(repo, ".gitignore", "__pycache__/\n*.pyc\n.env\n");
    write(repo, "main.py", "def run():\n    pass\n");
    write(repo, "README.md");
    write(repo, ".env", "SECRET=1\n");
    write(repo, "__pycache__/main.cpython-312.pyc");
    write(repo, "tests/__pycache__/t.cpython-312.pyc");
    write(repo, "tests/test_a.py", "def test_a():\n    pass\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const r = await runIndexBuild({ cwd: repo, root: repo, home });
    expect((await readOtherFiles(r.storage_dir))?.files.slice().sort()).toEqual([".gitignore", "README.md", "tests/test_a.py"]);
  });

  it("inside git but git cannot list files: nothing is listed (fail closed — never name .env)", async () => {
    const repo = join(tmp, "broken");
    const home = join(tmp, "home-b");
    write(repo, "main.py", "def run():\n    pass\n");
    write(repo, ".env", "SECRET=1\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    // A corrupt index makes `git ls-files` fail while the repo is still a work tree.
    writeFileSync(join(repo, ".git", "index"), "not an index");
    const r = await runIndexBuild({ cwd: repo, root: repo, home });
    expect((await readOtherFiles(r.storage_dir))?.files).toEqual([]);
  });

  it("a repo git cannot even recognise (rev-parse fails, .git present) also lists nothing", async () => {
    // Review of 89a468b3: the 'is this a work tree' probe swallowed its own
    // failure as 'no git' — timeout under load, dubious ownership, a corrupt
    // HEAD — and the list went out unfiltered.
    const repo = join(tmp, "nohead");
    const home = join(tmp, "home-h");
    write(repo, "main.py", "def run():\n    pass\n");
    write(repo, ".env", "SECRET=1\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, ".git", "HEAD"), "garbage\n");
    const r = await runIndexBuild({ cwd: repo, root: repo, home });
    expect((await readOtherFiles(r.storage_dir))?.files).toEqual([]);
  });

  it("outside git, everything the walk saw is listed (no ignore rules to apply)", async () => {
    const dir = join(tmp, "plain");
    const home = join(tmp, "home-p");
    write(dir, "main.py", "def run():\n    pass\n");
    write(dir, "__pycache__/main.cpython-312.pyc");
    const r = await runIndexBuild({ cwd: dir, root: dir, home });
    expect((await readOtherFiles(r.storage_dir))?.files).toEqual(["__pycache__/main.cpython-312.pyc"]);
  });
});

describe("runIndexBuild writes other-files.json and leaves graph.json code-only", () => {
  it("agent-runtime shape", async () => {
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    for (const [rel, body] of [
      ["main.py", "def run():\n    pass\n"],
      ["README.md", "# r\n"],
      ["requirements.txt", "x\n"],
      ["docs/plan.md", "p\n"],
      ["tests/test_loop.py", "def test_x():\n    pass\n"],
    ] as const) {
      mkdirSync(join(repo, rel, ".."), { recursive: true });
      writeFileSync(join(repo, rel), body);
    }
    const r = await runIndexBuild({ cwd: repo, root: repo, home });
    const others = await readOtherFiles(r.storage_dir);
    expect(others?.files.slice().sort()).toEqual(["README.md", "docs/plan.md", "requirements.txt", "tests/test_loop.py"]);
    expect(others?.truncated).toBe(false);
    const graphFiles = (await readGraph(r.storage_dir)).nodes.filter((n) => n.type === "file").map((n) => n.path);
    expect(graphFiles).toEqual(["main.py"]);
  });
});

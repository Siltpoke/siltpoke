import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitDiff } from "../../../src/critic/tools/run-git-diff";
import { spawnWithTimeout } from "../../../src/critic/spawn";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-gitdiff-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function gitInit(dir: string) {
  await spawnWithTimeout({
    argv: ["git", "init"],
    cwd: dir,
    timeoutMs: 5000,
  });
  await spawnWithTimeout({
    argv: ["git", "config", "user.email", "test@test.com"],
    cwd: dir,
    timeoutMs: 5000,
  });
  await spawnWithTimeout({
    argv: ["git", "config", "user.name", "Test User"],
    cwd: dir,
    timeoutMs: 5000,
  });
}

async function gitAddCommit(dir: string, message: string) {
  await spawnWithTimeout({
    argv: ["git", "add", "."],
    cwd: dir,
    timeoutMs: 5000,
  });
  await spawnWithTimeout({
    argv: ["git", "commit", "-m", message],
    cwd: dir,
    timeoutMs: 5000,
    env: { ...process.env, GIT_AUTHOR_DATE: "2024-01-01T00:00:00", GIT_COMMITTER_DATE: "2024-01-01T00:00:00" } as Record<string, string>,
  });
}

describe("runGitDiff", () => {
  test("non-git cwd → status not_applicable", async () => {
    const result = await runGitDiff({ cwd: tmp });
    expect(result.tool).toBe("git-diff");
    expect(result.status).toBe("not_applicable");
    expect(result.parsed).toEqual([]);
  });

  test("happy clean: fresh git repo with commit, no changes → status ok, parsed []", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "file.ts"), "const x = 1;\n");
    await gitAddCommit(tmp, "initial commit");

    const result = await runGitDiff({ cwd: tmp });
    expect(result.tool).toBe("git-diff");
    expect(result.status).toBe("ok");
    expect(result.parsed).toEqual([]);
  });

  test("has hunks: edit tracked file → parsed contains hunk", async () => {
    await gitInit(tmp);
    const filePath = join(tmp, "tracked.ts");
    writeFileSync(filePath, "const x = 1;\n");
    await gitAddCommit(tmp, "initial");

    // Modify the file (unstaged diff)
    writeFileSync(filePath, "const x = 2;\nconst y = 3;\n");

    const result = await runGitDiff({ cwd: tmp });
    expect(result.tool).toBe("git-diff");
    expect(result.status).toBe("ok");
    expect(result.parsed.length).toBeGreaterThan(0);
    const hunk = result.parsed[0]!;
    expect(hunk.file).toContain("tracked.ts");
    expect(typeof hunk.oldStart).toBe("number");
    expect(typeof hunk.oldLines).toBe("number");
    expect(typeof hunk.newStart).toBe("number");
    expect(typeof hunk.newLines).toBe("number");
    expect(typeof hunk.header).toBe("string");
    expect(typeof hunk.body).toBe("string");
  });

  test("timeout: slow command + small timeoutMs → status timeout (uses _argv test affordance because real git is too fast to reliably trip)", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "file.ts"), "const x = 1;\n");
    await gitAddCommit(tmp, "init");

    // _argv override injects a deliberately-slow command; git itself completes in <1ms
    // on Linux CI, making timeoutMs:1 race-prone. spawnWithTimeout's timeout path is
    // independently covered by tests/critic/spawn.test.ts; this test just verifies
    // runGitDiff propagates timedOut → status: "timeout".
    const result = await runGitDiff({
      cwd: tmp,
      timeoutMs: 50,
      _argv: ["sleep", "10"],
    });
    expect(result.tool).toBe("git-diff");
    expect(result.status).toBe("timeout");
  });

  test("adaptive truncation: file with >60 lines of diff body has elision marker", async () => {
    await gitInit(tmp);
    const filePath = join(tmp, "big.ts");
    // Write initial content with 60 lines
    const initial = `${Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join("\n")}\n`;
    writeFileSync(filePath, initial);
    await gitAddCommit(tmp, "initial big file");

    // Replace all lines to create a large diff (60 dels + 60 adds = 120 body lines → elision tier)
    const modified = `${Array.from({ length: 60 }, (_, i) => `const v${i} = ${i * 2};`).join("\n")}\n`;
    writeFileSync(filePath, modified);

    const result = await runGitDiff({ cwd: tmp });
    expect(result.tool).toBe("git-diff");
    expect(result.status).toBe("ok");
    expect(result.parsed.length).toBeGreaterThan(0);
    const hunk = result.parsed[0]!;
    // Body should contain the adaptive elision marker (head+tail with middle elided)
    expect(hunk.body).toContain("[middle");
    expect(hunk.body).toContain("lines elided]");
  });

  test("hunk body is NOT truncated when diff is ≤30 lines", async () => {
    await gitInit(tmp);
    const filePath = join(tmp, "small.ts");
    writeFileSync(filePath, "const x = 1;\nconst y = 2;\n");
    await gitAddCommit(tmp, "initial");

    writeFileSync(filePath, "const x = 10;\nconst y = 20;\n");

    const result = await runGitDiff({ cwd: tmp });
    expect(result.tool).toBe("git-diff");
    expect(result.status).toBe("ok");
    expect(result.parsed.length).toBeGreaterThan(0);
    const hunk = result.parsed[0]!;
    expect(hunk.body).not.toContain("[... +");
  });

  test("leading-dash revisionRange (--no-pager) → status error, raw 'invalid revision range'", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "file.ts"), "const x = 1;\n");
    await gitAddCommit(tmp, "init");

    const result = await runGitDiff({ cwd: tmp, revisionRange: "--no-pager" });
    expect(result.tool).toBe("git-diff");
    expect(result.status).toBe("error");
    expect(result.raw).toBe("invalid revision range");
  });

  test("raw field is populated", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "r.ts"), "const a = 1;\n");
    await gitAddCommit(tmp, "init");
    writeFileSync(join(tmp, "r.ts"), "const a = 2;\n");

    const result = await runGitDiff({ cwd: tmp });
    expect(typeof result.raw).toBe("string");
    // Raw should contain the diff output
    expect(result.raw.length).toBeGreaterThan(0);
  });
});

/**
 * Tests for src/router/git-snapshot.ts — PQ3 git status snapshot helper.
 * Uses real `git init` + file operations in temp dirs.
 */
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithTimeout } from "../../src/critic/spawn";
import { captureGitBaseline, diffAgainstBaseline } from "../../src/router/git-snapshot";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-gitsnap-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gitInit(dir: string): Promise<void> {
  await spawnWithTimeout({ argv: ["git", "init"], cwd: dir, timeoutMs: 5000 });
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

async function gitAddCommit(dir: string, message: string): Promise<void> {
  await spawnWithTimeout({ argv: ["git", "add", "."], cwd: dir, timeoutMs: 5000 });
  await spawnWithTimeout({
    argv: ["git", "commit", "-m", message],
    cwd: dir,
    timeoutMs: 5000,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2024-01-01T00:00:00",
      GIT_COMMITTER_DATE: "2024-01-01T00:00:00",
    } as Record<string, string>,
  });
}

// ---------------------------------------------------------------------------
// captureGitBaseline
// ---------------------------------------------------------------------------

describe("captureGitBaseline", () => {
  test("1. non-git dir → returns null", async () => {
    const result = await captureGitBaseline(tmp);
    expect(result).toBeNull();
  });

  test("2. empty git repo (just git init) → empty entries map", async () => {
    await gitInit(tmp);
    const result = await captureGitBaseline(tmp);
    expect(result).not.toBeNull();
    expect(result?.entries.size).toBe(0);
    expect(typeof result?.capturedAt).toBe("number");
    expect(result?.cwd).toBe(tmp);
  });

  test("3. clean repo after commit → empty entries", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "a.ts"), "const x = 1;\n");
    await gitAddCommit(tmp, "initial");
    const result = await captureGitBaseline(tmp);
    expect(result).not.toBeNull();
    expect(result?.entries.size).toBe(0);
  });

  test("4. repo with one dirty file → entries has the file", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "dirty.ts"), "const x = 1;\n");
    await gitAddCommit(tmp, "initial");
    writeFileSync(join(tmp, "dirty.ts"), "const x = 2;\n");
    const result = await captureGitBaseline(tmp);
    expect(result).not.toBeNull();
    expect(result?.entries.has("dirty.ts")).toBe(true);
    // Unstaged modification → " M" (working tree modified)
    const code = result?.entries.get("dirty.ts")!;
    expect(code).toContain("M");
  });

  test("5. repo with one staged file → entries reflect index state", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "staged.ts"), "const x = 1;\n");
    await gitAddCommit(tmp, "initial");
    writeFileSync(join(tmp, "staged.ts"), "const x = 2;\n");
    await spawnWithTimeout({
      argv: ["git", "add", "staged.ts"],
      cwd: tmp,
      timeoutMs: 5000,
    });
    const result = await captureGitBaseline(tmp);
    expect(result).not.toBeNull();
    expect(result?.entries.has("staged.ts")).toBe(true);
    // Staged modification → "M " (index modified)
    const code = result?.entries.get("staged.ts")!;
    expect(code).toContain("M");
  });

  test("6. ENOENT path → returns null (no crash)", async () => {
    const result = await captureGitBaseline("/nonexistent/path/does/not/exist");
    expect(result).toBeNull();
  });

  test("7. cwd doesn't exist → returns null", async () => {
    const result = await captureGitBaseline(join(tmp, "subdir-that-does-not-exist"));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// diffAgainstBaseline
// ---------------------------------------------------------------------------

describe("diffAgainstBaseline", () => {
  test("8. baseline = clean repo, current = same → diff is []", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "file.ts"), "const x = 1;\n");
    await gitAddCommit(tmp, "initial");
    const baseline = await captureGitBaseline(tmp);
    expect(baseline).not.toBeNull();
    const diff = await diffAgainstBaseline(baseline!, tmp);
    expect(diff).toEqual([]);
  });

  test("9. baseline = clean, current = one file edited → diff contains the file", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "edit.ts"), "const x = 1;\n");
    await gitAddCommit(tmp, "initial");
    const baseline = await captureGitBaseline(tmp);
    expect(baseline).not.toBeNull();
    // Now dirty the file
    writeFileSync(join(tmp, "edit.ts"), "const x = 2;\n");
    const diff = await diffAgainstBaseline(baseline!, tmp);
    expect(diff).toContain("edit.ts");
  });

  test("10. baseline = one file edited, current = clean (user reverted) → diff contains the file", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "revert.ts"), "const x = 1;\n");
    await gitAddCommit(tmp, "initial");
    // Dirty before baseline
    writeFileSync(join(tmp, "revert.ts"), "const x = 2;\n");
    const baseline = await captureGitBaseline(tmp);
    expect(baseline).not.toBeNull();
    // Revert
    writeFileSync(join(tmp, "revert.ts"), "const x = 1;\n");
    await spawnWithTimeout({
      argv: ["git", "checkout", "revert.ts"],
      cwd: tmp,
      timeoutMs: 5000,
    });
    const diff = await diffAgainstBaseline(baseline!, tmp);
    expect(diff).toContain("revert.ts");
  });

  test("11. baseline = unstaged modified, current = same file staged → diff contains the file", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "staged2.ts"), "const x = 1;\n");
    await gitAddCommit(tmp, "initial");
    writeFileSync(join(tmp, "staged2.ts"), "const x = 2;\n");
    // baseline captures " M" (unstaged)
    const baseline = await captureGitBaseline(tmp);
    expect(baseline).not.toBeNull();
    // Now stage it → "M " (staged)
    await spawnWithTimeout({
      argv: ["git", "add", "staged2.ts"],
      cwd: tmp,
      timeoutMs: 5000,
    });
    const diff = await diffAgainstBaseline(baseline!, tmp);
    expect(diff).toContain("staged2.ts");
  });

  test("12. two files edited between baseline and current → diff has both", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "one.ts"), "const a = 1;\n");
    writeFileSync(join(tmp, "two.ts"), "const b = 2;\n");
    await gitAddCommit(tmp, "initial");
    const baseline = await captureGitBaseline(tmp);
    expect(baseline).not.toBeNull();
    writeFileSync(join(tmp, "one.ts"), "const a = 10;\n");
    writeFileSync(join(tmp, "two.ts"), "const b = 20;\n");
    const diff = await diffAgainstBaseline(baseline!, tmp);
    expect(diff).toContain("one.ts");
    expect(diff).toContain("two.ts");
  });

  test("13. rename in current: baseline has old.ts clean, current has rename → diff has both", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "old.ts"), "const x = 1;\n");
    await gitAddCommit(tmp, "initial");
    const baseline = await captureGitBaseline(tmp);
    expect(baseline).not.toBeNull();
    // Perform rename
    await spawnWithTimeout({
      argv: ["git", "mv", "old.ts", "new.ts"],
      cwd: tmp,
      timeoutMs: 5000,
    });
    const diff = await diffAgainstBaseline(baseline!, tmp);
    expect(diff).toContain("old.ts");
    expect(diff).toContain("new.ts");
  });

  test("14. non-git cwd → returns []", async () => {
    // Create a fake baseline from a git repo, but pass a non-git cwd
    await gitInit(tmp);
    writeFileSync(join(tmp, "file.ts"), "const x = 1;\n");
    await gitAddCommit(tmp, "initial");
    const baseline = await captureGitBaseline(tmp);
    expect(baseline).not.toBeNull();
    // Now diff against a non-git directory
    const nonGit = mkdtempSync(join(tmpdir(), "siltpoke-nongit-"));
    try {
      const diff = await diffAgainstBaseline(baseline!, nonGit);
      expect(diff).toEqual([]);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  test("15. gitignore'd build artifact → filtered out", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "src.ts"), "const x = 1;\n");
    writeFileSync(join(tmp, ".gitignore"), "dist/\n");
    await gitAddCommit(tmp, "initial");
    const baseline = await captureGitBaseline(tmp);
    expect(baseline).not.toBeNull();
    // Create ignored dist file
    mkdirSync(join(tmp, "dist"), { recursive: true });
    writeFileSync(join(tmp, "dist", "build-output.js"), "console.log('built');\n");
    const diff = await diffAgainstBaseline(baseline!, tmp);
    // dist/build-output.js should NOT appear (ignored and not on allowlist)
    expect(diff).not.toContain("dist/build-output.js");
    expect(diff).not.toContain(join("dist", "build-output.js"));
  });

  test("16. .env.local modified → included (allowlist)", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "src.ts"), "const x = 1;\n");
    writeFileSync(join(tmp, ".gitignore"), ".env*\n");
    await gitAddCommit(tmp, "initial");
    const baseline = await captureGitBaseline(tmp);
    expect(baseline).not.toBeNull();
    // Create/modify .env.local (ignored but on allowlist)
    writeFileSync(join(tmp, ".env.local"), "SECRET=abc\n");
    const diff = await diffAgainstBaseline(baseline!, tmp);
    expect(diff).toContain(".env.local");
  });

  test("17. bun.lock modified → included (allowlist)", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "src.ts"), "const x = 1;\n");
    writeFileSync(join(tmp, ".gitignore"), "bun.lock\n");
    await gitAddCommit(tmp, "initial");
    const baseline = await captureGitBaseline(tmp);
    expect(baseline).not.toBeNull();
    writeFileSync(join(tmp, "bun.lock"), "lockfile content\n");
    const diff = await diffAgainstBaseline(baseline!, tmp);
    expect(diff).toContain("bun.lock");
  });

  test("18. dist/build-output.js modified → filtered (ignored AND not on allowlist)", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "src.ts"), "const x = 1;\n");
    writeFileSync(join(tmp, ".gitignore"), "dist/\n");
    await gitAddCommit(tmp, "initial");
    const baseline = await captureGitBaseline(tmp);
    expect(baseline).not.toBeNull();
    mkdirSync(join(tmp, "dist"), { recursive: true });
    writeFileSync(join(tmp, "dist", "build-output.js"), "compiled;\n");
    const diff = await diffAgainstBaseline(baseline!, tmp);
    expect(diff.some((p) => p.includes("dist"))).toBe(false);
  });
});

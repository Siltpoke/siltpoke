// The wiring half of the untracked-file fix: runTools must hand the turn's
// changed files to runGitDiff, or the new file never reaches the review even
// though runGitDiff itself can show it.
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTools } from "../../../src/critic/tools/run-tools";
import { spawnWithTimeout } from "../../../src/critic/spawn";
import type { ProjectCapabilities } from "../../../src/critic/capabilities";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-runtools-untracked-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const caps = (): ProjectCapabilities => ({
  cwd: tmp, hasGit: true, hasTsc: false, hasEslint: false, hasRipgrep: false,
  tsconfigPaths: [], eslintConfigPaths: [], detectedAt: Date.now(), configMtimes: {},
});

async function git(...args: string[]): Promise<void> {
  await spawnWithTimeout({
    argv: ["git", ...args], cwd: tmp, timeoutMs: 5000,
    env: { ...process.env, GIT_AUTHOR_DATE: "2024-01-01T00:00:00", GIT_COMMITTER_DATE: "2024-01-01T00:00:00" } as Record<string, string>,
  });
}

describe("runTools passes the turn's changed files to git-diff", () => {
  test("an untracked file the turn wrote is in the git-diff result", async () => {
    await git("init");
    await git("config", "user.email", "t@t.com");
    await git("config", "user.name", "T");
    writeFileSync(join(tmp, "a.ts"), "export const a = 1;\n");
    await git("add", ".");
    await git("commit", "-m", "init");
    writeFileSync(join(tmp, "billing.ts"), "export const b = 2;\n");

    const r = await runTools({ cwd: tmp, changedFiles: [join(tmp, "billing.ts")], caps: caps() });
    expect(r["git-diff"].status).toBe("ok");
    expect(r["git-diff"].parsed.map((h) => h.file)).toEqual(["billing.ts"]);
  });

  test("with a revision range, it is not passed (committed work only)", async () => {
    await git("init");
    await git("config", "user.email", "t@t.com");
    await git("config", "user.name", "T");
    writeFileSync(join(tmp, "a.ts"), "export const a = 1;\n");
    await git("add", ".");
    await git("commit", "-m", "init");
    writeFileSync(join(tmp, "a.ts"), "export const a = 2;\n");
    await git("commit", "-am", "second");
    writeFileSync(join(tmp, "loose.ts"), "export const l = 1;\n");

    const r = await runTools({ cwd: tmp, changedFiles: [join(tmp, "loose.ts")], caps: caps(), revisionRange: "HEAD~1..HEAD" });
    expect(r["git-diff"].parsed.map((h) => h.file)).toEqual(["a.ts"]);
  });
});

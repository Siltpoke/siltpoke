// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// [61] PR 2, plan P1.5 (spec §2.3): the first time siltpoke writes
// `{repo}/.siltpoke/` it adds that repo to the install receipt's `projects`
// list, so a purge can find the folders it must offer to remove ("cannot be
// enumerated" was the gap). Recording is best-effort: SessionStart must never
// fail because a receipt could not be written.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReceipt } from "../../src/installer/receipt";
import { resolveOrCaptureSessionHeadSha, writeSessionBaseline } from "../../src/hooks/session-baseline";

let root: string;
let home: string;
let repo: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "siltpoke-baseline-receipt-"));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  env = { HOME: home };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const baseline = { head_sha: "abc123", session_id: "s1", captured_at: "2026-10-03T00:00:00Z" };
const projects = () => readReceipt(env)?.projects ?? [];

describe("writeSessionBaseline → receipt.projects", () => {
  test("the first write into {repo}/.siltpoke/ lists the repo", async () => {
    await writeSessionBaseline(repo, baseline, env);
    expect(existsSync(join(repo, ".siltpoke"))).toBe(true);
    expect(projects()).toEqual([repo]);
  });

  test("a second session in the same repo does not list it twice", async () => {
    await writeSessionBaseline(repo, baseline, env);
    await writeSessionBaseline(repo, { ...baseline, session_id: "s2" }, env);
    expect(projects()).toEqual([repo]);
  });

  test("two repos are both listed", async () => {
    const other = join(root, "other");
    mkdirSync(other);
    await writeSessionBaseline(repo, baseline, env);
    await writeSessionBaseline(other, baseline, env);
    expect(projects().sort()).toEqual([other, repo].sort());
  });

  test("a repo whose .siltpoke already existed before receipts is listed on its next write", async () => {
    mkdirSync(join(repo, ".siltpoke"));
    await writeSessionBaseline(repo, baseline, env);
    expect(projects()).toEqual([repo]);
  });

  test("when the folder could not be written, the repo is NOT listed", async () => {
    const notADir = join(root, "file.txt");
    writeFileSync(notADir, "x");
    await expect(writeSessionBaseline(notADir, baseline, env)).rejects.toThrow();
    expect(projects()).toEqual([]);
  });

  test("a receipt that cannot be written never breaks the baseline write", async () => {
    // ~/.siltpoke is a regular file → the receipt's directory cannot be created.
    writeFileSync(join(home, ".siltpoke"), "not a directory");
    await writeSessionBaseline(repo, baseline, env);
    expect(existsSync(join(repo, ".siltpoke", "baseline.json"))).toBe(true);
  });
});

describe("resolveOrCaptureSessionHeadSha (late capture) → receipt.projects", () => {
  test("a repo whose per-session record is first written at Stop is listed too", () => {
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo });
    const err = console.error;
    console.error = () => {};
    try {
      expect(resolveOrCaptureSessionHeadSha(repo, "s9", env)).not.toBeNull();
    } finally {
      console.error = err;
    }
    expect(projects()).toEqual([repo]);
  });

  test("not a git repo → nothing written, nothing listed", () => {
    expect(resolveOrCaptureSessionHeadSha(repo, "s9", env)).toBeNull();
    expect(projects()).toEqual([]);
  });
});

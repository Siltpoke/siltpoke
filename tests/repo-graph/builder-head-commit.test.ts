// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `runIndexBuild` records HEAD at index time (`RepoGraphMeta.head_commit`) so
 * a later export can stamp which commit a map was built from (spec §4,
 * 2026-09-26). Absent outside a git repo — readers must treat undefined as
 * "unknown", never infer a commit from a timestamp.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexBuild } from "../../src/repo-graph/builder";
import { readMeta } from "../../src/repo-graph/store";

let tmp: string;
let repo: string;
let home: string;

const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
function commit(dir: string, name: string): string {
  writeFileSync(join(dir, name), name);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", name);
  return git(dir, "rev-parse", "HEAD");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-builder-head-"));
  repo = join(tmp, "repo");
  home = join(tmp, "home");
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("runIndexBuild — head_commit", () => {
  it("a git repo records HEAD at index time", async () => {
    const head = commit(repo, "a.ts");
    const r = await runIndexBuild({ cwd: repo, home });
    const meta = await readMeta(r.storage_dir);
    expect(meta?.head_commit).toBe(head);
  });

  it("a non-git folder records no head_commit (key absent)", async () => {
    const loose = join(tmp, "loose");
    mkdirSync(loose, { recursive: true });
    writeFileSync(join(loose, "a.ts"), "export const a = 1;\n");
    const r = await runIndexBuild({ cwd: loose, root: loose, home });
    const meta = await readMeta(r.storage_dir);
    expect(meta).not.toBeNull();
    expect("head_commit" in meta!).toBe(false);
  });
});

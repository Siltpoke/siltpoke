// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `runIndexBuild({ root })` indexes exactly that folder. Before this, the
 * builder always walked up from cwd to the enclosing repo, so a folder inside a
 * repo could not be indexed on its own (spec 2026-09-14 §4.1).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexBuild } from "../../src/repo-graph/builder";
import { computeProjHash } from "../../src/repo-graph/proj-hash";
import { readGraph, readMeta } from "../../src/repo-graph/store";

let tmp: string;
let repo: string;
let sub: string;
let home: string;

function write(abs: string, content: string): void {
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-builder-root-")));
  repo = join(tmp, "kata");
  sub = join(repo, "TypeScript");
  home = join(tmp, "home");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(home, { recursive: true });
  write(join(sub, "app", "gilded.ts"), "export function update(): number {\n  return 1;\n}\n");
  write(join(repo, "root.ts"), "export const outside = 2;\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const filePaths = async (storageDir: string): Promise<string[]> =>
  (await readGraph(storageDir)).nodes.filter((n) => n.type === "file").map((n) => n.path).sort();

describe("runIndexBuild — explicit root", () => {
  test("root given → only that folder is walked, stored under the folder's own hash", async () => {
    const r = await runIndexBuild({ cwd: repo, root: sub, home });
    expect(r.project_root).toBe(sub);
    expect(r.proj_hash).toBe(computeProjHash(sub));
    expect(await filePaths(r.storage_dir)).toEqual(["app/gilded.ts"]);
  });

  test("a folder inside a repo records repo_root; the repo root itself records none", async () => {
    const s = await runIndexBuild({ cwd: repo, root: sub, home });
    expect((await readMeta(s.storage_dir))?.repo_root).toBe(repo);

    const r = await runIndexBuild({ cwd: repo, home });
    const meta = await readMeta(r.storage_dir);
    expect(meta).not.toBeNull();
    expect("repo_root" in meta!).toBe(false);
  });

  test("a folder in no repo records no repo_root", async () => {
    const loose = join(tmp, "loose");
    write(join(loose, "a.ts"), "export const a = 1;\n");
    const r = await runIndexBuild({ cwd: loose, root: loose, home });
    expect("repo_root" in (await readMeta(r.storage_dir))!).toBe(false);
  });

  test("the repo index and the sub-folder index coexist; neither overwrites the other", async () => {
    const whole = await runIndexBuild({ cwd: repo, home });
    const part = await runIndexBuild({ cwd: repo, root: sub, home });
    expect(part.storage_dir).not.toBe(whole.storage_dir);
    expect(existsSync(whole.storage_dir)).toBe(true);
    expect(await filePaths(whole.storage_dir)).toEqual(["TypeScript/app/gilded.ts", "root.ts"]);
    expect(await filePaths(part.storage_dir)).toEqual(["app/gilded.ts"]);
  });
});

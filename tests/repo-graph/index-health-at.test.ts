// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `readIndexStalenessAt` reads the index at a KNOWN location. The cwd wrapper
 * resolves marker > git root first, which is right for a terminal and wrong for
 * a stored sub-folder root (spec 2026-09-14 §4.3).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexBuild } from "../../src/repo-graph/builder";
import { readIndexStaleness, readIndexStalenessAt } from "../../src/repo-graph/index-health";

/** A git repo with a 5-file sub-folder indexed ON ITS OWN (the repo root has
 * no index), then one sub-folder file edited → 1/5 = 20% = "stale". A reader
 * that walks the sub-folder up to the repo finds no index at all. */
async function staleSubfolderIndex(): Promise<{ home: string; repo: string; sub: string; hash: string; storageDir: string }> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "sp-home-")));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "sp-repo-")));
  const sub = join(repo, "pkg");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(sub, "src"), { recursive: true });
  for (const n of ["a", "b", "c", "d", "e"]) writeFileSync(join(sub, "src", `${n}.ts`), `export const ${n} = 1;\n`);
  const built = await runIndexBuild({ cwd: repo, root: sub, force: true, home });
  writeFileSync(join(sub, "src", "a.ts"), "export const a = 999;\n");
  return { home, repo, sub, hash: built.proj_hash, storageDir: built.storage_dir };
}

describe("readIndexStalenessAt", () => {
  test("reads the sub-folder's own index", async () => {
    const { home, sub, storageDir } = await staleSubfolderIndex();
    const s = await readIndexStalenessAt({ project_root: sub, storage_dir: storageDir, home });
    expect(s?.indexed).toBe(5);
    expect(s?.content_changed).toBe(1);
  });

  test("the cwd wrapper still walks up — from inside the sub-folder it finds the (unindexed) repo", async () => {
    const { home, sub } = await staleSubfolderIndex();
    expect(await readIndexStaleness({ cwd: sub, home })).toBeNull();
  });
});

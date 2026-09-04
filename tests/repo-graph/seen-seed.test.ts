// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Slice ③ Task 3 — seed `seen.json` at index time (spec §4, C2/C9 from the
 * plan's cross-family review).
 *
 * Real `runIndexBuild` + real fixtures throughout — no mocking of the
 * builder or store layer, so these exercise the actual seed hook wiring.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexBuild } from "../../src/repo-graph/builder";
import { resolveRepoGraphLocation } from "../../src/repo-graph/proj-hash";
import { readFingerprints, readSeen } from "../../src/repo-graph/store";

function repo(): { home: string; dir: string } {
  const home = mkdtempSync(join(tmpdir(), "sp-home-"));
  const dir = mkdtempSync(join(tmpdir(), "sp-repo-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "export const a=1;\n");
  return { home, dir };
}

describe("seen seed", () => {
  test("fresh index seeds seen=current (deep-equal), unknown_baseline false, baseline_sha null in a non-git dir", async () => {
    const { home, dir } = repo();
    try {
      await runIndexBuild({ cwd: dir, force: true, home });
      const { storage_dir } = resolveRepoGraphLocation(dir, { home });
      const s = await readSeen(storage_dir);
      const fp = await readFingerprints(storage_dir);

      expect(s.unknown_baseline).toBe(false);
      // C9: seeded seen.files must deep-equal the *current* fingerprints
      // (canonical keys), not merely be non-empty. Build the expected map
      // from the real fingerprints file the build just wrote and compare
      // the full structure — this would catch a seed that only copied
      // keys, or dropped/duplicated a file, or picked a stale snapshot.
      const expectedFiles: Record<string, { content_sha256: string; ast_sig: string }> = {};
      for (const [path, entry] of Object.entries(fp.files)) {
        expectedFiles[path] = { content_sha256: entry.content_sha256, ast_sig: entry.ast_sig };
      }
      expect(Object.keys(expectedFiles).length).toBeGreaterThan(0); // sanity: fixture actually indexed
      expect(s.files).toEqual(expectedFiles);

      // `dir` is a bare tmpdir, never `git init`-ed — best-effort baseline_sha
      // capture must degrade to null rather than throw / fail the build.
      expect(s.baseline_sha).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("existing index, no seen.json (upgrade) → unknown_baseline true, files empty (NOT seeded-to-current)", async () => {
    const { home, dir } = repo();
    try {
      await runIndexBuild({ cwd: dir, force: true, home }); // creates fingerprints + seeds seen.json
      const { storage_dir } = resolveRepoGraphLocation(dir, { home });

      // Simulate a slice-②-era index: delete seen.json, keep fingerprints,
      // re-index WITHOUT --force (the "up to date, no early return" path
      // this test also exercises — buildInner has no short-circuit before
      // the seed hook, confirmed by reading builder.ts).
      const fs = await import("node:fs/promises");
      await fs.rm(join(storage_dir, "seen.json"), { force: true });
      await runIndexBuild({ cwd: dir, force: false, home });

      const s = await readSeen(storage_dir);
      expect(s.unknown_baseline).toBe(true);
      expect(Object.keys(s.files).length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--force never mutates an existing seen.json", async () => {
    const { home, dir } = repo();
    try {
      await runIndexBuild({ cwd: dir, force: true, home });
      const { storage_dir } = resolveRepoGraphLocation(dir, { home });
      const before = JSON.stringify(await readSeen(storage_dir));

      writeFileSync(join(dir, "src", "a.ts"), "export const a=999;\n");
      await runIndexBuild({ cwd: dir, force: true, home }); // --force rebuild

      expect(JSON.stringify(await readSeen(storage_dir))).toBe(before); // unchanged
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fresh index in a REAL git repo captures baseline_sha as the HEAD sha", async () => {
    const home = mkdtempSync(join(tmpdir(), "sp-home-"));
    const dir = mkdtempSync(join(tmpdir(), "sp-repo-git-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.ts"), "export const a=1;\n");
      const run = (args: string[]): void => {
        const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
      };
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      run(["add", "."]);
      run(["commit", "-m", "init"]);
      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();

      await runIndexBuild({ cwd: dir, force: true, home });
      const { storage_dir } = resolveRepoGraphLocation(dir, { home });
      const s = await readSeen(storage_dir);

      expect(s.baseline_sha).toBe(head);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failing seed write never fails the (fresh) index build — index survives, seed just skipped", async () => {
    const { home, dir } = repo();
    try {
      const failingWriteSeen = async (): Promise<void> => {
        throw new Error("simulated disk-full / permission error on seen.json write");
      };

      // FRESH build (home is a brand-new tmpdir → preexisted === false), so
      // runIndexBuild's failure-cleanup path (if the seed write's error were
      // to propagate) would `rm -rf` the whole storage_dir. Before the fix,
      // an unwrapped `writeSeen` throw inside `seedSeenWatermark` would
      // reach that catch and wipe this build's own just-written
      // graph/fingerprints/queryIndex/meta — even though the build itself
      // succeeded. Injecting the failure via `__seedWriteSeenOverride`
      // (test-only seam, builder.ts) exercises the REAL runIndexBuild path,
      // not just seedSeenWatermark in isolation.
      const result = await runIndexBuild({
        cwd: dir,
        force: true,
        home,
        __seedWriteSeenOverride: failingWriteSeen,
      });

      // (a) runIndexBuild still RESOLVES successfully.
      expect(result.proj_hash).toBeTruthy();

      const { storage_dir } = resolveRepoGraphLocation(dir, { home });
      // (b) the index was NOT wiped — its artifacts still exist on disk.
      expect(existsSync(join(storage_dir, "fingerprints.json"))).toBe(true);
      expect(existsSync(join(storage_dir, "graph.json"))).toBe(true);
      expect(existsSync(join(storage_dir, "meta.json"))).toBe(true);

      // The seed itself was skipped (write failed) — seen.json absent, not
      // partially/corruptly written.
      expect(existsSync(join(storage_dir, "seen.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("seedSeenWatermark itself never throws when the injected write fails (unit-level backstop)", async () => {
    const { home, dir } = repo();
    try {
      await runIndexBuild({ cwd: dir, force: true, home }); // fresh build + normal seed
      const { storage_dir } = resolveRepoGraphLocation(dir, { home });

      // Delete the just-seeded seen.json so seedSeenWatermark's own
      // existence guard doesn't short-circuit before reaching the write.
      const fs = await import("node:fs/promises");
      await fs.rm(join(storage_dir, "seen.json"), { force: true });

      const { seedSeenWatermark } = await import("../../src/repo-graph/seen-seed");
      const failingWriteSeen = async (): Promise<void> => {
        throw new Error("simulated write failure");
      };

      // Direct unit call — proves the swallow lives in seedSeenWatermark
      // itself, independent of the runIndexBuild wiring exercised above.
      await expect(
        seedSeenWatermark(storage_dir, dir, /* hadPriorIndexBeforeBuild */ false, failingWriteSeen),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

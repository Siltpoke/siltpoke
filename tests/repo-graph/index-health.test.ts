/**
 * Index staleness — the metric that costs ~1s and nobody was computing.
 *
 * siltpoke's own index was last built 2026-07-09 while HEAD was 140
 * commits further on: 149/589 files content-changed (25.3%), 2 deleted files
 * still in the index, 82 `src/*.ts(x)` never indexed at all. Every number is
 * derivable from the `fingerprints.json` that already exists plus a walk — no
 * labels, no API calls.
 * Source: an internal design note §1.5
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStaleness, readIndexStaleness } from "../../src/repo-graph/index-health";
import { runIndexBuild } from "../../src/repo-graph/builder";

const fp = (entries: Record<string, string>) =>
  Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { content_sha256: v, ast_sig: "sig" }]));

describe("computeStaleness", () => {
  test("an index matching the working tree is not stale", () => {
    const s = computeStaleness(fp({ "a.ts": "sha-a", "b.ts": "sha-b" }), [
      { relPath: "a.ts", contentSha: "sha-a" },
      { relPath: "b.ts", contentSha: "sha-b" },
    ]);

    expect(s.indexed).toBe(2);
    expect(s.unchanged).toBe(2);
    expect(s.content_changed).toBe(0);
    expect(s.content_stale_pct).toBe(0);
  });

  test("a file whose content changed since indexing counts as stale", () => {
    const s = computeStaleness(fp({ "a.ts": "sha-a", "b.ts": "sha-b" }), [
      { relPath: "a.ts", contentSha: "sha-a-NEW" },
      { relPath: "b.ts", contentSha: "sha-b" },
    ]);

    expect(s.content_changed).toBe(1);
    expect(s.unchanged).toBe(1);
    expect(s.content_stale_pct).toBe(0.5);
  });

  test("a file still in the index but gone from disk is reported separately", () => {
    // Distinct from "changed": nothing to re-parse, the row is simply wrong.
    const s = computeStaleness(fp({ "a.ts": "sha-a", "gone.ts": "sha-g" }), [
      { relPath: "a.ts", contentSha: "sha-a" },
    ]);

    expect(s.deleted_still_indexed).toBe(1);
    expect(s.content_changed).toBe(0);
  });

  test("a source file on disk that was never indexed is reported separately", () => {
    // The 82-file case: not stale data, MISSING data — invisible to any
    // metric that only walks what the index already knows about.
    const s = computeStaleness(fp({ "a.ts": "sha-a" }), [
      { relPath: "a.ts", contentSha: "sha-a" },
      { relPath: "never.ts", contentSha: "sha-n" },
    ]);

    expect(s.unindexed_files).toBe(1);
    expect(s.indexed).toBe(1);
  });

  test("content_stale_pct divides by the indexed count, not by the number of files on disk", () => {
    // Pins the semantic choice, and is the only shape that can catch a swapped
    // denominator: 2 indexed, 3 on disk, 1 changed. Over indexed → 0.5; over
    // files-on-disk → 0.333. Every other case here has the two counts equal,
    // so both readings agree and the bug hides.
    const s = computeStaleness(fp({ "a.ts": "sha-a", "b.ts": "sha-b" }), [
      { relPath: "a.ts", contentSha: "sha-a-NEW" },
      { relPath: "b.ts", contentSha: "sha-b" },
      { relPath: "never.ts", contentSha: "sha-n" },
    ]);

    expect(s.indexed).toBe(2);
    expect(s.content_changed).toBe(1);
    expect(s.unindexed_files).toBe(1);
    expect(s.content_stale_pct).toBe(0.5);
  });

  test("an empty index reports 0, not NaN", () => {
    // content_stale_pct divides by the indexed count; an empty index must not produce
    // NaN, which would render as "NaN% stale" and compare false against every
    // threshold.
    const s = computeStaleness({}, []);

    expect(s.content_stale_pct).toBe(0);
    expect(Number.isNaN(s.content_stale_pct)).toBe(false);
  });

  test("an empty index with files on disk reports them all as unindexed", () => {
    const s = computeStaleness({}, [{ relPath: "a.ts", contentSha: "sha-a" }]);

    expect(s.unindexed_files).toBe(1);
    expect(s.content_stale_pct).toBe(0);
  });
});

describe("readIndexStaleness — against a real index on disk", () => {
  let tmp: string;
  let projectRoot: string;
  let home: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "siltpoke-staleness-"));
    projectRoot = join(tmp, "proj");
    home = join(tmp, "home");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const seed = (rel: string, content: string) => writeFileSync(join(projectRoot, rel), content);

  test("a freshly built index reads as not stale", async () => {
    seed("src/a.ts", `export function a() { return 1; }`);
    await runIndexBuild({ cwd: projectRoot, home });

    const s = await readIndexStaleness({ cwd: projectRoot, home });

    expect(s).not.toBeNull();
    expect(s!.content_stale_pct).toBe(0);
    expect(s!.content_changed).toBe(0);
    expect(s!.unindexed_files).toBe(0);
  });

  test("editing an indexed file after the build shows up as stale", async () => {
    seed("src/a.ts", `export function a() { return 1; }`);
    await runIndexBuild({ cwd: projectRoot, home });

    seed("src/a.ts", `export function a() { return 999; }`);
    const s = await readIndexStaleness({ cwd: projectRoot, home });

    expect(s!.content_changed).toBe(1);
    expect(s!.content_stale_pct).toBe(1);
  });

  test("a file added after the build shows up as never indexed", async () => {
    seed("src/a.ts", `export function a() { return 1; }`);
    await runIndexBuild({ cwd: projectRoot, home });

    seed("src/added.ts", `export function added() { return 2; }`);
    const s = await readIndexStaleness({ cwd: projectRoot, home });

    expect(s!.unindexed_files).toBe(1);
    expect(s!.content_changed).toBe(0);
    // Never-indexed files are NOT stale content — they must not inflate content_stale_pct.
    expect(s!.content_stale_pct).toBe(0);
  });

  test("a file deleted after the build is reported as still indexed", async () => {
    seed("src/a.ts", `export function a() { return 1; }`);
    seed("src/b.ts", `export function b() { return 2; }`);
    await runIndexBuild({ cwd: projectRoot, home });

    rmSync(join(projectRoot, "src/b.ts"));
    const s = await readIndexStaleness({ cwd: projectRoot, home });

    expect(s!.deleted_still_indexed).toBe(1);
  });

  test("a project that was never indexed returns null, not zeroes", async () => {
    // Distinguishable from "indexed and perfectly fresh" — which also reports
    // 0 everywhere. A caller must be able to tell "no index" from "clean index".
    seed("src/a.ts", `export function a() { return 1; }`);

    expect(await readIndexStaleness({ cwd: projectRoot, home })).toBeNull();
  });
});

describe("computeStaleness — the percentage must not hide whole classes of drift", () => {
  test("an index whose files were ALL deleted is 0% content-stale but 100% wrong", () => {
    // The trap the old name `stale_pct` set: content-staleness alone cannot see
    // deletions, yet "2 deleted files still indexed" is one of the three drift
    // signals this module exists to surface. A threshold consumer reaching for
    // the one percentage field would have missed it entirely.
    const s = computeStaleness(fp({ "a.ts": "sha-a", "b.ts": "sha-b", "c.ts": "sha-c" }), []);

    expect(s.deleted_still_indexed).toBe(3);
    expect(s.content_stale_pct).toBe(0);
    expect(s.rows_wrong_pct).toBe(1);
  });

  test("rows_wrong_pct counts changed AND deleted rows together", () => {
    const s = computeStaleness(fp({ "a.ts": "sha-a", "b.ts": "sha-b", "c.ts": "sha-c", "d.ts": "sha-d" }), [
      { relPath: "a.ts", contentSha: "sha-a" },
      { relPath: "b.ts", contentSha: "sha-b-NEW" },
    ]);

    expect(s.content_changed).toBe(1);
    expect(s.deleted_still_indexed).toBe(2);
    expect(s.content_stale_pct).toBe(0.25);
    expect(s.rows_wrong_pct).toBe(0.75);
  });

  test("both percentages are 0, not NaN, on an empty index", () => {
    const s = computeStaleness({}, []);
    expect(s.content_stale_pct).toBe(0);
    expect(s.rows_wrong_pct).toBe(0);
    expect(Number.isNaN(s.rows_wrong_pct)).toBe(false);
  });
});

describe("computeStaleness — path keying", () => {
  test("the same filename in NFC and NFD form is one file, not a deletion plus an addition", () => {
    // macOS hands out NFD from the filesystem while git and most editors write
    // NFC. Comparing raw strings turns one untouched file into two separate
    // 'problems' — a phantom deletion and a phantom never-indexed file.
    const nfc = "src/café.ts".normalize("NFC");
    const nfd = "src/café.ts".normalize("NFD");
    expect(nfc).not.toBe(nfd); // guard: the fixture is actually testing something

    const s = computeStaleness(fp({ [nfc]: "sha-x" }), [{ relPath: nfd, contentSha: "sha-x" }]);

    expect(s.unchanged).toBe(1);
    expect(s.deleted_still_indexed).toBe(0);
    expect(s.unindexed_files).toBe(0);
  });
});

describe("readIndexStaleness — an unreadable file is not a deleted file", () => {
  let tmp2: string;
  let root2: string;
  let home2: string;

  beforeEach(() => {
    tmp2 = mkdtempSync(join(tmpdir(), "siltpoke-staleness-io-"));
    root2 = join(tmp2, "proj");
    home2 = join(tmp2, "home");
    mkdirSync(join(root2, "src"), { recursive: true });
    mkdirSync(home2, { recursive: true });
  });

  afterEach(() => rmSync(tmp2, { recursive: true, force: true }));

  test("a file that cannot be read is counted as a read error, not as deleted", async () => {
    // #360's lesson, one layer over: "I can't see it" is not "it's gone." A
    // permission error, an EBUSY from another process mid-write, or any
    // transient I/O failure would otherwise be laundered into
    // `deleted_still_indexed` — the exact reasoning that let chat search
    // prune live sessions.
    writeFileSync(join(root2, "src/a.ts"), `export function a() { return 1; }`);
    await runIndexBuild({ cwd: root2, home: home2 });
    // No mtime fast-path anymore (removed R13, 2026-07-26) — every walked file
    // is always re-read, so this mtime bump is no longer load-bearing for
    // reaching the injected `readFileFn` failure below. Left in place: it's
    // harmless and matches how a real edit would look.
    const future = Date.now() / 1000 + 60;
    utimesSync(join(root2, "src/a.ts"), future, future);

    const s = await readIndexStaleness({
      cwd: root2,
      home: home2,
      readFileFn: async () => {
        throw new Error("EACCES: permission denied");
      },
    });

    expect(s!.read_errors).toBe(1);
    expect(s!.deleted_still_indexed).toBe(0);
    expect(s!.unchanged).toBe(0);
  });

  test("read errors do not inflate either percentage", async () => {
    writeFileSync(join(root2, "src/a.ts"), `export function a() { return 1; }`);
    await runIndexBuild({ cwd: root2, home: home2 });
    // Same non-load-bearing note as above: no fast-path to defeat anymore.
    const future = Date.now() / 1000 + 60;
    utimesSync(join(root2, "src/a.ts"), future, future);

    const s = await readIndexStaleness({
      cwd: root2,
      home: home2,
      readFileFn: async () => {
        throw new Error("EBUSY");
      },
    });

    expect(s!.content_stale_pct).toBe(0);
    expect(s!.rows_wrong_pct).toBe(0);
  });
});

describe("readIndexStaleness — no mtime fast-path (R13, deferred)", () => {
  test("an edited file is caught as content_changed even when its mtime is BEFORE the index time", async () => {
    // R13's mtime fast-path (removed 2026-07-26) skipped the re-hash whenever
    // `mtimeMs <= indexTimeMs` — a MILLISECOND-precise wall clock. On a
    // filesystem with coarser mtime granularity (CI's tmpfs), a file edited
    // shortly after indexing floors to an mtime that reads <= the index time,
    // so the genuine edit was silently skipped. This test pins the fix: with
    // no fast-path, a real content change is caught regardless of what the
    // mtime says — even artificially rolled back to BEFORE the index time,
    // which is exactly the shape of the coarse-fs failure.
    const tmp = mkdtempSync(join(tmpdir(), "siltpoke-staleness-nomtime-"));
    const root = join(tmp, "proj");
    const home = join(tmp, "home");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(home, { recursive: true });
    try {
      writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
      await runIndexBuild({ cwd: root, home });

      writeFileSync(join(root, "src/a.ts"), "export const a = 999;\n"); // real edit
      const past = Date.now() / 1000 - 3600;
      utimesSync(join(root, "src/a.ts"), past, past); // roll mtime BEFORE index time

      const s = await readIndexStaleness({ cwd: root, home });
      expect(s?.content_changed).toBe(1);
      expect(s?.unchanged).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

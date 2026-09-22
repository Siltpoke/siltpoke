// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * What `diffHunks` adds over the `diffSides` it replaced: which file a hunk
 * belongs to, where it starts in that file, and how many earlier blocks in the
 * corpus carried the same file.
 *
 * The 20 tests in `evidence-guard-diff-sides.test.ts` pin that the SIDES are
 * unchanged, and they pass by construction if the parse is unchanged — so they
 * say nothing about the three new fields. These do. Both files are needed:
 * one guards the old behaviour, one measures the new.
 */
import { describe, expect, test } from "bun:test";
import { diffHunks } from "../../src/critic/corpus-hunks";

/** A file block as git writes it: `diff --git`, then the `---`/`+++` pair. */
function block(oldPath: string, newPath: string, ...body: string[]): string[] {
  return [
    `diff --git a/${oldPath === "/dev/null" ? newPath : oldPath} b/${newPath === "/dev/null" ? oldPath : newPath}`,
    "index 1111111..2222222 100644",
    oldPath === "/dev/null" ? "--- /dev/null" : `--- a/${oldPath}`,
    newPath === "/dev/null" ? "+++ /dev/null" : `+++ b/${newPath}`,
    ...body,
  ];
}

describe("diffHunks — file attribution", () => {
  test("a modified file gives both paths, prefixes stripped", () => {
    const corpus = block("src/a.ts", "src/a.ts", "@@ -10,1 +10,2 @@", " ctx", "+added").join("\n");
    const hunks = diffHunks(corpus).hunks;
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.oldFile).toBe("src/a.ts");
    expect(hunks[0]!.file).toBe("src/a.ts");
  });

  test("an ADDED file has no old path", () => {
    const corpus = block("/dev/null", "src/new.ts", "@@ -0,0 +1,2 @@", "+one", "+two").join("\n");
    const hunks = diffHunks(corpus).hunks;
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.oldFile).toBeNull();
    expect(hunks[0]!.file).toBe("src/new.ts");
  });

  /**
   * The bug `run-git-diff.ts` has and this parser must not: there, the filename
   * is only ever set from `+++ b/(.+)`, so a deleted file's `+++ /dev/null`
   * leaves the PREVIOUS file's name in place and the hunk is filed under it.
   */
  test("a DELETED file has no new path, and its hunk is still emitted", () => {
    const corpus = [
      ...block("src/a.ts", "src/a.ts", "@@ -1,1 +1,1 @@", "-old", "+new"),
      ...block("src/gone.ts", "/dev/null", "@@ -1,2 +0,0 @@", "-removed one", "-removed two"),
    ].join("\n");
    const hunks = diffHunks(corpus).hunks;
    expect(hunks).toHaveLength(2);
    expect(hunks[1]!.oldFile).toBe("src/gone.ts");
    expect(hunks[1]!.file).toBeNull();
    // Still carries its text: dropping it would shrink what the citation
    // checks see and silently refuse quotes of deleted code.
    expect(hunks[1]!.before).toBe("removed one\nremoved two");
  });

  test("a RENAMED-with-edits file carries both names", () => {
    const corpus = block("src/old-name.ts", "src/new-name.ts", "@@ -3,1 +3,2 @@", " ctx", "+added").join("\n");
    const hunks = diffHunks(corpus).hunks;
    expect(hunks[0]!.oldFile).toBe("src/old-name.ts");
    expect(hunks[0]!.file).toBe("src/new-name.ts");
  });
});

describe("diffHunks — newStart", () => {
  test("the `+` side's start position is read from the header", () => {
    const corpus = block("src/a.ts", "src/a.ts", "@@ -10,1 +42,2 @@", " ctx", "+added").join("\n");
    expect(diffHunks(corpus).hunks[0]!.newStart).toBe(42);
  });

  test("an omitted count does not shift the start position", () => {
    // `@@ -1 +7 @@` — both counts omitted, which means 1 each.
    const corpus = block("src/a.ts", "src/a.ts", "@@ -1 +7 @@", " only").join("\n");
    const hunks = diffHunks(corpus).hunks;
    expect(hunks[0]!.newStart).toBe(7);
    expect(hunks[0]!.after).toBe("only");
  });
});

describe("diffHunks — blockIndex", () => {
  test("two different files each start at 0", () => {
    const corpus = [
      ...block("src/a.ts", "src/a.ts", "@@ -1,1 +1,2 @@", " ctx", "+a"),
      ...block("src/b.ts", "src/b.ts", "@@ -1,1 +1,2 @@", " ctx", "+b"),
    ].join("\n");
    const hunks = diffHunks(corpus).hunks;
    expect(hunks.map((h) => h.blockIndex)).toEqual([0, 0]);
  });

  test("two hunks of ONE block share its index", () => {
    const corpus = block(
      "src/a.ts",
      "src/a.ts",
      "@@ -1,1 +1,2 @@",
      " ctx",
      "+a",
      "@@ -20,1 +21,2 @@",
      " ctx2",
      "+b",
    ).join("\n");
    const hunks = diffHunks(corpus).hunks;
    expect(hunks).toHaveLength(2);
    expect(hunks.map((h) => h.blockIndex)).toEqual([0, 0]);
  });

  /**
   * The recent-commits shape: three commits' diffs concatenated with their
   * commit headers stripped, newest first. One file touched twice appears
   * twice, and only the first block's line numbers can be true of the file
   * as it stands now.
   */
  test("the same file twice gives 0 then 1", () => {
    const corpus = [
      ...block("src/a.ts", "src/a.ts", "@@ -10,1 +10,2 @@", " ctx", "+newest"),
      ...block("src/a.ts", "src/a.ts", "@@ -4,1 +4,2 @@", " ctx", "+older"),
    ].join("\n");
    const hunks = diffHunks(corpus).hunks;
    expect(hunks.map((h) => h.blockIndex)).toEqual([0, 1]);
    expect(hunks.map((h) => h.newStart)).toEqual([10, 4]);
  });
});

describe("diffHunks — text that is shaped like a file header but is not one", () => {
  /**
   * Both of these are in every corpus by construction (`buildToolOutputSection`
   * and `buildRaw`), and both start `--- `. `changed-functions.ts` would open a
   * file record on either; requiring the `---`/`+++` PAIR is what stops it.
   */
  /**
   * The discriminating case, and the reason the test below it is not enough on
   * its own: there, the separator is followed by another `--- ` line, so the
   * `---`/`+++` PAIR rule already refuses it and the exact-match exclusion never
   * fires — remove the exclusion and that test still passes. Here the separator
   * IS directly above a `+++ ` line, so the pair rule alone would accept it and
   * only the exclusion says no. Without it, `oldFile` becomes
   * `"corpus separator ---"` and the hunk is filed under `src/fake.ts`.
   *
   * `file: null` is the right answer, not a shortcoming: a `+++ ` line whose
   * `--- ` partner is siltpoke's own text names no file we can trust, and an
   * unknown file yields no line range rather than a confident wrong one.
   */
  test("a `+++ ` directly under the corpus separator names no file", () => {
    const corpus = [
      "--- corpus separator ---",
      "+++ b/src/fake.ts",
      "@@ -1,1 +1,1 @@",
      " ctx",
    ].join("\n");
    const hunks = diffHunks(corpus).hunks;
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.file).toBeNull();
    expect(hunks[0]!.oldFile).toBeNull();
  });

  test("the corpus separator does not open a file block", () => {
    const corpus = [
      ...block("src/a.ts", "src/a.ts", "@@ -1,1 +1,2 @@", " ctx", "+a"),
      "--- corpus separator ---",
      "--- stderr ---",
      ...block("src/b.ts", "src/b.ts", "@@ -1,1 +1,2 @@", " ctx", "+b"),
    ].join("\n");
    const hunks = diffHunks(corpus).hunks;
    expect(hunks.map((h) => h.file)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  /**
   * The sibling of `evidence-guard-diff-sides.test.ts`'s "a removed line that
   * happens to read `-- ` is still code", asserted on the new field rather than
   * on the verdict: a removed SQL comment renders as `--- x`, and if that were
   * read as a file header the hunk after it would be filed under a file that
   * does not exist.
   */
  test("a removed line reading `-- ` does not open a file block", () => {
    const corpus = block(
      "src/a.ts",
      "src/a.ts",
      "@@ -1,2 +1,1 @@",
      "--- drop the index first",
      "-DROP INDEX idx_users;",
      "+kept",
    ).join("\n");
    const hunks = diffHunks(corpus).hunks;
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.file).toBe("src/a.ts");
    expect(hunks[0]!.before).toBe("-- drop the index first\nDROP INDEX idx_users;");
  });
});

/**
 * The file events that produce NO hunk, and so are invisible to any scan over
 * hunks. Both leave a path whose most recent fate is "gone", and a line number
 * derived for that path from an older block points into a file that is not
 * there.
 */
describe("diffHunks — moves that leave no hunk behind", () => {
  /**
   * Verified against this repo's own history (`git show 40058a29`): a
   * 100%-similarity rename writes `diff --git`, `similarity index 100%`,
   * `rename from` and `rename to`, and NOTHING else. No `---`, no `+++`,
   * no `@@`.
   */
  test("a pure rename is recorded even though it contributes no hunk", () => {
    const corpus = [
      "diff --git a/src/pay.ts b/src/payment.ts",
      "similarity index 100%",
      "rename from src/pay.ts",
      "rename to src/payment.ts",
    ].join("\n");
    const parsed = diffHunks(corpus);
    expect(parsed.hunks).toHaveLength(0);
    expect([...parsed.movedAway]).toEqual(["src/pay.ts"]);
  });

  test("deleting a file records the name it had", () => {
    const corpus = block("src/gone.ts", "/dev/null", "@@ -1,1 +0,0 @@", "-x();").join("\n");
    expect([...diffHunks(corpus).movedAway]).toEqual(["src/gone.ts"]);
  });

  test("a rename WITH edits records the old name too", () => {
    const corpus = block("src/old.ts", "src/new.ts", "@@ -1,1 +1,2 @@", " ctx", "+added").join("\n");
    expect([...diffHunks(corpus).movedAway]).toEqual(["src/old.ts"]);
  });

  test("an ordinary modification records nothing", () => {
    const corpus = block("src/a.ts", "src/a.ts", "@@ -1,1 +1,2 @@", " ctx", "+added").join("\n");
    expect([...diffHunks(corpus).movedAway]).toEqual([]);
  });

  /**
   * A removed source line whose text happens to read `rename from x` arrives as
   * `-rename from x`, and a context one as ` rename from x`. Neither starts at
   * column zero, and the inner hunk-body loop consumes both before the outer
   * scan sees them.
   */
  test("`rename from` inside a hunk body is code, not a file event", () => {
    const corpus = block(
      "src/docs.ts",
      "src/docs.ts",
      "@@ -1,2 +1,1 @@",
      "-rename from src/somewhere.ts",
      " kept();",
    ).join("\n");
    expect([...diffHunks(corpus).movedAway]).toEqual([]);
  });
});

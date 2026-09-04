// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIndexStaleness } from "../../src/repo-graph/index-health";
import { runIndexBuild } from "../../src/repo-graph/builder";

describe("readIndexStaleness — realpath canonicalization", () => {
  test("fresh index accessed via a symlinked root reports 0 drift", async () => {
    const home = mkdtempSync(join(tmpdir(), "sp-home-"));
    // Canonicalize the build root itself: on macOS, os.tmpdir() already sits
    // behind a /var -> /private/var symlink, so an un-canonicalized mkdtemp
    // path would introduce a SECOND, incidental symlink-form mismatch on the
    // build side too (unrelated to the one this test targets) and mask the
    // signal. Canonicalizing here isolates the test to exactly one variable:
    // the CHECK side is reached through a symlink, the build side is not.
    const real = realpathSync(mkdtempSync(join(tmpdir(), "sp-repo-")));
    mkdirSync(join(real, "src"));
    writeFileSync(join(real, "src", "a.ts"), "export const a = 1;\n");
    await runIndexBuild({ cwd: real, force: true, home });
    // A symlink to the same repo — its realpath differs from the link path.
    const link = mkdtempSync(join(tmpdir(), "sp-link-")) + "-ln";
    symlinkSync(real, link);
    const s = await readIndexStaleness({ cwd: link, home });
    expect(s).not.toBeNull();
    expect(s?.deleted_still_indexed).toBe(0);
    expect(s?.unindexed_files).toBe(0);
    expect(s?.content_changed).toBe(0);
  });

  test("a never-indexed repo accessed via a symlinked root still returns null", async () => {
    // Locks in the retry branch's safety property: the primary (raw-cwd) lookup
    // comes up empty, so the retry fires and recomputes storage_dir from the
    // realpath'd root — but that canonical location was ALSO never built, so
    // `canonicalFingerprints.files` is empty too, and the function must still
    // return `null` rather than a "0 indexed, fresh-looking" staleness object.
    // Verified by mutation: removing the inner
    // `if (Object.keys(canonicalFingerprints.files).length > 0)` guard alone
    // does NOT fail this test (the shared "still empty -> null" check right
    // after the retry block catches it too — it's the real backstop). But a
    // refactor that short-circuits the retry branch to `return` early once a
    // *different* canonical root was found — trusting "we resolved a canonical
    // alias" as "the repo is indexed", skipping that shared check — DOES break
    // this test: `readIndexStaleness` then returns
    // `{indexed:0, unindexed_files:0, ...}` (non-null) instead of `null` for a
    // genuinely never-indexed repo. That is exactly the "silently masked as
    // indexed" regression this test exists to catch — no other test in this
    // suite exercises "retry fires AND still finds nothing."
    const home = mkdtempSync(join(tmpdir(), "sp-home-"));
    const real = realpathSync(mkdtempSync(join(tmpdir(), "sp-repo-never-")));
    mkdirSync(join(real, "src"));
    writeFileSync(join(real, "src", "a.ts"), "export const a = 1;\n");
    // Deliberately no runIndexBuild call — `real` is never indexed.
    const link = mkdtempSync(join(tmpdir(), "sp-link-never-")) + "-ln";
    symlinkSync(real, link);
    const s = await readIndexStaleness({ cwd: link, home });
    expect(s).toBeNull();
  });
});

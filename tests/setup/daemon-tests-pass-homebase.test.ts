// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Every `startDaemon` call under `tests/` must pass an explicit `homeBase`.
 *
 * WHY — this is damage that already happened, not hygiene. `startDaemon` falls
 * back to `siltpokeRoot()` when `homeBase` is omitted
 * (`src/daemon/server.ts`), which is the developer's real `~/.siltpoke`. Four
 * call sites in `tests/daemon/server.test.ts` omitted it. That was harmless
 * only while everything those daemons touched was additive.
 *
 * It stopped being harmless when trace retention was repaired: the sweep now
 * runs synchronously at boot and deletes. On 2026-08-23 a single
 * `bun run ci:local` evicted ~1.4 GB from the author's real
 * `~/.siltpoke/traces` — 13 span files and 49 spillover day-directories going
 * back to 2026-05-21, the corpus behind
 * an internal design note, which the author had
 * explicitly asked to keep. There were no backups, and nothing went red.
 *
 * WHY THIS SHAPE, and not a `SILTPOKE_HOME` preload — that was tried first and
 * reverted. Redirecting the env var process-wide broke 13 existing tests,
 * because this repo already isolates by INJECTING a home (`configure(opts,
 * home)` at `src/cli/configure.ts:321` deliberately honours `SILTPOKE_HOME`
 * over its `home` argument, and says so in a comment). A global override wins
 * against that convention and silently relocates tests that were already
 * correctly isolated. So the guard enforces the convention the repo actually
 * has, instead of installing a second one that fights it.
 *
 * This reads the test sources as text. That is the point: it covers files that
 * do not exist yet, which a per-file assertion cannot.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { join, relative } from "node:path";

const TESTS_DIR = join(import.meta.dir, "..");

interface CallSite {
  file: string;
  line: number;
}

/**
 * Find every `startDaemon({ … })` call in the test tree that has no `homeBase`
 * key, skipping matches inside block comments (several test headers quote the
 * call shape in prose).
 */
function callSitesMissingHomeBase(): CallSite[] {
  const found: CallSite[] = [];
  const glob = new Glob("**/*.ts");

  for (const rel of glob.scanSync({ cwd: TESTS_DIR })) {
    const abs = join(TESTS_DIR, rel);
    const lines = readFileSync(abs, "utf8").split("\n");

    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();

      // Track /* … */ regions, and skip ` * ` continuation lines.
      if (trimmed.startsWith("/*")) inBlockComment = true;
      const wasComment = inBlockComment || trimmed.startsWith("*") || trimmed.startsWith("//");
      if (trimmed.includes("*/")) inBlockComment = false;
      if (wasComment) continue;

      if (!line.includes("startDaemon({")) continue;

      // Walk to the matching close brace of the object literal.
      let depth = 0;
      const block: string[] = [];
      for (let j = i; j < Math.min(i + 60, lines.length); j++) {
        const cur = lines[j] ?? "";
        block.push(cur);
        depth += (cur.match(/\{/g) ?? []).length - (cur.match(/\}/g) ?? []).length;
        if (depth <= 0 && j > i) break;
      }

      if (!block.join("\n").includes("homeBase")) {
        found.push({ file: relative(TESTS_DIR, abs), line: i + 1 });
      }
    }
  }
  return found;
}

describe("test-suite isolation — daemons must not boot against the real ~/.siltpoke", () => {
  test("every startDaemon call under tests/ passes an explicit homeBase", () => {
    const missing = callSitesMissingHomeBase();
    const rendered = missing.map((m) => `tests/${m.file}:${m.line}`).join("\n  ");
    expect(
      rendered,
      "startDaemon without homeBase falls back to the REAL ~/.siltpoke, whose traces " +
        "the boot-time retention sweep deletes. Pass homeBase: <a mkdtemp dir>.",
    ).toBe("");
  });

  test("the scanner can actually see a violation (it is not vacuously empty)", () => {
    // A guard that reports "0 violations" because it found nothing to look at
    // is indistinguishable from a clean tree. Pin that it parses real calls: at
    // least one compliant call site exists and is NOT reported.
    const glob = new Glob("**/*.ts");
    let compliantCalls = 0;
    for (const rel of glob.scanSync({ cwd: TESTS_DIR })) {
      const src = readFileSync(join(TESTS_DIR, rel), "utf8");
      if (src.includes("startDaemon({") && src.includes("homeBase")) compliantCalls++;
    }
    expect(compliantCalls).toBeGreaterThan(0);
    expect(callSitesMissingHomeBase().length).toBe(0);
  });
});

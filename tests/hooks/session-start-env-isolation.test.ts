// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Invariant: no test may call handleSessionStart without an isolated env.
//
// `handleSessionStart` resolves `input.env ?? process.env`
// (src/hooks/handle-session-start.ts), so a call that omits `env` runs against
// the REAL machine environment. Since defect [25] that function also refreshes
// `${HOME}/.siltpoke/bin/*.sh`, which turns the omission from "reads the wrong
// env" into "writes the developer's live install".
//
// This is not hypothetical and it is not a near-miss. Measured 2026-09-23:
// two calls in tests/hooks/handle-session-start.test.ts passed no `env`, and a
// `bun test` run overwrote the maintainer's real ~/.siltpoke/bin/statusline.sh
// and daemon.sh (timestamps moved from 2026-08-13 and 2026-07-14 to that day).
// The content happened to be the correct current text, so nothing broke — the
// write was still unauthorised, and the very file it happened in claims in its
// header that "every test in this file uses an isolated tmp HOME (never the
// real machine HOME)" and cites an EARLIER incident of the same kind.
//
// A guard is cheaper than remembering. It scans source rather than behaviour on
// purpose: the failure mode is a call site that looks fine and silently reaches
// outside the sandbox, which no per-test assertion would notice.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

const TESTS_DIR = new URL("..", import.meta.url).pathname;

/** Every `handleSessionStart({ … })` call in the test tree, with its argument text. */
function callSites(): Array<{ where: string; arg: string }> {
  const out: Array<{ where: string; arg: string }> = [];
  for (const rel of new Glob("**/*.ts").scanSync(TESTS_DIR)) {
    if (rel.endsWith("session-start-env-isolation.test.ts")) continue; // this file
    const src = readFileSync(`${TESTS_DIR}${rel}`, "utf8");
    for (const m of src.matchAll(/handleSessionStart\(\s*\{/g)) {
      const open = src.indexOf("{", m.index!);
      let depth = 0;
      let end = open;
      while (end < src.length) {
        if (src[end] === "{") depth++;
        else if (src[end] === "}" && --depth === 0) break;
        end++;
      }
      const line = src.slice(0, m.index!).split("\n").length;
      out.push({ where: `${rel}:${line}`, arg: src.slice(open, end + 1) });
    }
  }
  return out;
}

describe("handleSessionStart is never called against the real environment", () => {
  test("the scan finds call sites at all — otherwise the check below is vacuous", () => {
    // Without this, deleting every test in the tree would make the invariant
    // "pass" by having nothing to check.
    expect(callSites().length).toBeGreaterThan(10);
  });

  test("every call passes an explicit env", () => {
    const naked = callSites()
      .filter((c) => !/\benv\b/.test(c.arg))
      .map((c) => c.where);
    expect(naked).toEqual([]);
  });

  test("no call hands it the real process env wholesale", () => {
    // `env: process.env` defeats the point as thoroughly as omitting it. A
    // spread that then overrides HOME (`{ ...process.env, HOME: tmp }`) is
    // fine and common, so only the bare form is rejected.
    const bare = callSites()
      .filter((c) => /env:\s*process\.env\b/.test(c.arg))
      .map((c) => c.where);
    expect(bare).toEqual([]);
  });

  test("the matcher can actually see a bad call (positive control)", () => {
    // Proves the two assertions above would fire, rather than passing because
    // the regexes never match anything.
    const naked = "{ cwd: dir, session_id: \"x\" }";
    const bare = "{ cwd: dir, session_id: \"x\", env: process.env }";
    expect(/\benv\b/.test(naked)).toBe(false);
    expect(/env:\s*process\.env\b/.test(bare)).toBe(true);
  });
});

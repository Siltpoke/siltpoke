// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect `[26]`, per ccfork — does this CLI take the system prompt in a file on
 * Windows, or in argv?
 *
 * Split from ccfork-reviewer.test.ts, which sits at the 400-LOC cap. The
 * question is per-fork and answered by a declared flag, never by family
 * resemblance: `codebuddy --help` was read on a real machine and lists
 * `--system-prompt-file`; `qoder` could not be installed anywhere to check.
 */

import { test, expect } from "bun:test";
import type { CallBrainOptions } from "../../../src/brain/brain";
import { existsSync, readFileSync } from "node:fs";
import { makeCodeBuddyProvider, makeQoderProvider } from "../../../src/brain/providers/ccfork-reviewer";

const CONFORMANT_INNER = JSON.stringify({
  mood: "happy",
  pose: "base",
  bubble_short: "looks good",
  bubble_long: "",
  critique_for_claude: "",
  severity: "info",
  confidence: "high",
  xp_earned_events: [],
});

/** A minimal ccfork `-o json` envelope — enough for the provider to parse. */
function envelope(): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: CONFORMANT_INNER,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    session_id: "s",
  });
}

/**
 * Records argv, and reads the prompt file WHILE the process is notionally
 * running — it is deleted as soon as the call returns, which is the point.
 */
function capturingSpawn(seen: {
  argv?: string[];
  fileAtSpawn?: string;
}): typeof Bun.spawn {
  return ((cmd: string[], _options: unknown) => {
    seen.argv = cmd;
    const i = cmd.indexOf("--system-prompt-file");
    if (i > -1) seen.fileAtSpawn = readFileSync(cmd[i + 1]!, "utf8");
    return {
      stdin: { write: (_s: string) => {}, end: () => {} },
      stdout: new Response(envelope()).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill: () => {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

const baseOpts = (over: Partial<CallBrainOptions> = {}): CallBrainOptions => ({
  systemPrompt: "REVIEW RUBRIC",
  contextBundle: "diff under review",
  cwd: "/repo/under/review",
  ...over,
});

test("codebuddy on win32: prompt travels in a file, and its text is nowhere in argv", async () => {
  const seen: { argv?: string[]; fileAtSpawn?: string } = {};
  await makeCodeBuddyProvider().call(
    baseOpts({ platform: "win32", spawnFn: capturingSpawn(seen) }),
  );
  expect(seen.argv).not.toContain("--system-prompt");
  expect(seen.argv).not.toContain("REVIEW RUBRIC");
  expect(seen.argv).toContain("--system-prompt-file");
  // And the file carries the prompt — a flag pointing at an empty file would
  // satisfy every assertion above while reviewing with no instructions at all.
  expect(seen.fileAtSpawn).toBe("REVIEW RUBRIC");

  // The cleanup on THIS path had no assertion anywhere: deleting the
  // `cleanup()` line in ccfork-reviewer.ts kept every test green, while the
  // sibling assertion in windows-system-prompt-file.test.ts only ever covered
  // brain.ts. `fileAtSpawn` above is the control that makes "gone" mean
  // cleaned-up rather than never-written.
  const i = seen.argv!.indexOf("--system-prompt-file");
  expect(existsSync(seen.argv![i + 1]!)).toBe(false);
});

// This test used to pin qoder to argv, as the guard on a decision NOT to guess:
// `codebuddy --help` lists `--system-prompt-file`, and qoder was believed not to
// be installed anywhere it could be checked, so flipping the flag on a family
// resemblance would have turned a working reviewer into a broken one. The guard
// did its job — it says right here that it is the thing to update once someone
// confirms the flag, and that is what happened on 2026-09-26. Two corrections:
//
//   1. qodercli WAS installed all along. The earlier check ran `command -v
//      qoder`; the binary is `qodercli`. "Not found" was a typo, not a fact.
//   2. `qodercli --help` does not list the flag, and never will: its own bundle
//      carries `.addOption(new pT("--system-prompt-file <path>").hideHelp())`,
//      in the same option chain as `--system-prompt <text>`. Confirmed against
//      the running 1.1.1 binary — the flag reaches the model (then fails on the
//      account credit limit, error_code 118) exactly as the documented
//      `--system-prompt` does, while a flag that does not exist makes qodercli
//      print its usage and exit 1.
//
// So this now asserts the file form. What is still NOT established, for qoder as
// for codebuddy: that the flag DELIVERS the prompt (no quota for a real turn),
// and anything at all on Windows.
test("qoder on win32: prompt travels in a file — the flag is declared but hidden from --help", async () => {
  const seen: { argv?: string[]; fileAtSpawn?: string } = {};
  await makeQoderProvider().call(
    baseOpts({ platform: "win32", spawnFn: capturingSpawn(seen) }),
  );
  expect(seen.argv).not.toContain("--system-prompt");
  expect(seen.argv).not.toContain("REVIEW RUBRIC");
  expect(seen.argv).toContain("--system-prompt-file");
  // The file carries the prompt — a flag pointing at an empty file would satisfy
  // every assertion above while reviewing with no instructions at all.
  expect(seen.fileAtSpawn).toBe("REVIEW RUBRIC");
  // And it is cleaned up when the call returns.
  const i = seen.argv!.indexOf("--system-prompt-file");
  expect(existsSync(seen.argv![i + 1]!)).toBe(false);
});

test("qoder off win32: argv form unchanged — the path that already works", async () => {
  // The win32 gate is one-sided for qoder too. Without this, flipping the gate
  // to "always use a file" would pass every other assertion in this file.
  const seen: { argv?: string[] } = {};
  await makeQoderProvider().call(
    baseOpts({ platform: "darwin", spawnFn: capturingSpawn(seen) }),
  );
  expect(seen.argv).toContain("--system-prompt");
  expect(seen.argv).toContain("REVIEW RUBRIC");
  expect(seen.argv).not.toContain("--system-prompt-file");
});

test("codebuddy off win32: argv form unchanged, the path that already works", async () => {
  const seen: { argv?: string[] } = {};
  await makeCodeBuddyProvider().call(
    baseOpts({ platform: "darwin", spawnFn: capturingSpawn(seen) }),
  );
  expect(seen.argv).toContain("--system-prompt");
  expect(seen.argv).toContain("REVIEW RUBRIC");
  expect(seen.argv).not.toContain("--system-prompt-file");
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect `[26]` — on Windows the system prompt must not travel in argv.
 *
 * npm's `claude` on Windows IS `claude.cmd`, and the runtime refuses to hand a
 * `.bat`/`.cmd` any argument containing a cmd.exe special character
 * (CVE-2024-27980 hardening). The review prompt always contains one, so every
 * review on that machine failed before the process started. Verified on a real
 * Windows 10 box 2026-09-25: the argv form reproduced the refusal and
 * `--system-prompt-file` exited 0, in the same run (audit §39.1).
 *
 * These tests assert the SHAPE OF ARGV rather than any observable behaviour,
 * because the refusal cannot be reproduced on macOS — there is no such check
 * here. That is the honest limit of what this suite can prove: it pins that the
 * prompt is not in argv and that the file carries it, and nothing more.
 */

import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { callBrain } from "../../src/brain/brain";

/** A prompt containing every character the cmd.exe check rejects. */
const PROMPT_WITH_SPECIALS =
  'You are Fuzzyglob. Rules: a&b | c > d < e ^ f "quoted" %VAR%';

function capturingSpawn(seen: {
  argv: string[][];
  fileAtSpawn?: string;
}): typeof Bun.spawn {
  return ((cmd: string[], _options: unknown) => {
    seen.argv.push([...cmd]);
    // Read the file HERE, not after the call: it is deleted as soon as the call
    // returns, and this is the moment the real child process would see it.
    const i = cmd.indexOf("--system-prompt-file");
    if (i > -1) seen.fileAtSpawn = readFileSync(cmd[i + 1]!, "utf8");
    return {
      stdin: { write(_c: string) {}, end() {} },
      stdout: new Response(
        JSON.stringify([
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: JSON.stringify({
              mood: "happy",
              pose: "base",
              bubble_short: "ok",
              bubble_long: "",
              critique_for_claude: "",
              severity: "info",
              confidence: "high",
              xp_earned_events: [],
            }),
            total_cost_usd: 0,
            usage: {
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              input_tokens: 1,
              output_tokens: 1,
            },
          },
        ]),
      ).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
}

describe("defect [26] — the system prompt leaves argv on Windows", () => {
  test("on win32 the prompt is passed as a file, and its text is nowhere in argv", async () => {
    const seen: { argv: string[][]; fileAtSpawn?: string } = { argv: [] };
    await callBrain({
      systemPrompt: PROMPT_WITH_SPECIALS,
      contextBundle: "diff",
      spawnFn: capturingSpawn(seen),
      platform: "win32",
    });

    const argv = seen.argv[0]!;
    // The whole point: no argument carries the prompt text.
    expect(argv.some((a) => a.includes("Fuzzyglob"))).toBe(false);
    expect(argv).not.toContain("--system-prompt");
    expect(argv).toContain("--system-prompt-file");
    // And the file actually holds it — a flag pointing at an empty or missing
    // file would satisfy every assertion above while reviewing with no
    // instructions at all.
    expect(seen.fileAtSpawn).toBe(PROMPT_WITH_SPECIALS);
  });

  test("the temp file is gone once the call returns", async () => {
    const seen: { argv: string[][]; fileAtSpawn?: string } = { argv: [] };
    await callBrain({
      systemPrompt: PROMPT_WITH_SPECIALS,
      contextBundle: "diff",
      spawnFn: capturingSpawn(seen),
      platform: "win32",
    });
    const argv = seen.argv[0]!;
    // Control: the file DID exist during the call, so "gone" below means
    // cleaned up rather than never written.
    expect(seen.fileAtSpawn).toBe(PROMPT_WITH_SPECIALS);
    const i = argv.indexOf("--system-prompt-file");
    // Without this the test passes for the wrong reason: a missing flag gives
    // indexOf -1, so `argv[0]` ("claude") gets probed and is of course not a
    // file on disk. Measured — this assertion was green before the fix existed.
    expect(i).toBeGreaterThan(-1);
    expect(existsSync(argv[i + 1]!)).toBe(false);
  });

  // The gap the first version left open: a throw from the stdin write landed
  // between the spawn's own cleanup and the finally's, leaking the prompt file
  // once per review. The realistic trigger is a child that exits instantly —
  // EPIPE — which is exactly what an unrecognized `--system-prompt-file` does,
  // i.e. the build this fix explicitly tolerates. The prompt can quote the
  // user's source, so the leak is not merely untidy.
  test("a throw from the stdin write still removes the prompt file", async () => {
    const seen: { argv: string[][]; fileAtSpawn?: string } = { argv: [] };
    const explodingStdin = ((cmd: string[], _o: unknown) => {
      seen.argv.push([...cmd]);
      const i = cmd.indexOf("--system-prompt-file");
      if (i > -1) seen.fileAtSpawn = readFileSync(cmd[i + 1]!, "utf8");
      return {
        stdin: {
          write(_c: string) {
            throw new Error("EPIPE");
          },
          end() {},
        },
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
        kill() {},
      };
    }) as unknown as typeof Bun.spawn;

    await expect(
      callBrain({
        systemPrompt: PROMPT_WITH_SPECIALS,
        contextBundle: "diff",
        spawnFn: explodingStdin,
        platform: "win32",
      }),
    ).rejects.toThrow();

    const argv = seen.argv[0]!;
    const i = argv.indexOf("--system-prompt-file");
    expect(i).toBeGreaterThan(-1);
    // Control: the file existed while the call was in flight, so "gone" below
    // means cleaned up rather than never written.
    expect(seen.fileAtSpawn).toBe(PROMPT_WITH_SPECIALS);
    expect(existsSync(argv[i + 1]!)).toBe(false);
  });

  test("every other platform keeps the argv form, unchanged", async () => {
    const seen: { argv: string[][]; fileAtSpawn?: string } = { argv: [] };
    await callBrain({
      systemPrompt: PROMPT_WITH_SPECIALS,
      contextBundle: "diff",
      spawnFn: capturingSpawn(seen),
      platform: "darwin",
    });

    const argv = seen.argv[0]!;
    // Not a cosmetic assertion: the argv form has run in production on
    // macOS/Linux for months. The Windows fix must not spend that.
    expect(argv).toContain("--system-prompt");
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe(PROMPT_WITH_SPECIALS);
    expect(argv).not.toContain("--system-prompt-file");
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The two symptoms audit `[4]` actually observed, pinned as tests.
 *
 * `failure-reason.test.ts` covers the distiller in isolation. This file drives
 * the two real surfaces the user saw, with the exact payload the sandbox
 * produced, so a revert on either wiring reds here rather than only in a unit
 * test of a function nobody calls.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainError } from "../../src/brain/brain";
import { callBrain } from "../../src/brain/brain";
import { makeGuardedCallBrain } from "../../src/brain/brain-guarded";
import { brainUnhealthySignal, readBrainHealth } from "../../src/state/brain-health";

/** Verbatim shape of what `claude -p --output-format json` wrote in the sandbox. */
const NOT_LOGGED_IN_STDOUT = JSON.stringify({
  type: "result",
  subtype: "error",
  is_error: true,
  api_error_status: null,
  result: "Not logged in · Please run /login",
});

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-audit4-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function failOnce(): Promise<void> {
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      throw new BrainError("claude -p exited with code 1: ", undefined, {
        exitCode: 1,
        stderr: "",
        stdout: NOT_LOGGED_IN_STDOUT,
      });
    },
    sleepFn: async () => {},
    checkBudgetFn: async () => false,
  });
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow();
}

/** Minimal `Bun.spawn` stand-in — same shape `tests/brain/brain.test.ts` uses. */
function fakeSpawn(opts: {
  stdoutText: string;
  stderrText?: string;
  exitCode?: number;
}): typeof Bun.spawn {
  return ((_cmd: string[], _options: unknown) => ({
    stdin: { write(_c: string) {}, end() {} },
    stdout: new Response(opts.stdoutText).body,
    stderr: new Response(opts.stderrText ?? "").body,
    exited: Promise.resolve(opts.exitCode ?? 0),
    kill() {},
  })) as unknown as typeof Bun.spawn;
}

describe("audit [4] — the reason reaches the user", () => {
  test("symptom one: the thrown message carries the reason, not a bare colon", async () => {
    // The hook logs this message verbatim. It used to end at
    // `exited with code 1:` because the message read `stderr`, which is EMPTY
    // for exactly this failure — the reason was on stdout the whole time.
    let caught: unknown;
    try {
      await callBrain({
        systemPrompt: "s",
        contextBundle: "c",
        spawnFn: fakeSpawn({ stdoutText: NOT_LOGGED_IN_STDOUT, exitCode: 1 }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("Not logged in");
    expect(msg.trim()).not.toMatch(/:$/);
    // And still no envelope debris in a line a human reads.
    expect(msg).not.toContain("api_error_status");
  });

  test("…and a failure that really has no output does not pretend (control)", async () => {
    // Pairs with the assertion above: without this, "contains Not logged in"
    // could be satisfied by a message that always pastes the whole stdout.
    let caught: unknown;
    try {
      await callBrain({
        systemPrompt: "s",
        contextBundle: "c",
        spawnFn: fakeSpawn({ stdoutText: "", exitCode: 1 }),
      });
    } catch (err) {
      caught = err;
    }
    const msg = (caught as Error).message;
    expect(msg).toMatch(/no output/i);
    expect(msg.trim()).not.toMatch(/:$/);
  });

  test("symptom two: the banner shows the reason, not the JSON around it", async () => {
    await failOnce();
    const health = readBrainHealth(tmp);
    const signal = brainUnhealthySignal(health, new Date());

    expect(signal.show).toBe(true);
    // What the user actually reads:
    expect(signal.line).toContain("Not logged in");
    // What the user used to read — the envelope, sliced through the middle:
    for (const debris of ['{"', 'api_error_status', 'is_error', '"result"', 'subtype']) {
      expect(signal.line).not.toContain(debris);
      expect(signal.detail).not.toContain(debris);
    }
  });

  test("the recorded excerpt itself is a sentence", async () => {
    await failOnce();
    const excerpt = readBrainHealth(tmp).last_failure?.stderr_excerpt ?? "";
    expect(excerpt).toBe("Not logged in · Please run /login");
  });

  test("a failure with genuinely no output still records something readable", async () => {
    const guarded = makeGuardedCallBrain({
      homeBase: tmp,
      callBrainFn: async () => {
        throw new BrainError("claude -p exited with code 1: ", undefined, {
          exitCode: 1,
          stderr: "",
          stdout: "",
        });
      },
      sleepFn: async () => {},
      checkBudgetFn: async () => false,
    });
    await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow();
    const excerpt = readBrainHealth(tmp).last_failure?.stderr_excerpt ?? "";
    expect(excerpt.trim().length).toBeGreaterThan(0);
    expect(excerpt).toMatch(/no output/i);
  });
});

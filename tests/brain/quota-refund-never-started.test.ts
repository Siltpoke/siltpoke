// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Windows Run 4 (install audit §110 W5): reviewer set to codex, codex not
// installed. The spawn failed with `Executable not found in $PATH: "codex"`,
// and `quota_calls_today` still counted the call. The slot is taken before the
// spawn; a process that never started made no call, so it is given back.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainError } from "../../src/brain/brain";
import { makeGuardedCallBrain, makeGuardedCallRaw } from "../../src/brain/brain-guarded";
import type { ReviewerBrainProvider } from "../../src/brain/provider";
import { readBrainHealth, refundQuotaCall, writeBrainHealth } from "../../src/state/brain-health";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "quota-refund-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const provider = { meta: { name: "codex", billing: "quota" } } as unknown as ReviewerBrainProvider;
const reviewCount = () => readBrainHealth(home).quota_calls_today.review?.count ?? 0;

const neverStarted = () =>
  new BrainError("codex spawn failed", new Error("x"), {
    exitCode: null,
    stderr: "",
    stdout: "",
    spawnError: 'Error: Executable not found in $PATH: "codex"',
  });
const startedAndFailed = () =>
  new BrainError("codex exited 1", new Error("x"), { exitCode: 1, stderr: "bad request", stdout: "" });

async function brainCall(fail: () => BrainError): Promise<void> {
  const call = makeGuardedCallBrain({
    homeBase: home,
    provider,
    callBrainFn: async () => {
      throw fail();
    },
    sleepFn: async () => {},
  });
  await call({ systemPrompt: "s", contextBundle: "c" } as never).catch(() => {});
}

describe("a call whose process never started does not use the daily cap", () => {
  test("Run 4's case: Executable not found -> count back to 0", async () => {
    await brainCall(neverStarted);
    expect(reviewCount()).toBe(0);
  });

  test("control: a process that started and then failed still counts", async () => {
    await brainCall(startedAndFailed);
    expect(reviewCount()).toBe(1);
  });

  test("the raw path (chat / summarizer) too, and the error still reaches the caller", async () => {
    const call = makeGuardedCallRaw({
      homeBase: home,
      provider,
      usedBy: "chat",
      callRawFn: async () => {
        throw neverStarted();
      },
    });
    await expect(call({ prompt: "x" } as never)).rejects.toThrow("codex spawn failed");
    expect(readBrainHealth(home).quota_calls_today.chat?.count ?? 0).toBe(0);
  });

  test("refund never goes below 0 and leaves another day's slot alone", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    refundQuotaCall(home, "review", now);
    expect(reviewCount()).toBe(0);
    const h = readBrainHealth(home);
    writeBrainHealth(home, { ...h, quota_calls_today: { review: { date: "2000-01-01", count: 3 } } });
    refundQuotaCall(home, "review", now);
    expect(readBrainHealth(home).quota_calls_today.review).toEqual({ date: "2000-01-01", count: 3 });
  });
});


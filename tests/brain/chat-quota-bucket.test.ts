// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainError } from "../../src/brain/brain";
import { makeGuardedCallRaw } from "../../src/brain/brain-guarded";
import type { ReviewerBrainProvider } from "../../src/brain/provider";
import { makeRoleRawBrain, makeRoleTextBrain } from "../../src/brain/role-brain";
import {
  DEFAULT_QUOTA_DAILY_CAP,
  loadChatQuotaDailyCapSync,
  loadQuotaDailyCapSync,
} from "../../src/config/brain-quota-cap-config";
import { readBrainHealth } from "../../src/state/brain-health";

// Defect [49] step 4 (design §6, AC11 / AC12): chat counts its daily calls in
// its own bucket (`chat`, whichever agent — spec §12.3) against its own cap
// (`brain.chat_quota_daily_cap`), so chatting cannot use up the day's reviews
// and reviewing cannot use up the day's chat.

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "chat-quota-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeCfg(cfg: unknown): void {
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
}

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(readBrainHealth(home).quota_calls_today)) {
    out[key] = entry.count;
  }
  return out;
}

describe("loadChatQuotaDailyCapSync", () => {
  test("no config file -> 50", () => {
    expect(loadChatQuotaDailyCapSync(home)).toBe(DEFAULT_QUOTA_DAILY_CAP);
  });
  test("reads brain.chat_quota_daily_cap, not the review key", () => {
    writeCfg({ brain: { quota_daily_cap: 7, chat_quota_daily_cap: 120 } });
    expect(loadChatQuotaDailyCapSync(home)).toBe(120);
    expect(loadQuotaDailyCapSync(home)).toBe(7);
  });
  test("the review key alone does not set the chat cap", () => {
    writeCfg({ brain: { quota_daily_cap: 7 } });
    expect(loadChatQuotaDailyCapSync(home)).toBe(50);
  });
  test("0 is kept as 0 (no cap)", () => {
    writeCfg({ brain: { chat_quota_daily_cap: 0 } });
    expect(loadChatQuotaDailyCapSync(home)).toBe(0);
  });
  test("invalid values fall back to 50", () => {
    for (const bad of [-1, 2.5, "100", null, true, [1]]) {
      writeCfg({ brain: { chat_quota_daily_cap: bad } });
      expect(loadChatQuotaDailyCapSync(home)).toBe(50);
    }
  });
  test("malformed JSON -> 50", () => {
    writeFileSync(join(home, "config.json"), "{ nope");
    expect(loadChatQuotaDailyCapSync(home)).toBe(50);
  });
});

function fakeQuotaProvider(name = "codebuddy"): ReviewerBrainProvider {
  return { meta: { name, billing: "quota" } } as unknown as ReviewerBrainProvider;
}

type UsedBy = "chat" | "review" | undefined;

async function callN(n: number, usedBy: UsedBy): Promise<{ ok: number; refused: BrainError[] }> {
  let ok = 0;
  const refused: BrainError[] = [];
  const call = makeGuardedCallRaw({
    homeBase: home,
    provider: fakeQuotaProvider(),
    callRawFn: async () => ({ text: "{}", usage: {} }) as never,
    ...(usedBy !== undefined ? { usedBy } : {}),
  });
  for (let i = 0; i < n; i++) {
    try {
      await call({ prompt: "x" } as never);
      ok++;
    } catch (e) {
      if (e instanceof BrainError && e.code === "quota_cap") refused.push(e);
      else throw e;
    }
  }
  return { ok, refused };
}

describe("guarded raw call — chat has its own bucket (AC11)", () => {
  test("chat calls count under chat and leave the review bucket alone", async () => {
    await callN(3, "chat");
    expect(counts()).toEqual({ chat: 3 });
  });

  test("review calls count under review and leave the chat bucket alone", async () => {
    await callN(2, "review");
    expect(counts()).toEqual({ review: 2 });
  });

  test("a caller that does not say who is using it is counted as review", async () => {
    await callN(2, undefined);
    expect(counts()).toEqual({ review: 2 });
  });

  test("both in one day: two independent counts that survive each other's writes", async () => {
    await callN(2, "chat");
    await callN(5, "review");
    await callN(1, "chat");
    expect(counts()).toEqual({ chat: 3, review: 5 });
  });
});

describe("guarded raw call — chat has its own cap (AC12)", () => {
  test("chat reaches its cap → refused; review still runs", async () => {
    writeCfg({ brain: { chat_quota_daily_cap: 2 } });
    const chat = await callN(3, "chat");
    expect(chat.ok).toBe(2);
    expect(chat.refused.length).toBe(1);
    const review = await callN(4, "review");
    expect(review.ok).toBe(4);
    expect(review.refused.length).toBe(0);
  });

  test("review reaches its cap → refused; chat still runs", async () => {
    writeCfg({ brain: { quota_daily_cap: 2 } });
    const review = await callN(3, "review");
    expect(review.ok).toBe(2);
    expect(review.refused.length).toBe(1);
    const chat = await callN(4, "chat");
    expect(chat.ok).toBe(4);
    expect(chat.refused.length).toBe(0);
  });

  test("the review cap does not limit chat, and the chat cap does not limit review", async () => {
    writeCfg({ brain: { quota_daily_cap: 1, chat_quota_daily_cap: 3 } });
    expect((await callN(4, "chat")).ok).toBe(3);
    expect((await callN(4, "review")).ok).toBe(1);
  });

  test("chat default is 50: 50 allowed, 51st refused", async () => {
    const r = await callN(51, "chat");
    expect(r.ok).toBe(50);
    expect(r.refused.length).toBe(1);
  });

  test("chat cap 0 = no cap, even when review has one", async () => {
    writeCfg({ brain: { quota_daily_cap: 1, chat_quota_daily_cap: 0 } });
    const r = await callN(60, "chat");
    expect(r.ok).toBe(60);
  });

  test("the chat refusal names the chat cap and the chat key", async () => {
    writeCfg({ brain: { quota_daily_cap: 9, chat_quota_daily_cap: 2 } });
    const msg = (await callN(3, "chat")).refused[0]!.message;
    expect(msg).toContain("(2/day)");
    expect(msg).toContain('"chat_quota_daily_cap"');
    expect(msg).toContain("codebuddy");
    expect(msg).toContain("daily chat call cap");
  });

  test("the review refusal still names the review cap and the review key only", async () => {
    writeCfg({ brain: { quota_daily_cap: 2, chat_quota_daily_cap: 9 } });
    const msg = (await callN(3, "review")).refused[0]!.message;
    expect(msg).toContain("(2/day)");
    expect(msg).toContain('"quota_daily_cap"');
    expect(msg).not.toContain("chat_quota_daily_cap");
    expect(msg).not.toContain("chat call cap");
  });
});

// Minimal fake of `qodercli -p --output-format json` (as in role-brain.test.ts).
function fakeQoderSpawn(innerResult: string): typeof Bun.spawn {
  return (() => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: innerResult,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    return {
      stdin: { write() {}, end() {} },
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

describe("role-routed calls pick the bucket from the role", () => {
  beforeEach(() => {
    writeCfg({
      brain: { roles: { chat: { provider: "qoder" }, extract: { provider: "qoder" } } },
    });
  });

  test("the chat role (the chat recap) counts under chat", async () => {
    const recap = makeRoleTextBrain(home, "chat");
    await recap({ systemPrompt: "recap", contextBundle: "c", spawnFn: fakeQoderSpawn("a recap") });
    expect(counts()).toEqual({ chat: 1 });
  });

  test("the extract role counts under extract", async () => {
    const extract = makeRoleRawBrain(home, "extract");
    await extract({ systemPrompt: "task", contextBundle: "c", spawnFn: fakeQoderSpawn("{}") });
    expect(counts()).toEqual({ extract: 1 });
  });
});

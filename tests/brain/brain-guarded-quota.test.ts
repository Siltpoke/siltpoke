// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainError } from "../../src/brain/brain";
import { makeGuardedCallBrain, makeGuardedCallRaw } from "../../src/brain/brain-guarded";
import type { ReviewerBrainProvider } from "../../src/brain/provider";
import { makeRoleRawBrain, makeRoleTextBrain } from "../../src/brain/role-brain";
import { roleSynthesizeFn } from "../../src/memory/synthesize-episodes";
import { readBrainHealth, writeBrainHealth } from "../../src/state/brain-health";
import { dayKey } from "../../src/state/usage";

// Spec §12.3 (the maintainer 2026-10-14): daily caps count PER ROLE — chat / review /
// extract — whichever agent made the call, and all five agents are counted and
// blocked the same way, claude included. Old per-agent keys (`codex`,
// `chat:qoder`) are left where they are and do not count (§12.3, decided).

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "role-quota-"));
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

function fakeProvider(name: string, billing: "quota" | "usd"): ReviewerBrainProvider {
  return { meta: { name, billing } } as unknown as ReviewerBrainProvider;
}

type Role = "review" | "chat" | "extract";

async function rawCall(name: string, billing: "quota" | "usd", usedBy: Role): Promise<"ok" | BrainError> {
  const call = makeGuardedCallRaw({
    homeBase: home,
    provider: fakeProvider(name, billing),
    callRawFn: async () => ({ text: "{}", usage: {} }) as never,
    usedBy,
  });
  try {
    await call({ prompt: "x" } as never);
    return "ok";
  } catch (e) {
    if (e instanceof BrainError && e.code === "quota_cap") return e;
    throw e;
  }
}

describe("one count per role, whichever agent", () => {
  test("two review calls on codex and one on agy use up a cap of 3; the 4th is refused on any agent", async () => {
    writeCfg({ brain: { quota_daily_cap: 3 } });
    expect(await rawCall("codex", "quota", "review")).toBe("ok");
    expect(await rawCall("codex", "quota", "review")).toBe("ok");
    expect(await rawCall("agy", "quota", "review")).toBe("ok");
    expect(await rawCall("qoder", "quota", "review")).toBeInstanceOf(BrainError);
    expect(counts()).toEqual({ review: 3 });
  });

  test("a claude review call is counted and refused at the cap like the others", async () => {
    writeCfg({ brain: { quota_daily_cap: 1 } });
    expect(await rawCall("claude", "usd", "review")).toBe("ok");
    expect(await rawCall("claude", "usd", "review")).toBeInstanceOf(BrainError);
    expect(counts()).toEqual({ review: 1 });
  });

  test("a claude review through the parse path (the Stop hook's default) is counted too", async () => {
    writeCfg({ brain: { quota_daily_cap: 1 } });
    let spawned = 0;
    const call = makeGuardedCallBrain({
      homeBase: home,
      callBrainFn: async () => {
        spawned++;
        return { verdict: {}, usage: {} } as never;
      },
    });
    await call({ prompt: "x" } as never);
    await expect(call({ prompt: "x" } as never)).rejects.toThrow(/daily review call cap \(1\/day\)/);
    expect(spawned).toBe(1);
    expect(counts()).toEqual({ review: 1 });
  });

  test("extract counts in its own bucket against its own cap, not review's", async () => {
    writeCfg({ brain: { quota_daily_cap: 1, extract_quota_daily_cap: 2 } });
    expect(await rawCall("codex", "quota", "extract")).toBe("ok");
    expect(await rawCall("codex", "quota", "extract")).toBe("ok");
    expect(await rawCall("codex", "quota", "extract")).toBeInstanceOf(BrainError);
    expect(await rawCall("codex", "quota", "review")).toBe("ok");
    expect(counts()).toEqual({ extract: 2, review: 1 });
  });

  test("chat counts under chat whichever agent", async () => {
    await rawCall("qoder", "quota", "chat");
    await rawCall("agy", "quota", "chat");
    expect(counts()).toEqual({ chat: 2 });
  });

  test("the refusal names the role and its config key", async () => {
    writeCfg({ brain: { extract_quota_daily_cap: 1 } });
    await rawCall("agy", "quota", "extract");
    const err = (await rawCall("agy", "quota", "extract")) as BrainError;
    expect(err.message).toContain("daily summarizer call cap (1/day)");
    expect(err.message).toContain('"extract_quota_daily_cap"');
    expect(err.message).not.toContain("quota-billed provider");
  });

  test("old per-agent counts from before the change are ignored (§12.3)", async () => {
    const today = dayKey(new Date());
    const health = readBrainHealth(home);
    writeBrainHealth(home, {
      ...health,
      quota_calls_today: {
        codex: { date: today, count: 49 },
        "chat:qoder": { date: today, count: 49 },
      },
    });
    writeCfg({ brain: { quota_daily_cap: 2, chat_quota_daily_cap: 2 } });
    expect(await rawCall("codex", "quota", "review")).toBe("ok");
    expect(await rawCall("codex", "quota", "review")).toBe("ok");
    expect(await rawCall("qoder", "quota", "chat")).toBe("ok");
    expect(counts()).toEqual({ codex: 49, "chat:qoder": 49, review: 2, chat: 1 });
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

describe("the extract role (summaries, memory) counts under extract", () => {
  test("makeRoleRawBrain(extract) takes from extract, not review", async () => {
    writeCfg({ brain: { roles: { extract: { provider: "qoder" } } } });
    const extract = makeRoleRawBrain(home, "extract");
    await extract({ systemPrompt: "task", contextBundle: "c", spawnFn: fakeQoderSpawn("{}") });
    expect(counts()).toEqual({ extract: 1 });
  });

  // Small item [9]: memory episodes used to call claude directly, uncounted.
  test("episode synthesis through the role brain counts under extract, and is refused at the cap", async () => {
    writeCfg({ brain: { roles: { extract: { provider: "qoder" } }, extract_quota_daily_cap: 1 } });
    const role = makeRoleTextBrain(home, "extract");
    const synth = roleSynthesizeFn((opts) => role({ ...opts, spawnFn: fakeQoderSpawn('{"narrative":"n"}') }));
    await synth("cluster");
    expect(counts()).toEqual({ extract: 1 });
    await expect(synth("cluster")).rejects.toMatchObject({ code: "quota_cap" });
    expect(counts()).toEqual({ extract: 1 });
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainError } from "../../src/brain/brain";
import { makeGuardedCallRaw } from "../../src/brain/brain-guarded";
import type { ReviewerBrainProvider } from "../../src/brain/provider";
import {
  DEFAULT_QUOTA_DAILY_CAP,
  loadQuotaDailyCapSync,
} from "../../src/config/brain-quota-cap-config";

// Defect [56]: the per-day cap on quota-billed reviewers was a code constant.
// It is now `brain.quota_daily_cap`; 0 = no cap; bad value = default 50.

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "quota-cap-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeCfg(cfg: unknown): void {
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
}

describe("loadQuotaDailyCapSync", () => {
  test("no config file -> 50", () => {
    expect(loadQuotaDailyCapSync(home)).toBe(50);
    expect(DEFAULT_QUOTA_DAILY_CAP).toBe(50);
  });
  test("key absent -> 50", () => {
    writeCfg({ brain: { timeout_ms: 5000 } });
    expect(loadQuotaDailyCapSync(home)).toBe(50);
  });
  test("value N is respected", () => {
    writeCfg({ brain: { quota_daily_cap: 120 } });
    expect(loadQuotaDailyCapSync(home)).toBe(120);
  });
  test("0 is kept as 0 (no cap), not replaced by the default", () => {
    writeCfg({ brain: { quota_daily_cap: 0 } });
    expect(loadQuotaDailyCapSync(home)).toBe(0);
  });
  test("invalid values fall back to 50", () => {
    for (const bad of [-1, 2.5, "100", null, true, [1]]) {
      writeCfg({ brain: { quota_daily_cap: bad } });
      expect(loadQuotaDailyCapSync(home)).toBe(50);
    }
  });
  test("malformed JSON -> 50", () => {
    writeFileSync(join(home, "config.json"), "{ nope");
    expect(loadQuotaDailyCapSync(home)).toBe(50);
  });
});

function fakeQuotaProvider(): ReviewerBrainProvider {
  return { meta: { name: "codex", billing: "quota" } } as unknown as ReviewerBrainProvider;
}

async function callN(n: number): Promise<{ ok: number; refused: BrainError[] }> {
  let ok = 0;
  const refused: BrainError[] = [];
  const call = makeGuardedCallRaw({
    homeBase: home,
    provider: fakeQuotaProvider(),
    callRawFn: async () => ({ text: "{}", usage: {} }) as never,
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

describe("guarded call honours the configured cap", () => {
  test("default: 50 allowed, 51st refused", async () => {
    const r = await callN(51);
    expect(r.ok).toBe(50);
    expect(r.refused.length).toBe(1);
  });
  test("cap N=3: 3rd allowed, 4th refused", async () => {
    writeCfg({ brain: { quota_daily_cap: 3 } });
    const r = await callN(4);
    expect(r.ok).toBe(3);
    expect(r.refused.length).toBe(1);
  });
  test("cap 0 (off): never refused", async () => {
    writeCfg({ brain: { quota_daily_cap: 0 } });
    const r = await callN(60);
    expect(r.ok).toBe(60);
    expect(r.refused.length).toBe(0);
  });
  test("invalid value keeps the default brake (not 'off')", async () => {
    writeCfg({ brain: { quota_daily_cap: -5 } });
    const r = await callN(51);
    expect(r.ok).toBe(50);
    expect(r.refused.length).toBe(1);
  });
  test("refusal message names the actual cap and the setting, and does not promise /siltpoke:siltpoke-wake", async () => {
    writeCfg({ brain: { quota_daily_cap: 2 } });
    const r = await callN(3);
    const msg = r.refused[0]!.message;
    expect(msg).toContain("(2/day)");
    expect(msg).toContain("quota_daily_cap");
    expect(msg).not.toContain("siltpoke-wake");
  });
});

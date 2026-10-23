// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `saveQuotaDailyCaps` — the writer behind the Settings page's two daily-cap
 * boxes (defect [49], AC13). The readers it must agree with are in the same
 * module; every test reads back through them, not through the JSON alone.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadChatQuotaDailyCapSync,
  loadExtractQuotaDailyCapSync,
  loadQuotaDailyCapSync,
  saveQuotaDailyCaps,
} from "../../src/config/brain-quota-cap-config";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "quota-cap-save-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const cfgPath = (): string => join(home, "config.json");
const readCfg = (): Record<string, unknown> => JSON.parse(readFileSync(cfgPath(), "utf8"));

describe("saveQuotaDailyCaps", () => {
  test("writes both caps; each reader returns its own number", () => {
    const res = saveQuotaDailyCaps(home, { review: 120, chat: 7, extract: 50 });
    expect(res).toEqual({ ok: true, review: 120, chat: 7, extract: 50 });
    expect(loadQuotaDailyCapSync(home)).toBe(120);
    expect(loadChatQuotaDailyCapSync(home)).toBe(7);
  });

  test("0 is kept as 0 (no cap), not turned into the default", () => {
    expect(saveQuotaDailyCaps(home, { review: 0, chat: 0, extract: 50 }).ok).toBe(true);
    expect(loadQuotaDailyCapSync(home)).toBe(0);
    expect(loadChatQuotaDailyCapSync(home)).toBe(0);
  });

  test("keeps every other key in config.json, including the rest of `brain`", () => {
    writeFileSync(
      cfgPath(),
      JSON.stringify({
        pet: { name: "Poke" },
        brain: { roles: { chat: { provider: "codebuddy" } }, quota_daily_cap: 9 },
        budget: { dailyTokenLimit: 5 },
      }),
    );
    saveQuotaDailyCaps(home, { review: 60, chat: 61, extract: 50 });
    expect(readCfg()).toEqual({
      pet: { name: "Poke" },
      brain: {
        roles: { chat: { provider: "codebuddy" } },
        quota_daily_cap: 60,
        chat_quota_daily_cap: 61,
        extract_quota_daily_cap: 50,
      },
      budget: { dailyTokenLimit: 5 },
    });
  });

  test("a value that is not a whole number of 0 or more is refused and nothing is written", () => {
    const bad: unknown[] = [-1, 1.5, "10", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, true];
    for (const value of bad) {
      const asReview = saveQuotaDailyCaps(home, { review: value, chat: 5, extract: 50 });
      expect(asReview.ok).toBe(false);
      if (!asReview.ok) expect(asReview.message).toContain("review");
      const asChat = saveQuotaDailyCaps(home, { review: 5, chat: value, extract: 50 });
      expect(asChat.ok).toBe(false);
      if (!asChat.ok) expect(asChat.message).toContain("chat");
    }
    expect(existsSync(cfgPath())).toBe(false);
  });

  test("writes the summarizer cap too; its reader returns it (spec §12.3)", () => {
    const res = saveQuotaDailyCaps(home, { review: 1, chat: 2, extract: 33 });
    expect(res).toEqual({ ok: true, review: 1, chat: 2, extract: 33 });
    expect(loadExtractQuotaDailyCapSync(home)).toBe(33);
    expect(readCfg()).toEqual({
      brain: { quota_daily_cap: 1, chat_quota_daily_cap: 2, extract_quota_daily_cap: 33 },
    });
  });

  test("a bad or missing summarizer cap is refused and nothing is written", () => {
    for (const value of [-1, 1.5, "10", null, undefined]) {
      const res = saveQuotaDailyCaps(home, { review: 5, chat: 5, extract: value });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toContain("summarizer");
    }
    expect(existsSync(cfgPath())).toBe(false);
  });

  test("a refused save leaves an existing file byte for byte", () => {
    const before = JSON.stringify({ brain: { quota_daily_cap: 9 } });
    writeFileSync(cfgPath(), before);
    expect(saveQuotaDailyCaps(home, { review: 10, chat: -3, extract: 50 }).ok).toBe(false);
    expect(readFileSync(cfgPath(), "utf8")).toBe(before);
  });
});

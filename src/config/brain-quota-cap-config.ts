// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";

/**
 * How many review calls siltpoke may make per day before it skips the rest.
 * Counted per ROLE — review / chat / summarizer — whichever of the five agents
 * makes the call, claude included (spec §12.3, the maintainer 2026-10-14). Before
 * that it was per quota-billed agent and claude was never counted.
 *
 * WHY THIS IS A SETTING. The cap was a code constant, so a user who hit it had
 * no way to raise it short of hand-editing `brain-health.json` (defect `[56]`,
 * audit §59). The value is `brain.quota_daily_cap` in `<home>/config.json`
 * (`{ "brain": { "quota_daily_cap": 100 } }`).
 *
 * `0` MEANS NO CAP — the same convention as `budget.dailyTokenLimit: 0`
 * (`evaluateBudget` returns "ok" for it). Absent key = 50, the old behaviour.
 *
 * A non-integer, negative, or non-numeric value falls back to 50 rather than
 * throwing or silently becoming "no cap": this is read on the Stop-hook path,
 * where a typo must neither take the reviewer down nor remove the runaway
 * brake. Matches how `loadBudgetConfigSync` and `loadBrainTimeoutMs` treat a
 * bad value (silent fallback, no throw).
 */
export const DEFAULT_QUOTA_DAILY_CAP = 50;

function parseQuotaDailyCap(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return DEFAULT_QUOTA_DAILY_CAP;
  }
  return value;
}

type CapKey = "quota_daily_cap" | "chat_quota_daily_cap" | "extract_quota_daily_cap";

function loadCapSync(home: string, key: CapKey): number {
  const configPath = join(home, "config.json");
  if (!existsSync(configPath)) return DEFAULT_QUOTA_DAILY_CAP;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      brain?: Partial<Record<CapKey, unknown>> | null;
    };
    return parseQuotaDailyCap(parsed?.brain?.[key]);
  } catch {
    return DEFAULT_QUOTA_DAILY_CAP;
  }
}

/** Sync (the cap check runs inside the pre-spawn brake and cannot await). */
export function loadQuotaDailyCapSync(home: string): number {
  return loadCapSync(home, "quota_daily_cap");
}

/**
 * The same cap for CHAT calls (the dashboard chat and its recap), which count
 * in their own bucket so chatting cannot use up the day's reviews (defect
 * `[49]`, design §6). `brain.chat_quota_daily_cap`; same rules as above: absent
 * or invalid = 50, `0` = no cap. It does NOT fall back to the review key — the
 * two numbers are independent.
 */
export function loadChatQuotaDailyCapSync(home: string): number {
  return loadCapSync(home, "chat_quota_daily_cap");
}

/**
 * The Summarizer's cap: summaries and memory extraction (the `extract` role),
 * which shared review's count until spec §12.3. `brain.extract_quota_daily_cap`;
 * same rules: absent or invalid = 50, `0` = no cap, no fallback to another key.
 */
export function loadExtractQuotaDailyCapSync(home: string): number {
  return loadCapSync(home, "extract_quota_daily_cap");
}

export type SaveQuotaDailyCapsResult =
  | { ok: true; review: number; chat: number; extract: number }
  | { ok: false; message: string };

function isCap(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Write both caps (the Settings page's two boxes — defect `[49]`, AC13),
 * keeping every other key in `config.json`. Both are read per call, so the
 * next call uses the new numbers. Both keys are always written, so a cap that
 * was absent (and so 50) becomes an explicit 50.
 *
 * Stricter than the readers on purpose: they turn a bad value into 50 because
 * they run on the Stop-hook path; a save that did the same would report
 * success for a number the user did not type. A bad value is refused and
 * nothing is written. A corrupt `config.json` is started over from `{}`, as
 * `runBrainSet` does.
 */
export function saveQuotaDailyCaps(
  home: string,
  caps: { review: unknown; chat: unknown; extract: unknown },
): SaveQuotaDailyCapsResult {
  for (const [name, value] of [
    ["review", caps.review],
    ["chat", caps.chat],
    ["summarizer", caps.extract],
  ] as const) {
    if (!isCap(value)) {
      return { ok: false, message: `${name} cap must be a whole number, 0 or more (0 = no cap)` };
    }
  }
  const { review, chat, extract } = caps as { review: number; chat: number; extract: number };

  const configPath = join(home, "config.json");
  let prior: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (parsed && typeof parsed === "object") prior = parsed as Record<string, unknown>;
    } catch {
      // Corrupt config: start from {} — mirrors runBrainSet.
    }
  }
  const priorBrain =
    prior.brain && typeof prior.brain === "object" ? (prior.brain as Record<string, unknown>) : {};
  const next = {
    ...prior,
    brain: {
      ...priorBrain,
      quota_daily_cap: review,
      chat_quota_daily_cap: chat,
      extract_quota_daily_cap: extract,
    },
  };
  atomicWrite(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, review, chat, extract };
}

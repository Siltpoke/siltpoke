// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * XP ledger + daily cap enforcement.
 *
 * appendXpEvent(home, entry) is the single sanctioned write path for
 * earning XP. It:
 *   1. reads global (creates an empty one if missing)
 *   2. resets daily_caps_state.per_source_counts if local_date rolled
 *   3. checks the per-source cap; if exceeded, writes a capped=true,
 *      amount=0 row so the user-visible Growth UI can render "cap hit"
 *   4. otherwise writes the requested amount and increments per_source_counts
 *   5. atomically writes global.json
 *
 * xpFor(home, filter) is the canonical read for Growth UI: filter by
 * date / project / source and get back the events + the sum.
 */
import { newId } from "./memory";
import { readGlobal, writeGlobal, emptyGlobal } from "./global";
import { dailyCapFor } from "./xp-caps";
import type {
  GlobalMemory,
  XpEvent,
  XpSource,
} from "./schema-v3";

function localDateOf(d: Date): string {
  // Local-timezone YYYY-MM-DD. Uses host timezone (single-user local app).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * If `global.daily_caps_state.local_date` is from a previous local day,
 * clear `per_source_counts` and update `local_date`. Pure; returns the
 * (possibly) new memory object. Caller decides whether to persist.
 */
export function resetDailyCapsIfNewDay(
  global: GlobalMemory,
  now: Date,
): GlobalMemory {
  const today = localDateOf(now);
  if (global.daily_caps_state.local_date === today) return global;
  return {
    ...global,
    daily_caps_state: { local_date: today, per_source_counts: {} },
  };
}

export interface AppendXpInput {
  amount: number;
  source: XpSource;
  source_id?: string | null;
  source_project?: string | null;
  note?: string | null;
  ts?: string;
  now?: Date;
}

export interface AppendXpResult {
  written: XpEvent;
  new_total: number;
  capped: boolean;
}

export async function appendXpEvent(
  home: string,
  input: AppendXpInput,
): Promise<AppendXpResult> {
  if (input.amount < 0 || !Number.isInteger(input.amount)) {
    throw new Error(`xp amount must be a non-negative integer, got ${input.amount}`);
  }
  const now = input.now ?? new Date();
  const ts = input.ts ?? now.toISOString();
  let global = (await readGlobal(home)) ?? emptyGlobal(now);
  global = resetDailyCapsIfNewDay(global, now);

  const cap = dailyCapFor(input.source);
  const usedToday = global.daily_caps_state.per_source_counts[input.source] ?? 0;
  const wouldBe = usedToday + 1;
  const capped = wouldBe > cap;
  const writtenAmount = capped ? 0 : input.amount;

  const ev: XpEvent = {
    id: newId("xp"),
    ts,
    amount: writtenAmount,
    source: input.source,
    source_id: input.source_id ?? null,
    source_project: input.source_project ?? null,
    capped,
    note: input.note ?? null,
  };

  const next: GlobalMemory = {
    ...global,
    xp_log: [...global.xp_log, ev],
    xp_total: global.xp_total + writtenAmount,
    daily_caps_state: {
      ...global.daily_caps_state,
      per_source_counts: {
        ...global.daily_caps_state.per_source_counts,
        [input.source]: wouldBe,
      },
    },
  };
  await writeGlobal(home, next);
  return { written: ev, new_total: next.xp_total, capped };
}

export interface XpFilter {
  date?: string;
  project_id?: string;
  source?: XpSource;
}

export interface XpFilterResult {
  events: XpEvent[];
  total: number;
}

function sameLocalDay(iso: string, localDate: string): boolean {
  // Convert the ISO timestamp to a local YYYY-MM-DD for comparison.
  const d = new Date(iso);
  return localDateOf(d) === localDate;
}

export async function xpFor(
  home: string,
  filter: XpFilter,
): Promise<XpFilterResult> {
  const global = await readGlobal(home);
  if (!global) return { events: [], total: 0 };
  const events = global.xp_log.filter((ev) => {
    if (filter.source && ev.source !== filter.source) return false;
    if (filter.project_id && ev.source_project !== filter.project_id) return false;
    if (filter.date && !sameLocalDay(ev.ts, filter.date)) return false;
    return true;
  });
  const total = events.reduce((acc, ev) => acc + ev.amount, 0);
  return { events, total };
}

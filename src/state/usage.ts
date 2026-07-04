// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { appendFile, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { computeCost } from "../observability/cost-calc";

/** Critic Brain calls (`main`/`reflection`) plus long-task / interactive paid
 * runs (`arch_generate`/`explain`/`chat`). Additive string-literal kinds, no
 * schema change. `chat` added 2026-06-14 (cost-honesty batch A) so chat turns
 * stop spending invisibly to the rollup/budget gate. */
export type UsageKind =
  | "main"
  | "reflection"
  | "arch_generate"
  | "explain"
  | "chat"
  | "repo_summary"
  | "chat_capture";

/** Honesty marker for failed-run ledger entries.
 * - absent / `"real"` — usage reported by a successful call (legacy lines have
 *   no field at all; additive schema, no migration).
 * - `"tail_parsed"` — REAL tokens/cost recovered from a failed run's captured
 *   stdout tail (the spend happened; the run just exited non-zero).
 * - `"estimated"` — the pre-flight estimate, ledgered because the real usage
 *   was unrecoverable (truncated/absent tail). Pure estimate — excluded from
 *   budget token sums (user-locked semantics).
 * - `"derived"` — REAL SDK-reported tokens, but the SDK omitted
 *   total_cost_usd, so the cost figure is rate-table-derived
 *   (archCostFromUsage). Tokens count toward the budget like real; the marker
 *   exists so an audit can tell SDK-reported costs from computed ones
 */
export type UsageBasis = "real" | "tail_parsed" | "estimated" | "derived";

export interface UsageEvent {
  ts: string;
  kind: UsageKind;
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_cost_usd: number | null;
  basis?: UsageBasis;
}

export interface DailyRollup {
  schemaVersion: 1;
  day: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_tokens: number;
  total_cost_usd: number;
  brain_calls: number;
  reflections: number;
  computed_at_ms: number;
}

const KNOWN_KINDS: ReadonlySet<UsageKind> = new Set([
  "main",
  "reflection",
  "arch_generate",
  "explain",
  "chat",
  "repo_summary",
  "chat_capture",
]);

const EVENTS_FILE = "usage-events.jsonl";
const ROLLUP_FILE = "usage.json";

export function dayKey(now: Date, resetAtMinutes: number = 0): string {
  const shifted = new Date(now.getTime() - resetAtMinutes * 60 * 1000);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, "0");
  const d = String(shifted.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function appendUsageEvent(
  basePath: string,
  event: UsageEvent,
): Promise<void> {
  try {
    await mkdir(basePath, { recursive: true });
    await appendFile(
      join(basePath, EVENTS_FILE),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
  } catch {
    // never crash caller
  }
}

/** Raw usage as returned by a Brain/SDK call. Cache fields + cost are optional
 *  (chat's usage carries only input/output tokens). */
export interface BrainCallUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  total_cost_usd?: number | null;
}

/**
 * Append a usage-events ledger row for a single paid Brain call (explain/chat).
 * The ONE shared writer so every paid path ledgers consistently (cost-honesty
 * batch A). Cost resolution:
 *   - SDK reported `total_cost_usd` → pass through, `basis: "real"`.
 *   - else a `model` is known → derive via `computeCost`, `basis: "derived"`.
 *   - else (no cost, no model) → `total_cost_usd: null`, no basis (honest:
 *     tokens recorded, cost unknown; `loadDailyRollup` only sums numeric costs).
 * Call ONLY on a real (non-cache) successful/charged call — never on a cache
 * hit — so it can't double-bill. Never throws (delegates to appendUsageEvent).
 */
export async function ledgerBrainCall(
  basePath: string,
  args: {
    kind: UsageKind;
    session_id: string;
    usage: BrainCallUsage;
    model?: string;
  },
): Promise<void> {
  const u = args.usage;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  let total_cost_usd: number | null;
  let basis: UsageBasis | undefined;
  if (typeof u.total_cost_usd === "number") {
    total_cost_usd = u.total_cost_usd;
    basis = "real";
  } else if (args.model) {
    total_cost_usd = computeCost({
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cached_input_tokens: cacheRead,
      model: args.model,
    }).cost_usd;
    basis = "derived";
  } else {
    total_cost_usd = null;
    basis = undefined;
  }
  const event: UsageEvent = {
    ts: new Date().toISOString(),
    kind: args.kind,
    session_id: args.session_id,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: cacheCreate,
    cache_read_input_tokens: cacheRead,
    total_cost_usd,
    ...(basis ? { basis } : {}),
  };
  await appendUsageEvent(basePath, event);
}

function parseLine(line: string): UsageEvent | null {
  try {
    const parsed = JSON.parse(line) as UsageEvent;
    if (
      typeof parsed.ts !== "string" ||
      !KNOWN_KINDS.has(parsed.kind) ||
      typeof parsed.input_tokens !== "number" ||
      typeof parsed.output_tokens !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function emptyRollup(day: string, nowMs: number): DailyRollup {
  return {
    schemaVersion: 1,
    day,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_tokens: 0,
    total_cost_usd: 0,
    brain_calls: 0,
    reflections: 0,
    computed_at_ms: nowMs,
  };
}

export async function loadDailyRollup(
  basePath: string,
  now: Date,
  resetAtMinutes: number = 0,
): Promise<DailyRollup> {
  const today = dayKey(now, resetAtMinutes);
  const eventsPath = join(basePath, EVENTS_FILE);
  const rollup = emptyRollup(today, now.getTime());

  if (!existsSync(eventsPath)) {
    await writeRollup(basePath, rollup);
    return rollup;
  }

  try {
    const raw = await readFile(eventsPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const ev = parseLine(trimmed);
      if (!ev) continue;
      const eventDay = dayKey(new Date(ev.ts), resetAtMinutes);
      if (eventDay !== today) continue;
      // Budget semantics: token sums feed `evaluateBudget` — real tokens
      // (absent basis / "real" / "tail_parsed") count; pure-estimate entries
      // ("estimated") are honesty records, not billed tokens → excluded. Cost
      // stays all-numeric below (estUsd is the best-known spend for a burn
      // whose real figure was lost).
      if (ev.basis !== "estimated") {
        rollup.total_input_tokens += ev.input_tokens;
        rollup.total_output_tokens += ev.output_tokens;
        rollup.total_cache_tokens +=
          ev.cache_creation_input_tokens + ev.cache_read_input_tokens;
      }
      if (typeof ev.total_cost_usd === "number") {
        rollup.total_cost_usd += ev.total_cost_usd;
      }
      if (ev.kind === "main") rollup.brain_calls += 1;
      else if (ev.kind === "reflection") rollup.reflections += 1;
    }
  } catch {
    // fall through to whatever was aggregated so far
  }

  await writeRollup(basePath, rollup);
  return rollup;
}

async function writeRollup(
  basePath: string,
  rollup: DailyRollup,
): Promise<void> {
  try {
    await mkdir(basePath, { recursive: true });
    const finalPath = join(basePath, ROLLUP_FILE);
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmpPath, JSON.stringify(rollup, null, 2), "utf8");
    await rename(tmpPath, finalPath);
  } catch {
    // best-effort
  }
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Critic telemetry — per-tool status counters, gate decision counts, and
 * abstention rate tracking. Persisted as daily JSON files.
 *
 * Storage: {homeBase}/telemetry/critic-YYYY-MM-DD.json
 * Writes are atomic (write-temp + rename), matching the budget-config / usage pattern.
 * Recorder failures are swallowed — telemetry never crashes the critic.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { GateDecision } from "../critic/classify-output";
import type { ToolName, ToolStatus } from "../critic/tools/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CriticCounters = {
  /** YYYY-MM-DD UTC */
  date: string;
  totalCritiqueRuns: number;
  toolStatusCounts: Record<ToolName, Record<ToolStatus, number>>;
  abstentionCount: number;
  hardSuppressCount: number;
  passiveBubbleCount: number;
  /** NORMAL runs attempted (pre-guard; includes guard-rejected runs). Use normalAttemptCount - normalRejectedCount for actual accepted count. */
  normalAttemptCount: number;
  /** Guard-rejected NORMAL runs */
  normalRejectedCount: number;
  /** Top guard-reject reasons, binned by first ~80 chars of reason string */
  guardRejectReasons: Record<string, number>;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ALL_TOOL_NAMES: readonly ToolName[] = ["tsc", "eslint", "git-diff", "ripgrep"];

const ALL_TOOL_STATUSES: readonly ToolStatus[] = [
  "ok",
  "not_applicable",
  "not_installed",
  "timeout",
  "error",
  "output_too_large",
];

const GUARD_REJECT_KEY_MAX = 80;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function utcDateKey(now?: Date): string {
  const d = now ?? new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function telemetryDir(homeBase: string): string {
  return join(homeBase, "telemetry");
}

function telemetryPath(homeBase: string, date: string): string {
  return join(telemetryDir(homeBase), `critic-${date}.json`);
}

function emptyTelemetry(date: string): CriticCounters {
  const toolStatusCounts = Object.fromEntries(
    ALL_TOOL_NAMES.map((name) => [
      name,
      Object.fromEntries(ALL_TOOL_STATUSES.map((s) => [s, 0])),
    ]),
  ) as Record<ToolName, Record<ToolStatus, number>>;

  return {
    date,
    totalCritiqueRuns: 0,
    toolStatusCounts,
    abstentionCount: 0,
    hardSuppressCount: 0,
    passiveBubbleCount: 0,
    normalAttemptCount: 0,
    normalRejectedCount: 0,
    guardRejectReasons: {},
  };
}

/**
 * Parse stored JSON into a CriticCounters, filling defaults for any
 * missing fields (schema evolution safety).
 */
function parseTelemetry(raw: string, date: string): CriticCounters {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyTelemetry(date);
  }

  if (typeof parsed !== "object" || parsed === null) {
    return emptyTelemetry(date);
  }

  const base = emptyTelemetry(date);
  const obj = parsed as Record<string, unknown>;

  const pick = <T>(key: string, fallback: T): T =>
    key in obj && typeof obj[key] === typeof fallback ? (obj[key] as T) : fallback;

  const toolStatusCounts = { ...base.toolStatusCounts };
  if (typeof obj.toolStatusCounts === "object" && obj.toolStatusCounts !== null) {
    const raw_ = obj.toolStatusCounts as Record<string, unknown>;
    for (const name of ALL_TOOL_NAMES) {
      if (typeof raw_[name] === "object" && raw_[name] !== null) {
        const statusRow = raw_[name] as Record<string, unknown>;
        const merged = { ...toolStatusCounts[name] };
        for (const s of ALL_TOOL_STATUSES) {
          if (typeof statusRow[s] === "number") {
            merged[s] = statusRow[s] as number;
          }
        }
        toolStatusCounts[name] = merged;
      }
    }
  }

  const guardRejectReasons: Record<string, number> = {};
  if (typeof obj.guardRejectReasons === "object" && obj.guardRejectReasons !== null) {
    const raw_ = obj.guardRejectReasons as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw_)) {
      if (typeof v === "number") {
        guardRejectReasons[k] = v;
      }
    }
  }

  return {
    date,
    totalCritiqueRuns: pick("totalCritiqueRuns", 0),
    toolStatusCounts,
    abstentionCount: pick("abstentionCount", 0),
    hardSuppressCount: pick("hardSuppressCount", 0),
    passiveBubbleCount: pick("passiveBubbleCount", 0),
    normalAttemptCount: pick("normalAttemptCount", 0),
    normalRejectedCount: pick("normalRejectedCount", 0),
    guardRejectReasons,
  };
}

/**
 * Read the today file, returning an empty telemetry if missing.
 */
async function readTelemetry(homeBase: string, date: string): Promise<CriticCounters> {
  const path = telemetryPath(homeBase, date);
  if (!existsSync(path)) return emptyTelemetry(date);
  try {
    const raw = await readFile(path, "utf8");
    return parseTelemetry(raw, date);
  } catch {
    return emptyTelemetry(date);
  }
}

/**
 * Atomically write the telemetry object. Failures are NOT thrown — they are
 * logged to stderr and swallowed.
 */
async function writeTelemetry(homeBase: string, data: CriticCounters): Promise<void> {
  const dir = telemetryDir(homeBase);
  const finalPath = telemetryPath(homeBase, data.date);
  const suffix = `${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
  const tmpPath = `${finalPath}.tmp.${suffix}`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await rename(tmpPath, finalPath);
  } catch (err) {
    console.error(`[siltpoke telemetry] write failed: ${err}`);
    // Attempt to clean up tmp if it exists — best effort.
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(tmpPath);
    } catch {
      // ignore
    }
  }
}

/**
 * Mutex per homeBase path — ensures concurrent increments within the same
 * process don't interleave read-modify-write cycles.
 */
const _locks = new Map<string, Promise<void>>();

async function withLock(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = _locks.get(key) ?? Promise.resolve();
  let resolveCurrent!: () => void;
  const current = new Promise<void>((r) => { resolveCurrent = r; });
  _locks.set(key, current);
  try {
    await prev;
    await fn();
  } finally {
    resolveCurrent();
    if (_locks.get(key) === current) {
      _locks.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a tool execution result for today's telemetry.
 * Non-blocking: failures are swallowed after logging to stderr.
 */
export async function recordToolRun(
  homeBase: string,
  tool: ToolName,
  status: ToolStatus,
): Promise<void> {
  // Defense-in-depth: ignore tool names outside the known set. The caller
  // should only pass the four real tools, but a stray key (e.g. from iterating
  // a wider results object) must be a silent no-op, not a thrown+logged cell
  // lookup on an undefined counter row.
  if (!ALL_TOOL_NAMES.includes(tool)) return;
  await withLock(homeBase, async () => {
    try {
      const date = utcDateKey();
      const tel = await readTelemetry(homeBase, date);
      const updated: CriticCounters = {
        ...tel,
        toolStatusCounts: {
          ...tel.toolStatusCounts,
          [tool]: {
            ...tel.toolStatusCounts[tool],
            [status]: tel.toolStatusCounts[tool][status] + 1,
          },
        },
      };
      await writeTelemetry(homeBase, updated);
    } catch (err) {
      console.error(`[siltpoke telemetry] recordToolRun failed: ${err}`);
    }
  });
}

/**
 * Record a gate decision for today's telemetry.
 * HARD_SUPPRESS increments both hardSuppressCount and abstentionCount.
 * Each call also increments totalCritiqueRuns.
 */
export async function recordGateDecision(
  homeBase: string,
  decision: GateDecision,
): Promise<void> {
  await withLock(homeBase, async () => {
    try {
      const date = utcDateKey();
      const tel = await readTelemetry(homeBase, date);
      const updated: CriticCounters = {
        ...tel,
        totalCritiqueRuns: tel.totalCritiqueRuns + 1,
        hardSuppressCount:
          decision === "HARD_SUPPRESS" ? tel.hardSuppressCount + 1 : tel.hardSuppressCount,
        abstentionCount:
          decision === "HARD_SUPPRESS" ? tel.abstentionCount + 1 : tel.abstentionCount,
        passiveBubbleCount:
          decision === "PASSIVE_BUBBLE" ? tel.passiveBubbleCount + 1 : tel.passiveBubbleCount,
        normalAttemptCount:
          decision === "NORMAL" ? tel.normalAttemptCount + 1 : tel.normalAttemptCount,
      };
      await writeTelemetry(homeBase, updated);
    } catch (err) {
      console.error(`[siltpoke telemetry] recordGateDecision failed: ${err}`);
    }
  });
}

/**
 * Record a guard-rejected NORMAL run. Truncates the reason to
 * GUARD_REJECT_KEY_MAX chars to prevent unbounded key growth.
 */
export async function recordGuardReject(
  homeBase: string,
  reason: string,
): Promise<void> {
  await withLock(homeBase, async () => {
    try {
      const date = utcDateKey();
      const tel = await readTelemetry(homeBase, date);
      const key = reason.slice(0, GUARD_REJECT_KEY_MAX);
      const updated: CriticCounters = {
        ...tel,
        normalRejectedCount: tel.normalRejectedCount + 1,
        guardRejectReasons: {
          ...tel.guardRejectReasons,
          [key]: (tel.guardRejectReasons[key] ?? 0) + 1,
        },
      };
      await writeTelemetry(homeBase, updated);
    } catch (err) {
      console.error(`[siltpoke telemetry] recordGuardReject failed: ${err}`);
    }
  });
}

/**
 * Return today's telemetry. Returns an empty default when no file exists yet.
 */
export async function getTodayTelemetry(homeBase: string): Promise<CriticCounters> {
  const date = utcDateKey();
  return readTelemetry(homeBase, date);
}

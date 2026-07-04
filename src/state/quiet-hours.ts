// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface QuietHoursConfig {
  start: string | null;
  end: string | null;
  timezone: string;
}

export const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  start: null,
  end: null,
  timezone: "local",
};

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = parseInt(match[1]!, 10);
  const m = parseInt(match[2]!, 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

export async function loadQuietHoursConfig(
  basePath: string,
): Promise<QuietHoursConfig> {
  const configPath = join(basePath, "config.json");
  if (!existsSync(configPath)) return DEFAULT_QUIET_HOURS;
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { quietHours?: Record<string, unknown> };
    const q = parsed?.quietHours ?? {};
    const start = typeof q.start === "string" && parseTime(q.start) !== null
      ? q.start
      : null;
    const end = typeof q.end === "string" && parseTime(q.end) !== null
      ? q.end
      : null;
    const timezone = typeof q.timezone === "string" ? q.timezone : "local";
    return { start, end, timezone };
  } catch {
    return DEFAULT_QUIET_HOURS;
  }
}

export function isQuietHour(
  now: Date,
  config: QuietHoursConfig,
): boolean {
  const startMin = parseTime(config.start);
  const endMin = parseTime(config.end);
  if (startMin === null || endMin === null) return false;
  if (startMin === endMin) return false;

  const nowMin = now.getHours() * 60 + now.getMinutes();

  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // wrap-around (e.g. 23:00 → 08:00)
  return nowMin >= startMin || nowMin < endMin;
}

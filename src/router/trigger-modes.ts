// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type TriggerMode = "always" | "gates" | "on_demand" | "hybrid";

export interface TriggerConfig {
  mode: TriggerMode;
  gateEvents: string[];
}

export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  mode: "gates",
  gateEvents: ["Stop", "PreCompact"],
};

function parseMode(value: unknown): TriggerMode {
  if (
    value === "always" ||
    value === "gates" ||
    value === "on_demand" ||
    value === "hybrid"
  ) {
    return value;
  }
  return DEFAULT_TRIGGER_CONFIG.mode;
}

export async function loadTriggerConfig(
  basePath: string,
): Promise<TriggerConfig> {
  const configPath = join(basePath, "config.json");
  if (!existsSync(configPath)) return DEFAULT_TRIGGER_CONFIG;
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      triggerMode?: unknown;
      gateEvents?: unknown;
    };
    const mode = parseMode(parsed.triggerMode);
    const gateEvents =
      Array.isArray(parsed.gateEvents) &&
      parsed.gateEvents.every((e) => typeof e === "string")
        ? (parsed.gateEvents as string[])
        : DEFAULT_TRIGGER_CONFIG.gateEvents;
    return { mode, gateEvents };
  } catch {
    return DEFAULT_TRIGGER_CONFIG;
  }
}

export type TriggerSkipReason =
  | "wrong_event_mode"
  | "on_demand_no_bypass";

export interface TriggerDecision {
  fire: boolean;
  reason?: TriggerSkipReason;
}

export function evaluateTriggerMode(
  event: { hook_event_name?: string },
  config: TriggerConfig,
  bypassActive: boolean,
): TriggerDecision {
  const eventName = event.hook_event_name ?? "";

  if (config.mode === "always") {
    return { fire: true };
  }
  if (config.mode === "on_demand") {
    return bypassActive
      ? { fire: true }
      : { fire: false, reason: "on_demand_no_bypass" };
  }
  // gates or hybrid
  if (bypassActive && config.mode === "hybrid") {
    return { fire: true };
  }
  if (config.gateEvents.includes(eventName)) {
    return { fire: true };
  }
  return { fire: false, reason: "wrong_event_mode" };
}

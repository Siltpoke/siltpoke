// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Installer helper: register the SessionStart hook in Claude Code settings.json.
 *
 * The SessionStart hook runs `handle-session-start.ts` at the beginning of each
 * Claude Code session, capturing the git HEAD SHA before any code is written.
 * This enables the Stop hook to diff against the correct baseline commit rather
 * than the potentially-advanced HEAD after commits during the session.
 */

import type { StopHookPair } from "./settings-mutator";

interface HookEntry {
  type?: string;
  command?: string;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

interface HookMatcher {
  matcher?: string;
  hooks?: HookEntry[];
}

interface Settings {
  hooks?: Record<string, HookMatcher[] | undefined>;
  [key: string]: unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asSettings(input: unknown): Settings {
  if (typeof input !== "object" || input === null) return {};
  return input as Settings;
}

/** Returns true if a SessionStart hook with the given command is already registered. */
export function hasSessionStartHook(input: unknown, hookCommand: string): boolean {
  const settings = asSettings(input);
  const matchers = settings.hooks?.SessionStart;
  if (!Array.isArray(matchers)) return false;
  for (const m of matchers) {
    const hooks = m?.hooks ?? [];
    if (hooks.some((h) => h.type === "command" && h.command === hookCommand)) {
      return true;
    }
  }
  return false;
}

/** Register a SessionStart hook command if not already present. Returns new settings. */
export function registerSessionStartHook(
  input: unknown,
  hookCommand: string,
): Record<string, unknown> {
  const next = clone(asSettings(input));
  if (hasSessionStartHook(next, hookCommand)) return next;
  if (!next.hooks) next.hooks = {};
  const existing = next.hooks.SessionStart;
  const entry: HookMatcher = {
    matcher: "",
    hooks: [{ type: "command", command: hookCommand }],
  };
  next.hooks.SessionStart = Array.isArray(existing)
    ? [...existing, entry]
    : [entry];
  return next;
}

/** Remove the SessionStart hook command. Returns new settings. */
export function unregisterSessionStartHook(
  input: unknown,
  hookCommand: string,
): Record<string, unknown> {
  const next = clone(asSettings(input));
  if (!Array.isArray(next.hooks?.SessionStart)) return next;
  const filtered = next
    .hooks?.SessionStart?.map((m) => ({
      ...m,
      hooks: (m.hooks ?? []).filter(
        (h) => !(h.type === "command" && h.command === hookCommand),
      ),
    }))
    .filter((m) => (m.hooks ?? []).length > 0);
  if (filtered.length > 0) {
    next.hooks!.SessionStart = filtered;
  } else {
    delete next.hooks?.SessionStart;
    if (next.hooks && Object.keys(next.hooks).length === 0) {
      delete next.hooks;
    }
  }
  return next;
}

// Re-export StopHookPair so callers don't need a separate import
export type { StopHookPair };

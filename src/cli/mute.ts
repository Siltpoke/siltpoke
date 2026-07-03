// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * v1.1-I — `/siltpoke-mute [duration]` CLI.
 *
 * Silences Siltpoke for a duration (or indefinitely). Writes
 * `~/.siltpoke/mute.json`; router checks it before any other gate
 * (including wake bypass). Mute beats wake.
 *
 * Usage:
 *   bun src/cli/mute.ts 15m
 *   bun src/cli/mute.ts 1h
 *   bun src/cli/mute.ts 2d
 *   bun src/cli/mute.ts indefinite
 *   bun src/cli/mute.ts 1h --json
 */
import { siltpokeRoot } from "../installer/paths";
import { writeMute, type MuteFile } from "../state/mute";

export interface ParsedDuration {
  /** ms to add to `now` for `until_ms`. `null` iff `indefinite: true`. */
  ms: number | null;
  indefinite: boolean;
  /** Human label used in output ("15m" / "1h" / "indefinite"). */
  label: string;
}

const DURATION_RE = /^(\d+)([mhd])$/;
const MS_PER_UNIT: Record<string, number> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

/**
 * Parse a duration argument. Returns either a structured result or an
 * error message suitable for stderr.
 */
export function parseDuration(input: string): { ok: true; value: ParsedDuration } | { ok: false; error: string } {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, error: "duration is required. Usage: siltpoke-mute <Nm|Nh|Nd|indefinite>" };
  }
  if (input === "indefinite") {
    return { ok: true, value: { ms: null, indefinite: true, label: "indefinite" } };
  }
  const m = DURATION_RE.exec(input);
  if (!m) {
    return {
      ok: false,
      error: `invalid duration "${input}". Use <N>m / <N>h / <N>d (e.g. 15m, 1h, 2d) or "indefinite".`,
    };
  }
  const num = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, error: `duration must be a positive integer, got "${input}"` };
  }
  const unit = m[2]!;
  return { ok: true, value: { ms: num * MS_PER_UNIT[unit]!, indefinite: false, label: input } };
}

export interface MuteResult {
  muted: true;
  indefinite: boolean;
  until_ms: number | null;
  set_at: string;
  mute_path: string;
  label: string;
}

export interface MuteOptions {
  homeBase?: string;
  durationArg: string;
  now?: () => Date;
}

/**
 * Parse the duration, write `mute.json`, return a result struct.
 *
 * Throws an `Error` (with a `usage` message) if the duration is
 * invalid — caller should print that message to stderr and exit 1.
 */
export function runMute(opts: MuteOptions): MuteResult {
  const homeBase = opts.homeBase ?? siltpokeRoot();
  const now = (opts.now ?? (() => new Date()))();
  const parsed = parseDuration(opts.durationArg);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const until_ms = parsed.value.indefinite ? null : now.getTime() + parsed.value.ms!;
  const mute: MuteFile = {
    schemaVersion: 1,
    until_ms,
    indefinite: parsed.value.indefinite,
    set_at: now.toISOString(),
  };
  const mute_path = writeMute(homeBase, mute);
  return {
    muted: true,
    indefinite: parsed.value.indefinite,
    until_ms,
    set_at: mute.set_at,
    mute_path,
    label: parsed.value.label,
  };
}

function formatWallClock(epochMs: number): string {
  // YYYY-MM-DD HH:MM in local time — easier to read than ISO UTC.
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mn = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mn}`;
}

export function formatMuteHuman(result: MuteResult): string {
  if (result.indefinite) {
    return `Siltpoke muted indefinitely. Run /siltpoke-unmute to resume.\n`;
  }
  const wall = formatWallClock(result.until_ms!);
  return `Siltpoke muted until ${wall} (${result.label} from now). Run /siltpoke-unmute to resume.\n`;
}

export function formatMuteJson(result: MuteResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const jsonFlag = argv.includes("--json");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const durationArg = positional[0] ?? "";
  try {
    const result = runMute({ durationArg });
    if (jsonFlag) {
      process.stdout.write(formatMuteJson(result));
    } else {
      process.stdout.write(formatMuteHuman(result));
    }
    process.exit(0);
  } catch (e) {
    process.stderr.write(`siltpoke-mute: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

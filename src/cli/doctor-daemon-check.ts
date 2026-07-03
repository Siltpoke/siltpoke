// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Doctor daemon-staleness check.
 *
 * Fetches GET /api/daemon-health from the running daemon and maps the
 * reported state to a doctor row:
 *   - "current" → ✓ "daemon up-to-date (<shortSha>)"
 *   - "behind"  → ⚠ "daemon N commits behind — restart"
 *   - "unknown" → neutral "daemon build version unknown (not a git checkout)"
 *   - daemon down / fetch fails → neutral "skipped (daemon down)"
 *
 * Warn-only by design: every reachable state reports pass=true so the
 * staleness signal never fails the doctor exit code — the ⚠ is purely visual.
 * The existing daemon-down check owns the "down" failure; here we only skip.
 *
 * Split from doctor.ts to keep that file under the 400-LOC ratchet, mirroring
 * doctor-brain-check.ts. The state→row mapping is a pure function
 * (mapDaemonHealthToCheck) so all 4 cases are unit-testable without a live
 * daemon; the async fetch wrapper is thin and injectable.
 */
import type { CheckResult, DoctorOptions } from "./doctor";

const DEFAULT_DAEMON_HEALTH_URL = "http://127.0.0.1:9876/api/daemon-health";

/** Shape of the /api/daemon-health payload's `data`. */
export interface DaemonHealth {
  bootSha: string | null;
  bootTime: string | null;
  headSha: string | null;
  commitsBehind: number | null;
  state: "current" | "behind" | "unknown";
}

const CHECK_NAME = "daemon running latest code";

const VALID_STATES: ReadonlySet<DaemonHealth["state"]> = new Set(["current", "behind", "unknown"]);

/**
 * Narrow an unknown payload to DaemonHealth. Validates `state` is one of the
 * 3 contract literals before trusting the shape — an out-of-contract or
 * malformed payload returns null (→ treated as daemon-down / "skipped"), which
 * is more honest than blindly casting and mis-rendering a garbage state.
 */
function asDaemonHealth(data: unknown): DaemonHealth | null {
  if (typeof data !== "object" || data === null) return null;
  const state = (data as { state?: unknown }).state;
  if (typeof state !== "string" || !VALID_STATES.has(state as DaemonHealth["state"])) return null;
  return data as DaemonHealth;
}

/**
 * Short SHA = first 8 chars. Falls back to "(no sha)" when bootSha is null —
 * a non-git/force-push daemon reports state "unknown" (not "current"), so this
 * branch is unreachable for the "current" row in practice; the label is honest
 * defense (the daemon isn't "unknown", it just has no git context).
 */
function shortSha(sha: string | null): string {
  if (typeof sha !== "string" || sha.length === 0) return "(no sha)";
  return sha.slice(0, 8);
}

/**
 * Pure state→row mapping. `health === null` means the daemon was unreachable
 * (down / fetch failed) — we skip rather than fail (existing daemon-down check
 * owns that failure). Always pass=true (warn-only); `status` carries the
 * visual distinction (warn for behind, info for unknown/skipped).
 */
export function mapDaemonHealthToCheck(health: DaemonHealth | null): CheckResult {
  if (health === null) {
    return { name: CHECK_NAME, pass: true, status: "info", detail: "skipped (daemon down)" };
  }
  switch (health.state) {
    case "current":
      return {
        name: CHECK_NAME,
        pass: true,
        status: "pass",
        detail: `daemon up-to-date (${shortSha(health.bootSha)})`,
      };
    case "behind": {
      // commitsBehind should be a positive number when state==="behind"; guard
      // a null/non-number defensively so we never render "null commits behind".
      const n =
        typeof health.commitsBehind === "number" && Number.isFinite(health.commitsBehind)
          ? health.commitsBehind
          : "?";
      return {
        name: CHECK_NAME,
        pass: true,
        status: "warn",
        detail: `daemon ${n} commits behind — restart`,
      };
    }
    default:
      // "unknown" (non-git checkout / force-push / git error) — neutral line,
      // never a number.
      return {
        name: CHECK_NAME,
        pass: true,
        status: "info",
        detail: "daemon build version unknown (not a git checkout)",
      };
  }
}

/**
 * Async check: fetch /api/daemon-health, then map. Any fetch failure / non-200
 * / malformed payload → treated as daemon-down (null → "skipped"), never throws.
 * `fetchFn` is injectable for tests (no live daemon needed).
 */
export async function checkDaemonStaleness(opts: DoctorOptions = {}): Promise<CheckResult> {
  const url = opts.daemonHealthUrl ?? DEFAULT_DAEMON_HEALTH_URL;
  const doFetch = opts.fetchFn ?? fetch;
  let health: DaemonHealth | null = null;
  try {
    const res = await doFetch(url);
    if (res.ok) {
      const body = (await res.json()) as { success?: unknown; data?: unknown };
      if (body?.success === true) {
        health = asDaemonHealth(body.data);
      }
    }
  } catch {
    // Daemon down / connection refused / timeout / malformed JSON → skip.
    health = null;
  }
  return mapDaemonHealthToCheck(health);
}

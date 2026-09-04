// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Doctor daemon checks (staleness / alive / autostart).
 *
 * Staleness: fetches GET /api/daemon-health from the running daemon and maps
 * the reported state to a doctor row:
 *   - "current" → ✓ "daemon up-to-date (<shortSha>)"
 *   - "behind"  → ⚠ "daemon N commits behind — restart"
 *   - "unknown" → neutral "daemon build version unknown (not a git checkout)"
 *   - daemon down / fetch fails → neutral "skipped (daemon down)"
 *
 * Alive (track #6 T5, AC11; opt-in semantics added for the daemon-opt-in
 * slice): probes GET /api/ping with a short timeout — up → ✓. Down branches
 * on `daemon.enabled` (config.json, default false — see src/config/
 * daemon-config.ts): disabled is the expected default state → ◦ info "daemon:
 * off (opt-in — open /siltpoke-dashboard to enable)", never a failure.
 * Enabled-but-unreachable is a genuine fault (the user opted in and it's not
 * there) → ✗ fail.
 *
 * Autostart (track #6 T5, AC11): checks for the platform's boot artifact
 * (launchd plist on darwin, systemd user unit on linux) — installed → ✓;
 * absent → ◦ info with the setup hint; other platforms → ◦ skip note.
 *
 * Off/absent states are info-only by design (a stopped daemon is normal now
 * that it is opt-in) — those report pass=true and ⚠/◦ are purely visual. The
 * ONE genuine failure is enabled-but-unreachable (above): the user opted in
 * and the daemon isn't there → pass=false → fails the doctor exit code.
 *
 * Split from doctor.ts to keep that file under the 400-LOC ratchet, mirroring
 * doctor-brain-check.ts. The staleness state→row mapping is a pure function
 * (mapDaemonHealthToCheck) so all 4 cases are unit-testable without a live
 * daemon; the async fetch wrappers are thin and injectable.
 */
import { existsSync } from "node:fs";
import { loadDaemonConfig } from "../config/daemon-config";
import { defaultPlistPath } from "../installer/launchd";
import { siltpokeRoot } from "../installer/paths";
import { defaultUnitPath } from "../installer/systemd";
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

// ---------------------------------------------------------------------------
// Daemon-alive check (track #6 T5, AC11).
// ---------------------------------------------------------------------------

const DEFAULT_DAEMON_PING_URL = "http://127.0.0.1:9876/api/ping";
const ALIVE_CHECK_NAME = "daemon alive (/api/ping)";
const PING_TIMEOUT_MS = 500;

const DAEMON_OFF_DETAIL = "daemon: off (opt-in — open /siltpoke-dashboard to enable)";
const DAEMON_ENABLED_UNREACHABLE_DETAIL =
  "daemon.enabled is true but /api/ping is unreachable — try /siltpoke-restart-daemon";

/**
 * Probe /api/ping with a short timeout. Up → ✓ pass. Down defers to
 * `daemon.enabled` (default false — the daemon is opt-in, see
 * src/config/daemon-config.ts): disabled is the normal, expected state → ◦
 * info row, never a failure. Enabled (the user opened `/siltpoke-dashboard`)
 * but unreachable is a genuine fault → ✗ fail, since the respawn gate should
 * be keeping it alive. `fetchFn` and `loadDaemonConfigFn` are injectable for
 * tests (no live daemon / real config.json needed).
 */
export async function checkDaemonAlive(opts: DoctorOptions = {}): Promise<CheckResult> {
  const url = opts.daemonPingUrl ?? DEFAULT_DAEMON_PING_URL;
  const doFetch = opts.fetchFn ?? fetch;
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    if (res.ok) {
      return { name: ALIVE_CHECK_NAME, pass: true, status: "pass", detail: null };
    }
  } catch {
    // Connection refused / timeout → offline; fall through to the enabled check.
  }
  const home = opts.siltpokeHome ?? siltpokeRoot();
  const loadCfg = opts.loadDaemonConfigFn ?? loadDaemonConfig;
  const { enabled } = await loadCfg(home);
  if (!enabled) {
    return { name: ALIVE_CHECK_NAME, pass: true, status: "info", detail: DAEMON_OFF_DETAIL };
  }
  return { name: ALIVE_CHECK_NAME, pass: false, detail: DAEMON_ENABLED_UNREACHABLE_DETAIL };
}

// ---------------------------------------------------------------------------
// Autostart-presence check (track #6 T5, AC11).
// ---------------------------------------------------------------------------

const AUTOSTART_CHECK_NAME = "daemon autostart configured";

/**
 * Info-only check for the platform's boot artifact (launchd plist / systemd
 * user unit). NEVER fails the run: absent → ◦ info with the setup hint;
 * unsupported platform → ◦ skip note. `platform` / `autostartPath` are
 * injectable for tests.
 */
export function checkAutostart(opts: DoctorOptions = {}): CheckResult {
  const platform = opts.platform ?? process.platform;
  let artifactPath: string;
  if (platform === "darwin") {
    artifactPath = opts.autostartPath ?? defaultPlistPath();
  } else if (platform === "linux") {
    artifactPath = opts.autostartPath ?? defaultUnitPath();
  } else {
    return {
      name: AUTOSTART_CHECK_NAME,
      pass: true,
      status: "info",
      detail: `skipped (autostart unsupported on ${platform})`,
    };
  }
  if (existsSync(artifactPath)) {
    return {
      name: AUTOSTART_CHECK_NAME,
      pass: true,
      status: "pass",
      detail: `installed (${artifactPath})`,
    };
  }
  return {
    name: AUTOSTART_CHECK_NAME,
    pass: true,
    status: "info",
    detail: "not installed — run `/siltpoke-setup`",
  };
}

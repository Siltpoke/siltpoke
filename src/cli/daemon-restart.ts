// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { spawnSync } from "node:child_process";
import { refreshMenubar } from "../hooks/menubar-refresh";
import type { ExecSyncFn } from "../installer/launchd";
import { siltpokeRoot } from "../installer/paths";
import { writeRestartOutcome, type RestartOutcome } from "./restart-outcome";

export const DAEMON_LABEL = "io.siltpoke.daemon";

/**
 * True iff a launchd job for DAEMON_LABEL is registered in the caller's GUI
 * domain — i.e. `launchctl print gui/<uid>/<label>` exits 0. `print` (unlike
 * `kickstart`) is a pure read: it never starts, stops, or touches the job, so
 * it is safe to call just to decide WHICH restart mechanism to use.
 *
 * This is the branch condition for unifying the two restart paths: when a
 * launchd job is installed, `restart-daemon` must delegate to `runRestart()`
 * (launchd kickstart) instead of spawning a manual detached process that would
 * squat the port launchd is about to rebind.
 */
export function isLaunchdJobInstalled(
  exec: ExecSyncFn = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }),
  uid: number = process.getuid?.() ?? 0,
): boolean {
  const r = exec("launchctl", ["print", `gui/${uid}/${DAEMON_LABEL}`]);
  return r.status === 0;
}

/** How long to wait for the restarted daemon to come up and answer. */
const POLL_ATTEMPTS = 12;
const POLL_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 500;

/**
 * Identity of whatever PROCESS is currently serving the dashboard.
 *
 * Deliberately not `bootSha`/`bootTime` from the same endpoint: those describe
 * the COMMIT the daemon booted from, so two different processes booted from the
 * same commit report identical values. Comparing them would call a perfectly
 * good restart a failure whenever no commit landed in between — which is most
 * restarts — and then blame a port-squatter that does not exist. Only a
 * per-process value can answer "is this still the same daemon?".
 */
export interface ServingIdentity {
  pid: number;
  startedAt?: string;
}

/**
 * What the probe learned. THREE states, not two — collapsing the third into
 * "nothing answered" was a real bug caught by the live smoke: a daemon built
 * before `pid` was added to /api/daemon-health answers perfectly well but
 * cannot identify itself, and reporting "no daemon is answering" while the
 * dashboard is plainly open is exactly the message-does-not-match-reality
 * failure this whole change exists to end. Every user hits this on the upgrade
 * that introduces the field, because the daemon still running IS the old one.
 */
export type ProbeResult =
  | { kind: "none" }
  | { kind: "unidentified" }
  | { kind: "identified"; identity: ServingIdentity };

export interface RestartDeps {
  exec?: ExecSyncFn;
  uid?: number;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /**
   * Reads the SERVING daemon's boot identity, or null when nothing answers.
   * Injected so the verification is testable without a live daemon.
   */
  probeBoot?: () => Promise<ProbeResult>;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Records the outcome for the menu bar. Injectable for tests; the default
   * writes `~/.siltpoke/last-restart.json`. Every terminal path reports through
   * it — a restart whose result is only on a discarded stderr is exactly the
   * invisibility this whole change exists to end.
   */
  recordOutcome?: (outcome: RestartOutcome) => void;
  now?: () => Date;
  /**
   * Best-effort SwiftBar re-render trigger, fired right after the outcome is
   * recorded (FIX C — refresh timing). The menu's own "Restart daemon" row
   * carries `refresh=true`, but that fires ON CLICK — before the launchd
   * kickstart + verification poll below has even started, so it re-renders
   * the STALE outcome instead of the fresh one. This one fires AFTER the
   * outcome is known, so the ✓/⚠ row is visible on the very next render
   * instead of waiting for SwiftBar's 1-minute auto-refresh. Defaults to the
   * real `refreshMenubar` (macOS-only `open swiftbar://refreshplugin?name=
   * siltpoke`, itself already try/catch-guarded and a no-op off darwin).
   * Injectable so tests never shell out to `open`.
   */
  triggerMenubarRefresh?: () => void;
}

function daemonPort(): number {
  return process.env.PORT ? Number(process.env.PORT) : 9876;
}

/**
 * Turn a /api/daemon-health response into a ProbeResult. Exported and pure so
 * the three-way classification is directly testable — the live smoke found that
 * this exact step was wrong (an old build's answer was being read as silence),
 * and every unit test injects `probeBoot`, so nothing else would have covered it.
 */
export function classifyHealthResponse(ok: boolean, body: unknown): ProbeResult {
  if (!ok) return { kind: "none" };
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  const pid = data?.pid;
  // Answered, but from a build that predates the pid field.
  if (typeof pid !== "number" || !Number.isFinite(pid)) return { kind: "unidentified" };
  const startedAt = data?.startedAt;
  return {
    kind: "identified",
    identity: { pid, startedAt: typeof startedAt === "string" ? startedAt : undefined },
  };
}

async function defaultProbeBoot(): Promise<ProbeResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/api/daemon-health`, {
      // Short on purpose: this runs up to POLL_ATTEMPTS times behind a menu-bar
      // click, and a socket that accepts but never answers must not stretch the
      // whole loop into tens of seconds.
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return classifyHealthResponse(res.ok, await res.json());
  } catch {
    return { kind: "none" };
  }
}

/** True when these are demonstrably different serving processes. */
function isDifferentProcess(a: ServingIdentity, b: ServingIdentity): boolean {
  if (a.pid !== b.pid) return true;
  // Same pid can be reused; startedAt disambiguates when both report it.
  return Boolean(a.startedAt && b.startedAt && a.startedAt !== b.startedAt);
}

/**
 * Restart the daemon via `launchctl kickstart -k` (AC22). launchd owns the
 * restarted process → cwd-independent, not a child of the caller (INV3). On
 * failure (daemon not launchd-managed) we surface a friendly hint and exit
 * non-zero — deliberately NOT a stop+start spawn, which would create a
 * cwd-inheriting orphan.
 *
 * VERIFIES THE OUTCOME, which is what the second half of this function is for.
 * `launchctl kickstart` exits 0 whenever the JOB exists; it says nothing about
 * whether the daemon actually serving the dashboard changed. Measured
 * 2026-07-21: a non-launchd `bun dist/siltpoke-daemon.js start` process started
 * by hand hours earlier held :9876, so every kicked job failed to bind and died
 * while the orphan kept serving — and this function printed "restarted" each
 * time. The dashboard went on reporting itself commits-behind, correctly, and
 * the menu-bar item looked broken when it was in fact faithfully reporting an
 * exit code that cannot see the thing the user cares about.
 *
 * So: read the serving daemon's boot identity before the kick, poll for it to
 * change after, and claim success only when it does. A restart that restarted
 * nothing now says so, and names the likely cause.
 */
export async function runRestart(deps: RestartDeps = {}): Promise<number> {
  const exec: ExecSyncFn = deps.exec ?? ((cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }));
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const probeBoot = deps.probeBoot ?? defaultProbeBoot;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const recordOutcome =
    deps.recordOutcome ?? ((o: RestartOutcome) => writeRestartOutcome(siltpokeRoot(process.env), o));
  const triggerMenubarRefresh = deps.triggerMenubarRefresh ?? (() => refreshMenubar());
  const report = (ok: boolean, summary: string, message: string): void => {
    try {
      recordOutcome({ ok, at: now().toISOString(), summary, message });
    } catch {
      // never fatal
    }
    // FIX C: re-render the menu right after the outcome is known, rather than
    // waiting on SwiftBar's 1-minute poll or the click-time `refresh=true`
    // (which fires too early — before this function's kick + verify loop has
    // even run). Best-effort and independent of the recordOutcome try/catch
    // above: a refresh-trigger failure must never mask (or be masked by) an
    // outcome-write failure.
    try {
      triggerMenubarRefresh();
    } catch {
      // never fatal
    }
  };

  // Any probe failure reads as "not answering" — never as success.
  const probe = async (): Promise<ProbeResult> => {
    try {
      return await probeBoot();
    } catch {
      return { kind: "none" };
    }
  };

  const before = await probe();
  let last: ProbeResult = before;

  const r = exec("launchctl", ["kickstart", "-k", `gui/${uid}/${DAEMON_LABEL}`]);
  if (r.status !== 0) {
    const msg = "not autostart-managed — run 'siltpoked start' (or 'siltpoked install-autostart' first)";
    stderr(`siltpoked: ${msg}\n`);
    report(false, "not set up for autostart", msg);
    return 1;
  }

  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const now = await probe();
    last = now;
    // A restart is proven when: nothing was serving and something now is; or an
    // unidentifiable (old-build) daemon has been replaced by one that can
    // identify itself; or two identified processes differ.
    const proven =
      (before.kind === "none" && now.kind !== "none") ||
      (before.kind === "unidentified" && now.kind === "identified") ||
      (before.kind === "identified" &&
        now.kind === "identified" &&
        isDifferentProcess(now.identity, before.identity));
    if (proven) {
      stdout("siltpoked: restarted\n");
      report(true, "restarted", "restarted");
      return 0;
    }
  }

  const port = daemonPort();
  // Keyed on what is serving NOW, not on what was serving before: if the kick
  // killed the old daemon and nothing replaced it, nothing is holding the port
  // and sending the user on an lsof hunt would be a false lead.
  if (last.kind === "unidentified") {
    const msg =
      `a daemon is answering on :${port} but it is too old to report which process it is, ` +
      `so this restart cannot be verified — it is almost certainly the stale one holding the port`;
    stderr(
      `siltpoked: kickstart succeeded — ${msg}. Find it with:\n` +
        `  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
        `If it is not launchd-managed, stop it and restart again.\n`,
    );
    report(false, "couldn't be verified", msg);
    return 1;
  }
  if (last.kind === "none") {
    const msg =
      `kickstart succeeded but no daemon is answering on :${port} — ` +
      `check 'launchctl print gui/${uid}/${DAEMON_LABEL}' for its last exit code`;
    stderr(`siltpoked: ${msg}\n`);
    report(false, "nothing is running", msg);
    return 1;
  }
  const msg =
    `the daemon serving :${port} did not change (still pid ${last.identity.pid}) — ` +
    `another process is probably holding the port`;
  stderr(
    `siltpoked: kickstart succeeded but ${msg}, ` +
      `so the restarted job cannot bind and exits. Find it with:\n` +
      `  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
      `If it is not launchd-managed, stop it and restart again.\n`,
  );
  report(false, "didn't take effect", msg);
  return 1;
}

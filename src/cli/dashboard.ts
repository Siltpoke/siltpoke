// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The dashboard/daemon lifecycle, split out of report.ts on 2026-09-23.
//
// Not a line-count shuffle: report.ts builds an HTML report from critique
// inboxes, and these functions start a server, poll it for liveness and open a
// browser at it. They shared a file and nothing else. The split was FORCED by
// the length ratchet — report.ts sat one line under its pin, so the comments
// explaining why the Windows open-command has the shape it does could not be
// added without it — and the ratchet is meant to force exactly this rather than
// be re-pinned upward.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isSiltpokedPing } from "../daemon/port";
import { editorOpener } from "../installer/editor-detect";
import type { ExecSyncFn } from "../installer/launchd";
import { siltpokeRoot } from "../installer/paths";
import { isLaunchdJobInstalled, runRestart, type RestartDeps } from "./daemon-restart";
import { stopReport } from "./report-stop";
import { setDaemonEnabled } from "../config/write-daemon-enabled";

/** Where the live dashboard lives once the daemon is up. */
export const DASHBOARD_URL = "http://127.0.0.1:9876/";

export interface OpenDashboardOptions {
  /** Skip launching the browser (used by `--no-open` and by tests). */
  noOpen?: boolean;
  /** `~/.siltpoke` by default — only read for the daemon pidfile. */
  homeBase?: string;
  /**
   * argv used to spawn the daemon when it is not already listening.
   *
   * Defaults to the sibling `daemon.ts` (source runs / `bun run report`). The
   * plugin multiplexer overrides it with the bundled `dist/siltpoke-daemon.js`:
   * a `/plugin install` cache has no `src/` and no `node_modules`, so the
   * default `.ts` path does not exist there and `bun` would exit 1.
   */
  daemonArgv?: readonly string[];
  out?: (s: string) => void;
  /**
   * Defaults to `process.platform`. Test seam — the browser-open argv differs
   * per platform and the Windows shape was wrong for as long as it had no test.
   */
  platform?: NodeJS.Platform;
  /**
   * Liveness probe. Defaults to a real `/api/ping` against `DASHBOARD_URL`.
   * Test seam — without it a test of the open argv has to stand up a daemon.
   */
  isDaemonUp?: (timeoutMs: number) => Promise<boolean>;
  /**
   * Launches the browser. Defaults to `Bun.spawn`, detached and silent.
   * Test seam — see `platform`.
   */
  spawnOpener?: (argv: readonly string[]) => void;
}

/**
 * Ensure the daemon is listening, then print + open the dashboard URL.
 *
 * The daemon owns the dashboard; this only makes sure it is up. Throws if the
 * daemon does not answer `/api/ping` within 3s of being spawned.
 */
/**
 * True if SILTPOKED — not merely some server — answers at `pingUrl`.
 *
 * Lifted out of `openDashboard`'s closure so it is reachable from a test: the
 * dashboard URL is a module constant with no injection seam, so the identity
 * check inside had no way to be exercised otherwise.
 *
 * WHY the identity check — a bare `r.ok` counted any 2xx, so a stranger holding
 * the dashboard port made `/siltpoke-dashboard` print that URL and open the
 * browser at somebody else's app. Audit defect `[5b]`, §26.3.
 */
export async function siltpokedAnswersAt(
  pingUrl: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const r = await fetch(pingUrl, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok && isSiltpokedPing(await r.json());
  } catch {
    return false;
  }
}

export async function openDashboard(opts: OpenDashboardOptions = {}): Promise<void> {
  const homeBase = opts.homeBase ?? siltpokeRoot(process.env);
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const daemonArgv = opts.daemonArgv ?? [
    "bun",
    fileURLToPath(new URL("./daemon.ts", import.meta.url)),
    "start",
  ];

  const daemonAlive =
    opts.isDaemonUp ??
    ((timeoutMs: number): Promise<boolean> =>
      siltpokedAnswersAt(`${DASHBOARD_URL}api/ping`, timeoutMs));

  const pidPath = join(homeBase, "siltpoked.pid");
  // An injected probe owns the whole answer, pidfile shortcut included —
  // otherwise "the daemon is up" would still depend on a file on this disk.
  const alive = opts.isDaemonUp
    ? await daemonAlive(250)
    : existsSync(pidPath) && (await daemonAlive(250));

  if (!alive) {
    // Opening the dashboard is the opt-in: persist daemon.enabled=true so a
    // subsequent Stop hook's respawn gate (on-stop.ts maybeRespawnDaemon)
    // keeps this daemon alive instead of treating it as opted-out.
    await setDaemonEnabled(homeBase, true);
    // Lazy-spawn detached daemon, then poll up to 3s for it to answer.
    const proc = Bun.spawn([...daemonArgv], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    let up = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (await daemonAlive(100)) {
        up = true;
        break;
      }
    }
    if (!up) throw new Error("siltpoked failed to start within 3s");
  }

  // "/" serves Wave 1 Home — the only surface now. The legacy tamagotchi
  // report (formerly "/dashboard") is retired.
  out(`Siltpoke: ${DASHBOARD_URL}\n`);
  if (!opts.noOpen) {
    // `editorOpener` rather than a second copy of the same three-way switch.
    // The copy that used to live here spawned a bare `start` on win32, and
    // `start` is a cmd.exe BUILTIN, not an executable — `Bun.spawn` runs no
    // shell, so it could never launch anything. `editorOpener` returns
    // `["cmd", "/c", "start", ""]`, and that empty string is load-bearing:
    // `start` reads its first quoted argument as the window TITLE, so without
    // it the URL is consumed as a title and no browser opens.
    const argv = [...editorOpener(opts.platform ?? process.platform), DASHBOARD_URL];
    const spawnOpener =
      opts.spawnOpener ??
      ((a: readonly string[]) => {
        Bun.spawn([...a], { stdio: ["ignore", "ignore", "ignore"] });
      });
    spawnOpener(argv);
  }
}

export interface RestartDashboardOptions extends OpenDashboardOptions {
  /**
   * Exec seam for the launchd-job-installed check below; defaults to the real
   * `spawnSync`. Injectable so the branch selection is unit-testable without
   * touching a real launchd domain.
   */
  exec?: ExecSyncFn;
  /** Defaults to `process.getuid()`. Injectable for the same reason as `exec`. */
  uid?: number;
  /**
   * Delegate used when a launchd job is installed for the daemon label.
   * Defaults to `daemon-restart`'s `runRestart` (the real `launchctl
   * kickstart` path SwiftBar already uses). Injectable so tests can assert
   * the branch was taken without shelling out to launchctl.
   */
  runLaunchdRestart?: (deps: RestartDeps) => Promise<number>;
}

/**
 * Restart the dashboard daemon.
 *
 * Root-cause fix (siltpoked restart unification): when launchd already owns
 * the daemon (installed via `install-autostart`), this used to SIGTERM the
 * pidfile-holder and spawn a fresh MANUAL detached process — a non-launchd
 * process that then squats :9876. After that, launchd's own `kickstart`
 * restart (the path `siltpoked restart` / the SwiftBar menu row uses) can no
 * longer bind and fails for ~19s with "another process is probably holding
 * the port". Interactive `restart-daemon` and the SwiftBar restart must be
 * the SAME mechanism, so: detect the launchd job first and, when present,
 * delegate to `runRestart()` instead of doing anything manual.
 *
 * Only when there is NO launchd job (a non-autostart / dev install) does this
 * fall back to the original manual path: SIGTERM whatever currently holds the
 * pidfile, wait for it to stop answering, then spawn a fresh daemon via
 * openDashboard (which reuses the bundled-daemon argv override). A missing
 * pidfile just means nothing to stop — it proceeds to start fresh. The
 * daemon's own prior-holder eviction (see startDaemon) makes the fresh start
 * race-safe.
 */
export async function restartDashboard(opts: RestartDashboardOptions = {}): Promise<void> {
  const exec: ExecSyncFn =
    opts.exec ?? ((cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }));
  const uid = opts.uid ?? process.getuid?.() ?? 0;

  if (isLaunchdJobInstalled(exec, uid)) {
    const runLaunchdRestart = opts.runLaunchdRestart ?? runRestart;
    const code = await runLaunchdRestart({});
    if (code !== 0) {
      throw new Error(
        "launchd restart did not succeed (see siltpoked output above for the cause)",
      );
    }
    return;
  }

  const homeBase = opts.homeBase ?? siltpokeRoot(process.env);
  stopReport([join(homeBase, "siltpoked.pid"), join(homeBase, "report.pid")]);
  // Wait for the old daemon to actually stop answering before starting a new
  // one — openDashboard's "already alive?" guard would otherwise skip the spawn.
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${DASHBOARD_URL}api/ping`, {
        signal: AbortSignal.timeout(100),
      });
      if (!r.ok) break;
    } catch {
      break; // ECONNREFUSED → the old daemon is down
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await openDashboard({ ...opts, noOpen: true });
}

if (import.meta.main) {
  await openDashboard({ noOpen: process.argv.includes("--no-open") });
  process.exit(0);
}

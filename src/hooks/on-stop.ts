// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrainCallResult, CallBrainOptions } from "../brain/brain";
import { loadDaemonConfig } from "../config/daemon-config";
import {
  claimMarker,
  completeMarker,
  deriveStopMarkerKey,
  readMarker,
} from "../daemon/marker";
import { resolveDaemonEntry } from "../installer/daemon-path";
import { siltpokeRoot } from "../installer/paths";
import type { HookEvent } from "../router/router";
import { appendJsonLine, handleStopHook } from "./handle-stop";

export type { HookEvent } from "../router/router";

async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type DaemonSpawnFn = (
  cmd: string[],
  opts: { stdio: ["ignore", "ignore", "ignore"] },
) => { unref(): void };

export interface RunHookOptions {
  rawJson: string;
  env?: NodeJS.ProcessEnv;
  brainFn?: (opts: CallBrainOptions) => Promise<BrainCallResult>;
  spawnFn?: DaemonSpawnFn;
}

async function probeDaemon(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, {
      signal: AbortSignal.timeout(250),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function respawnDisabled(env: NodeJS.ProcessEnv): boolean {
  return (
    env.SILTPOKE_DISABLE_RESPAWN === "1" ||
    // Legacy alias, kept for back-compat with pre-AC9 installs.
    env.SILTPOKE_SUPPRESSION_DISABLE_RESPAWN === "1"
  );
}

/**
 * Resolve the daemon entry from the directory THIS module is running from.
 *
 * Now a re-export of the ONE implementation in installer/daemon-path.ts rather
 * than a local copy. The name is kept because the tests added with #562 import
 * it from here, and because the reason it exists belongs next to its caller:
 * build-dist inlines this file into dist/siltpoke-stop.js, where the original
 * `new URL("../cli/daemon.ts", import.meta.url)` resolved one level too high —
 * missing `src/`, existing nowhere — so a built install could never revive its
 * own daemon.
 *
 * Six sites needed this rule and every one was hand-written; two of them shipped
 * broken. Collapsing them onto a single function is what stops the seventh.
 */
export { resolveDaemonEntry as resolveDaemonTarget };

function respawnDaemonDetached(spawnFn?: DaemonSpawnFn): void {
  try {
    const spawn: DaemonSpawnFn = spawnFn ?? ((cmd, opts) => Bun.spawn(cmd, opts));
    const daemonScript = resolveDaemonEntry(import.meta.dir);
    const proc = spawn(["bun", daemonScript, "start"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
  } catch {
    // best-effort — daemon may not exist yet (early phase) or spawn may fail
  }
}

/**
 * Respawn the detached daemon if it is down. Gated on `daemon.enabled`
 * (default false): with the daemon opt-in, a disabled config short-circuits
 * before any probe/spawn — core review never needs it, so "off" stays off.
 * When enabled: probe-gated (skip when alive), also disabled by
 * SILTPOKE_DISABLE_RESPAWN=1 (or the legacy suppression alias). Fail-soft:
 * never throws, never blocks the hook's main job (runs after it).
 * `export`ed so the config gate can be unit-tested directly.
 */
export async function maybeRespawnDaemon(env: NodeJS.ProcessEnv, spawnFn?: DaemonSpawnFn): Promise<void> {
  try {
    if (respawnDisabled(env)) return;
    // Opt-in gate: with daemon.enabled off (the default) the daemon is never
    // revived — core review runs in-process and needs no daemon. Only the
    // opt-in web surfaces do, and opening the dashboard flips this on.
    //
    // `daemon.enabled` lives in `<siltpokeRoot>/config.json` (~/.siltpoke/
    // config.json), the same file every other config reader in this codebase
    // (install.ts, daemon-config.ts callers, doctor.ts, etc.) resolves via
    // siltpokeRoot() — NOT raw `env.HOME` (that would read `~/config.json`,
    // which is never written, so this gate would silently never fire even
    // after the user opts in via `/siltpoke-dashboard`).
    const home = siltpokeRoot(env);
    const daemonCfg = await loadDaemonConfig(home);
    if (!daemonCfg.enabled) return;
    const port = Number(env.SILTPOKE_DAEMON_PORT ?? "9876");
    if (await probeDaemon(port)) return;
    respawnDaemonDetached(spawnFn);
  } catch {
    // best-effort — respawn must never break the hook
  }
}

/**
 * Try to win the atomic claim for this Stop event.
 *
 * - "skip"          another process already owns or finished this event — the
 *                   caller must NOT review (that is the dedupe working).
 * - "review-owned"  we won the claim — review, then completeMarker(key).
 * - "review-unowned" the marker subsystem itself errored (e.g. an unwritable
 *                   marker dir) — review anyway (fail SOFT), with no marker to
 *                   complete. A best-effort dedupe that occasionally lets a
 *                   duplicate through is acceptable; one that drops a real
 *                   review is not.
 *
 * NEVER throws — the dedupe layer must never be the thing that starves a review
 * or crashes the hook.
 */
async function claimStopMarker(
  markerDir: string,
  key: string,
  port: number,
): Promise<"skip" | "review-owned" | "review-unowned"> {
  try {
    // Ensure marker dir exists (claimMarker assumes the dir is present).
    try {
      mkdirSync(markerDir, { recursive: true });
    } catch {
      // best-effort — a real failure surfaces on the claimMarker below
    }

    const existing = readMarker(markerDir, key);
    if (existing?.state === "done") {
      // Daemon (or a prior hook invocation) already finished this stop.
      return "skip";
    }
    if (existing?.state === "claimed" && !existing.staleClaim) {
      const daemonAlive = await probeDaemon(port);
      if (daemonAlive) {
        await new Promise((r) => setTimeout(r, 500));
        const after = readMarker(markerDir, key);
        if (
          after?.state === "done" ||
          (after?.state === "claimed" && !after.staleClaim)
        ) {
          return "skip";
        }
      }
    }

    // Atomic claim. If we lose the race, another process owns it → skip.
    return claimMarker(markerDir, key) ? "review-owned" : "skip";
  } catch {
    // Marker subsystem failure (unwritable dir, fs error, …). Pre-Task-7 this
    // was an opt-in path; now every user hits it by default, so a broken marker
    // dir must NOT silently swallow the review — fall through to reviewing.
    return "review-unowned";
  }
}

/**
 * Resolve the Stop-hook marker directory. `SILTPOKE_MARKER_DIR` is an
 * explicit override and always wins; otherwise the dir is rooted under the
 * SAME canonical `siltpokeRoot(env)` every other siltpoke path uses, so
 * `SILTPOKE_HOME` correctly relocates markers too (previously this fell back
 * to a HOME-only path, which leaked writes into the real ~/.siltpoke during
 * an isolated smoke — see an internal design note for the incident).
 */
export function markerDir(env: NodeJS.ProcessEnv): string {
  return env.SILTPOKE_MARKER_DIR ?? join(siltpokeRoot(env), "markers");
}

export async function runHook(opts: RunHookOptions): Promise<void> {
  const env = opts.env ?? process.env;

  let event: HookEvent;
  try {
    event = JSON.parse(opts.rawJson) as HookEvent;
  } catch (err) {
    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      error: `stdin not valid JSON: ${err}`,
    });
    return;
  }

  // Marker-based idempotency is now the DEFAULT. An upgrading user can have BOTH
  // a legacy settings.json Stop hook and the plugin's hooks.json one live at the
  // same time — without this, that is two Brain calls (double spend) per turn.
  // Escape hatch kept for debugging: SILTPOKE_SUPPRESSION_ENABLED=0.
  const suppressionEnabled = env.SILTPOKE_SUPPRESSION_ENABLED !== "0";
  if (suppressionEnabled) {
    const stopMarkerDir = markerDir(env);
    const port = Number(env.SILTPOKE_DAEMON_PORT ?? "9876");

    // Key on session_id + a hash of the transcript content — the ONE thing
    // both firing hook processes compute identically for the same logical Stop
    // event. NEVER Date.now(): the old bug sampled a fresh instant in each
    // process, so the two keys never collided, the atomic claim never fired,
    // and every turn was reviewed (and paid for) twice.
    const key = deriveStopMarkerKey(event);

    // No usable key (transcript missing/unreadable) → fail SOFT toward
    // reviewing rather than colliding or suppressing.
    if (key !== null) {
      const outcome = await claimStopMarker(stopMarkerDir, key, port);
      if (outcome === "skip") return;

      try {
        await handleStopHook(event, { env, brainFn: opts.brainFn });
      } finally {
        if (outcome === "review-owned") {
          try {
            completeMarker(stopMarkerDir, key);
          } catch {
            // marker completion failure must not starve the respawn below
          }
        }
        await maybeRespawnDaemon(env, opts.spawnFn);
      }
      return;
    }

    // Fail-soft path: no transcript to dedupe on. Review anyway (a missed
    // dedupe costs one extra review; a dropped review is worse).
    try {
      await handleStopHook(event, { env, brainFn: opts.brainFn });
    } finally {
      await maybeRespawnDaemon(env, opts.spawnFn);
    }
    return;
  }

  // Legacy path — no suppression. All pre-Task-10 tests hit this branch.
  try {
    await handleStopHook(event, { env, brainFn: opts.brainFn });
  } finally {
    await maybeRespawnDaemon(env, opts.spawnFn);
  }
}

if (import.meta.main) {
  try {
    const raw = await readStdinAll();
    await runHook({ rawJson: raw });
    process.exit(0);
  } catch (err) {
    await appendJsonLine(process.env, {
      timestamp: new Date().toISOString(),
      error: `FATAL hook crash: ${err}`,
    });
    process.exit(0);
  }
}

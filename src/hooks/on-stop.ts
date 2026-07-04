// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStopHook, appendJsonLine } from "./handle-stop";
import type { HookEvent } from "../router/router";
import type { CallBrainOptions, BrainCallResult } from "../brain/brain";
import { markerKey, readMarker, claimMarker, completeMarker } from "../daemon/marker";

export type { HookEvent } from "../router/router";

async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface RunHookOptions {
  rawJson: string;
  env?: NodeJS.ProcessEnv;
  brainFn?: (opts: CallBrainOptions) => Promise<BrainCallResult>;
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

function respawnDaemonDetached(): void {
  try {
    const daemonScript = new URL("../cli/daemon.ts", import.meta.url).pathname;
    Bun.spawn(["bun", daemonScript, "start"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // best-effort — daemon may not exist yet (early phase) or spawn may fail
  }
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

  // Suppression flow — opt-in via env. Default = legacy behavior preserved.
  const suppressionEnabled = env.SILTPOKE_SUPPRESSION_ENABLED === "1";
  if (suppressionEnabled) {
    const markerDir =
      env.SILTPOKE_MARKER_DIR ?? join(env.HOME ?? "", ".siltpoke", "markers");
    const port = Number(env.SILTPOKE_DAEMON_PORT ?? "9876");
    const ts = (event as { stop_event_timestamp_ms?: number }).stop_event_timestamp_ms ?? Date.now();
    const sessionId = (event as { session_id?: string }).session_id ?? "";
    const key = markerKey({ session_id: sessionId, stop_event_timestamp_ms: ts });

    // Ensure marker dir exists (claimMarker assumes the dir is present).
    try {
      mkdirSync(markerDir, { recursive: true });
    } catch {
      // best-effort
    }

    const existing = readMarker(markerDir, key);
    if (existing?.state === "done") {
      // Daemon (or a prior hook invocation) already finished this stop.
      return;
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
          return;
        }
      }
    }

    // Try to atomically claim. If we lose the race, exit 0.
    const claimed = claimMarker(markerDir, key);
    if (!claimed) {
      return;
    }

    try {
      await handleStopHook(event, { env, brainFn: opts.brainFn });
    } finally {
      completeMarker(markerDir, key);
      if (env.SILTPOKE_SUPPRESSION_DISABLE_RESPAWN !== "1") {
        respawnDaemonDetached();
      }
    }
    return;
  }

  // Legacy path — no suppression. All pre-Task-10 tests hit this branch.
  await handleStopHook(event, { env, brainFn: opts.brainFn });
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

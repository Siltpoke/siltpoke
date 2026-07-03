import { describe, test, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startDaemon,
  stopDaemon,
  type DaemonHandle,
} from "../../src/daemon/server";

interface Marker {
  state: "claimed" | "done";
  claimedAt: number;
  doneAt: number | null;
}

function readCounter(path: string): number {
  return Number(readFileSync(path, "utf8"));
}

describe("two-entry dedup (e2e)", () => {
  let handle: DaemonHandle | null = null;

  afterEach(async () => {
    if (handle) {
      try {
        await stopDaemon(handle);
      } catch {
        /* best-effort */
      }
    }
    handle = null;
  });

  test("HTTP entry + command entry → daemon's handleStopHook runs once; command entry suppresses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dedup-"));
    const markerDir = join(dir, "markers");
    const counterPath = join(dir, "calls.count");
    writeFileSync(counterPath, "0");

    handle = await startDaemon({
      port: 0,
      hostname: "127.0.0.1",
      lockPath: join(dir, "siltpoked.lock"),
      pidPath: join(dir, "siltpoked.pid"),
      markerDir,
      secret: "test-secret",
      homeBase: dir,
      handleStopHook: async () => {
        const n = readCounter(counterPath) + 1;
        writeFileSync(counterPath, String(n));
      },
    });

    const port = handle.server.port;
    const payload = {
      hook_event_name: "Stop",
      session_id: "s1",
      stop_event_timestamp_ms: 1234,
      transcript_path: "/dev/null",
      cwd: "/tmp",
      stop_hook_active: false,
    };

    // 1) HTTP entry fires (Claude Code's first hook entry).
    const httpRes = await fetch(`http://127.0.0.1:${port}/hooks/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Siltpoke-Secret": "test-secret",
      },
      body: JSON.stringify(payload),
    });
    expect(httpRes.status).toBe(202);

    // Daemon performs handleStopHook detached — give it a moment.
    await new Promise((r) => setTimeout(r, 150));
    expect(readCounter(counterPath)).toBe(1);

    // Marker should now be state=done (HTTP route completes it in finally).
    const markerFilesAfterHttp = readdirSync(markerDir);
    expect(markerFilesAfterHttp.length).toBe(1);
    const markerAfterHttp = JSON.parse(
      readFileSync(join(markerDir, markerFilesAfterHttp[0]!), "utf8"),
    ) as Marker;
    expect(markerAfterHttp.state).toBe("done");

    // 2) Command entry fires (Claude Code's second hook entry → on-stop.ts).
    const child = Bun.spawn(["bun", "src/hooks/on-stop.ts"], {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: dir, // isolate from real ~/.siltpoke
        SILTPOKE_SUPPRESSION_ENABLED: "1",
        SILTPOKE_MARKER_DIR: markerDir,
        SILTPOKE_DAEMON_PORT: String(port),
        SILTPOKE_SUPPRESSION_DISABLE_RESPAWN: "1",
      },
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    await child.exited;
    expect(child.exitCode).toBe(0);

    // 3) Counter is STILL 1 — command entry saw marker.state === "done" and short-circuited.
    await new Promise((r) => setTimeout(r, 50));
    expect(readCounter(counterPath)).toBe(1);

    // Exactly one marker file exists (no second one was created with a different key).
    const finalMarkers = readdirSync(markerDir);
    expect(finalMarkers.length).toBe(1);
    const finalMarker = JSON.parse(
      readFileSync(join(markerDir, finalMarkers[0]!), "utf8"),
    ) as Marker;
    expect(finalMarker.state).toBe("done");
  });

  test("when daemon is DOWN, command entry handles the Stop itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dedup-down-"));
    const markerDir = join(dir, "markers");
    mkdirSync(markerDir, { recursive: true });

    const payload = {
      hook_event_name: "Stop",
      session_id: "s2",
      stop_event_timestamp_ms: 5678,
      transcript_path: "/dev/null",
      cwd: "/tmp",
      stop_hook_active: false,
    };

    // No daemon — port 65535 is unreachable. Command entry must do the work itself.
    const child = Bun.spawn(["bun", "src/hooks/on-stop.ts"], {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: dir,
        SILTPOKE_SUPPRESSION_ENABLED: "1",
        SILTPOKE_MARKER_DIR: markerDir,
        SILTPOKE_DAEMON_PORT: "65535",
        SILTPOKE_SUPPRESSION_DISABLE_RESPAWN: "1",
      },
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    await child.exited;
    expect(child.exitCode).toBe(0);

    // Command entry should have claimed + completed the marker itself
    // (finally block in runHook always calls completeMarker).
    const markerFiles = readdirSync(markerDir);
    expect(markerFiles.length).toBe(1);
    const marker = JSON.parse(
      readFileSync(join(markerDir, markerFiles[0]!), "utf8"),
    ) as Marker;
    expect(marker.state).toBe("done");
  });
});

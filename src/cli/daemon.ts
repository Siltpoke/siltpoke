// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { startDaemon, DaemonAlreadyRunningError } from "../daemon/server";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";
import { generateSecret } from "../daemon/auth";
import { runStopWithGuard } from "./daemon-stop-guard";
import { installAutostartForPlatform } from "../installer/autostart";
import { runRestart } from "./daemon-restart";
import { siltpokeRoot } from "../installer/paths";

const BASE = siltpokeRoot();

function loadOrCreateSecret(): string {
  const path = join(BASE, "secret");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const s = generateSecret();
  atomicWrite(path, s, { mode: 0o600 });
  return s;
}

async function cmdStart(detach: boolean): Promise<void> {
  if (detach) {
    const proc = Bun.spawn(["bun", import.meta.path, "start"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    process.stdout.write(`siltpoked spawned (pid=${proc.pid ?? "?"})\n`);
    return;
  }
  const port = process.env.PORT ? Number(process.env.PORT) : 9876;
  let handle: Awaited<ReturnType<typeof startDaemon>>;
  try {
    handle = await startDaemon({
      port,
      hostname: "127.0.0.1",
      lockPath: join(BASE, "siltpoked.lock"),
      pidPath: join(BASE, "siltpoked.pid"),
      markerDir: join(BASE, "markers"),
      secret: loadOrCreateSecret(),
      homeBase: BASE,
    });
  } catch (err) {
    // A healthy siltpoked already owns the port. Step down with success so
    // launchd KeepAlive treats this as "already handled" and does NOT
    // crash-flap the newcomer against the incumbent (the dashboard stays up).
    if (err instanceof DaemonAlreadyRunningError) {
      process.stdout.write(
        `siltpoked already running on http://127.0.0.1:${err.port}\n`,
      );
      process.exit(0);
    }
    throw err;
  }
  process.stdout.write(
    `siltpoked listening on http://127.0.0.1:${handle.server.port}\n`,
  );
  // Hold the loop. Bun.serve keeps it alive; SIGTERM handler (installed by startDaemon) shuts it down.
}

async function cmdStop(force: boolean): Promise<void> {
  const pidPath = join(BASE, "siltpoked.pid");
  if (!existsSync(pidPath)) {
    process.stderr.write("siltpoked: no pidfile, not running\n");
    process.exit(1);
  }
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!pid) {
    process.stderr.write("siltpoked: pidfile empty\n");
    process.exit(1);
  }
  const port = process.env.PORT ? Number(process.env.PORT) : 9876;
  const baseUrl = `http://127.0.0.1:${port}`;
  const code = await runStopWithGuard({
    pid,
    force,
    baseUrl,
    kill: (p, sig) => process.kill(p, sig as NodeJS.Signals),
    stderr: (msg) => process.stderr.write(msg),
    stdout: (msg) => process.stdout.write(msg),
  });
  if (code !== 0) process.exit(code);
}

function cmdStatus(): void {
  const pidPath = join(BASE, "siltpoked.pid");
  if (!existsSync(pidPath)) {
    process.stdout.write("siltpoked: not running\n");
    return;
  }
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  process.stdout.write(`siltpoked: ${alive ? "running" : "stale"} pid=${pid}\n`);
}

async function cmdInstallAutostart(): Promise<void> {
  const result = await installAutostartForPlatform();
  if (result.status === "unavailable") {
    process.stderr.write(`installer/${result.module}.ts not available\n`);
    process.exit(2);
  }
  if (result.status === "skipped") {
    process.stderr.write(
      `install-autostart unsupported on platform=${result.platform}\n`,
    );
    process.exit(2);
  }
}

const sub = process.argv[2] ?? "status";
const detach = process.argv.includes("--detach");
const force = process.argv.includes("--force");

switch (sub) {
  case "start":
    await cmdStart(detach);
    break;
  case "stop":
    await cmdStop(force);
    break;
  case "status":
    cmdStatus();
    break;
  case "restart":
    process.exit(await runRestart());
    break;
  case "install-autostart":
    await cmdInstallAutostart();
    break;
  default:
    process.stderr.write(`unknown subcommand: ${sub}\nusage: siltpoked [start|stop|status|restart|install-autostart] [--detach] [--force]\n`);
    process.exit(2);
}

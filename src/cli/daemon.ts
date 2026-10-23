// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateSecret } from "../daemon/auth";
import { moveToNeutralCwd } from "../daemon/neutral-cwd";
import { resolveDaemonPort } from "../daemon/port";
import { DaemonAlreadyRunningError, startDaemon } from "../daemon/server";
import { installAutostartForPlatform } from "../installer/autostart";
import { siltpokeRoot } from "../installer/paths";
import { atomicWrite } from "../utils/atomic-write";
import { runRestart } from "./daemon-restart";
import { runStopWithGuard } from "./daemon-stop-guard";

// Absolute, resolved at import — before `cmdStart` moves the process to the
// filesystem root — so a relative SILTPOKE_HOME keeps its meaning.
const BASE = resolve(siltpokeRoot());

function loadOrCreateSecret(): string {
  const path = join(BASE, "secret");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const s = generateSecret();
  atomicWrite(path, s, { mode: 0o600 });
  return s;
}

async function cmdStart(detach: boolean): Promise<void> {
  if (detach) {
    // The parameter has been called `detach` since this function was written,
    // and the spawn never passed `detached`. `unref()` alone frees the parent's
    // event loop; it does not put the child in its own process group, so on
    // Windows the "detached" daemon died with whatever started it. Unix hid it:
    // the child is re-parented to init there and survives regardless.
    //
    // `process.execPath`, not a bare "bun": this code runs under bun, so it
    // knows the interpreter without a PATH lookup — and on native Windows a
    // bare "bun" resolves to nothing (`where.exe bun` is empty even on a
    // machine with bun installed).
    const proc = Bun.spawn([process.execPath, import.meta.path, "start"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    proc.unref();
    process.stdout.write(`siltpoked spawned (pid=${proc.pid ?? "?"})\n`);
    return;
  }
  // Before anything can spawn claude: the daemon must not live in the folder
  // that happened to start it (see neutral-cwd.ts). The routes that fall back
  // to "the project the daemon was started from" still get that folder.
  const startCwd = process.cwd();
  moveToNeutralCwd();
  const port = resolveDaemonPort(process.env);
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
      startCwd,
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
  const port = resolveDaemonPort(process.env);
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

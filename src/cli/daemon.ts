// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { startDaemon, } from "../daemon/server";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { atomicWrite } from "../utils/atomic-write";
import { generateSecret } from "../daemon/auth";
import { runStopWithGuard } from "./daemon-stop-guard";

const BASE = process.env.SILTPOKE_HOME ?? join(homedir(), ".siltpoke");

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
  const handle = await startDaemon({
    port,
    hostname: "127.0.0.1",
    lockPath: join(BASE, "siltpoked.lock"),
    pidPath: join(BASE, "siltpoked.pid"),
    markerDir: join(BASE, "markers"),
    secret: loadOrCreateSecret(),
    homeBase: BASE,
  });
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

interface AutostartInstaller {
  installAutostart(): Promise<void>;
}

async function cmdInstallAutostart(): Promise<void> {
  const platform = process.platform;
  if (platform === "darwin") {
    const mod = (await import("../installer/launchd").catch(() => null)) as
      | AutostartInstaller
      | null;
    if (!mod || typeof mod.installAutostart !== "function") {
      process.stderr.write("installer/launchd.ts not available\n");
      process.exit(2);
    }
    await mod.installAutostart();
    return;
  }
  if (platform === "linux") {
    const mod = (await import("../installer/systemd").catch(() => null)) as
      | AutostartInstaller
      | null;
    if (!mod || typeof mod.installAutostart !== "function") {
      process.stderr.write("installer/systemd.ts not available\n");
      process.exit(2);
    }
    await mod.installAutostart();
    return;
  }
  process.stderr.write(`install-autostart unsupported on platform=${platform}\n`);
  process.exit(2);
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
  case "install-autostart":
    await cmdInstallAutostart();
    break;
  default:
    process.stderr.write(`unknown subcommand: ${sub}\nusage: siltpoked [start|stop|status|install-autostart] [--detach] [--force]\n`);
    process.exit(2);
}

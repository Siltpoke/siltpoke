// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

interface UnitInput {
  bunPath: string;
  daemonScript: string;
}

function escapeExecPath(s: string): string {
  // systemd `ExecStart` splits on space; replace with literal escaped form.
  return s.replace(/ /g, "\\x20");
}

export function renderUnit({ bunPath, daemonScript }: UnitInput): string {
  return `[Unit]
Description=Siltpoke daemon
After=default.target

[Service]
Type=simple
ExecStart=${escapeExecPath(bunPath)} ${escapeExecPath(daemonScript)} start
Restart=always
RestartSec=10
StandardOutput=append:${homedir()}/.siltpoke/logs/daemon.log
StandardError=append:${homedir()}/.siltpoke/logs/daemon.err

[Install]
WantedBy=default.target
`;
}

export async function installAutostart(): Promise<void> {
  if (process.platform !== "linux") {
    process.stderr.write(
      "installAutostart (systemd-user) requires Linux. For macOS use installer/launchd.ts.\n",
    );
    process.exit(2);
  }
  const which = spawnSync("which", ["bun"], { encoding: "utf8" });
  const bunPath = (which.stdout || "").trim();
  if (!bunPath) {
    throw new Error("bun not found in PATH");
  }
  const daemonScript = new URL("../cli/daemon.ts", import.meta.url).pathname;
  const unit = renderUnit({ bunPath, daemonScript });

  const unitDir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  const unitPath = join(unitDir, "siltpoked.service");
  writeFileSync(unitPath, unit);

  mkdirSync(join(homedir(), ".siltpoke", "logs"), { recursive: true });

  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  const r = spawnSync(
    "systemctl",
    ["--user", "enable", "--now", "siltpoked.service"],
    { stdio: "inherit" },
  );
  if (r.status !== 0) {
    throw new Error("systemctl --user enable --now failed");
  }
  process.stdout.write(`Installed systemd-user unit at ${unitPath}\n`);
}

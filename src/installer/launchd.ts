// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

interface PlistInput {
  bunPath: string;
  daemonScript: string;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderPlist({ bunPath, daemonScript }: PlistInput): string {
  const home = xmlEscape(homedir());
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.siltpoke.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(bunPath)}</string>
    <string>${xmlEscape(daemonScript)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${home}/.siltpoke/logs/daemon.log</string>
  <key>StandardErrorPath</key><string>${home}/.siltpoke/logs/daemon.err</string>
</dict>
</plist>`;
}

export async function installAutostart(): Promise<void> {
  if (process.platform !== "darwin") {
    process.stderr.write(
      "installAutostart (launchd) requires macOS. For Linux use installer/systemd.ts.\n",
    );
    process.exit(2);
  }
  const which = spawnSync("which", ["bun"], { encoding: "utf8" });
  const bunPath = (which.stdout || "").trim();
  if (!bunPath) {
    throw new Error("bun not found in PATH");
  }
  const daemonScript = new URL("../cli/daemon.ts", import.meta.url).pathname;
  const xml = renderPlist({ bunPath, daemonScript });

  const dir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  const plistPath = join(dir, "io.siltpoke.daemon.plist");
  writeFileSync(plistPath, xml);

  // Ensure log dir exists for StandardOutPath/StandardErrorPath.
  mkdirSync(join(homedir(), ".siltpoke", "logs"), { recursive: true });

  // Re-load: bootout (ignore failure if not yet loaded) + bootstrap.
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.()}`, plistPath], {
    stdio: "ignore",
  });
  const r = spawnSync(
    "launchctl",
    ["bootstrap", `gui/${process.getuid?.()}`, plistPath],
    { stdio: "inherit" },
  );
  if (r.status !== 0) {
    throw new Error("launchctl bootstrap failed");
  }
  process.stdout.write(`Installed LaunchAgent at ${plistPath}\n`);
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync as realExistsSync } from "node:fs";
import type { Exec } from "./prereq";

const ANTIGRAVITY_APP = "/Applications/Antigravity.app";

/** Runtime presence of supported + detected-only agents. */
export interface AgentPresence {
  claude: boolean;
  codex: boolean;
  codebuddy: boolean;
  qodercli: boolean;
  /** Antigravity CLI (command -v). */
  antigravity: boolean;
  /** Antigravity IDE (.app), informational. */
  antigravityApp: boolean;
}

/** command -v per CLI agent (win32 → where); Antigravity via .app existsSync (AC9/AC12). */
export function detectAgents(opts: {
  exec: Exec;
  existsSync?: (p: string) => boolean;
  platform?: NodeJS.Platform;
}): AgentPresence {
  const platform = opts.platform ?? process.platform;
  const existsSync = opts.existsSync ?? realExistsSync;
  const has = (bin: string): boolean => {
    const r =
      platform === "win32"
        ? opts.exec("where", [bin])
        : opts.exec("command", ["-v", bin]);
    return r.status === 0;
  };
  return {
    claude: has("claude"),
    codex: has("codex"),
    codebuddy: has("codebuddy"),
    qodercli: has("qodercli"),
    // Antigravity's CLI ships as `agy` (~/.local/bin/agy), NOT `antigravity`.
    antigravity: has("agy"),
    antigravityApp: existsSync(ANTIGRAVITY_APP),
  };
}

/** Plain-language report. codebuddy/qodercli hooks are wired when detected. */
export function reportAgents(p: AgentPresence): string {
  const found: string[] = [];
  const missing: string[] = [];
  (p.claude ? found : missing).push("Claude Code");
  (p.codex ? found : missing).push("Codex");
  const lines = [
    `Found: ${found.length ? found.join(", ") : "none"}.`,
    `Not found: ${missing.length ? missing.join(", ") : "none"}.`,
    `CodeBuddy ${p.codebuddy ? "detected" : "not detected"}, Qoder ${p.qodercli ? "detected" : "not detected"} — wired when detected (Stop + SessionStart hooks).`,
    `Antigravity CLI ${p.antigravity ? "detected" : "not detected"}, IDE ${p.antigravityApp ? "detected" : "not detected"} (informational).`,
  ];
  return lines.join("\n");
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { Exec } from "./prereq";
import { detectPrereqs } from "./prereq";
import type { WizardIO } from "./wizard";

const CLAUDE_INSTALL =
  "curl -fsSL --proto '=https' --tlsv1.2 https://claude.ai/install.sh | bash";
const CODEX_INSTALL_ARGS = ["install", "-g", "@openai/codex"]; // via npm

export function installClaude(exec: Exec, io: WizardIO): boolean {
  const r = exec("bash", ["-c", CLAUDE_INSTALL]);
  if (r.status !== 0) {
    io.write(
      "! Claude Code install did not succeed — you can install it later from https://claude.ai and re-run. Continuing.\n",
    );
    return false;
  }
  return true;
}

export function installCodex(exec: Exec, io: WizardIO, platform?: NodeJS.Platform): boolean {
  const npmPresent = detectPrereqs(exec, ["node"], platform)[0].present
    ? exec(platform === "win32" ? "where" : "command", platform === "win32" ? ["npm"] : ["-v", "npm"]).status === 0
    : false;
  if (!npmPresent) {
    io.write(
      "Codex needs Node.js/npm, which aren't installed. Install Node from https://nodejs.org (or `brew install node`), then run `npm install -g @openai/codex`. Skipping Codex for now.\n",
    );
    return false;
  }
  const r = exec("npm", CODEX_INSTALL_ARGS);
  if (r.status !== 0) {
    io.write(
      "! Codex install did not succeed — skipping Codex wiring. Install later with `npm install -g @openai/codex`.\n",
    );
    return false;
  }
  return true;
}

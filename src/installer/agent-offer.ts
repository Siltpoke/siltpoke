// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { Exec } from "./prereq";
import { detectPrereqs } from "./prereq";
import { markDone, recordBefore } from "./receipt";
import { outsideToolEntry } from "./receipt-sites";
import type { WizardIO } from "./wizard";

const CLAUDE_INSTALL =
  "curl -fsSL --proto '=https' --tlsv1.2 https://claude.ai/install.sh | bash";
const CODEX_INSTALL_ARGS = ["install", "-g", "@openai/codex"]; // via npm

/** Only ever installed when absent, so ours; general tool — never offered for removal (spec §5). */
const claudeEntry = outsideToolEntry("tool:claude-code", "claude-code", true, {
  type: "none",
  reason: "general tool — never offered for removal (spec §5)",
});
const codexEntry = outsideToolEntry("tool:codex", "codex", true, {
  type: "none",
  reason: "general tool — never offered for removal (spec §5)",
});

export function installClaude(exec: Exec, io: WizardIO, env: NodeJS.ProcessEnv = process.env): boolean {
  recordBefore(claudeEntry, env);
  const r = exec("bash", ["-c", CLAUDE_INSTALL]);
  if (r.status !== 0) {
    io.write(
      "! Claude Code install did not succeed — you can install it later from https://claude.ai and re-run. Continuing.\n",
    );
    return false;
  }
  markDone(claudeEntry.id, env);
  return true;
}

export function installCodex(
  exec: Exec,
  io: WizardIO,
  platform?: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const npmPresent = detectPrereqs(exec, ["node"], platform)[0].present
    ? exec(platform === "win32" ? "where" : "command", platform === "win32" ? ["npm"] : ["-v", "npm"]).status === 0
    : false;
  if (!npmPresent) {
    io.write(
      "Codex needs Node.js/npm, which aren't installed. Install Node from https://nodejs.org (or `brew install node`), then run `npm install -g @openai/codex`. Skipping Codex for now.\n",
    );
    return false;
  }
  recordBefore(codexEntry, env);
  const r = exec("npm", CODEX_INSTALL_ARGS);
  if (r.status !== 0) {
    io.write(
      "! Codex install did not succeed — skipping Codex wiring. Install later with `npm install -g @openai/codex`.\n",
    );
    return false;
  }
  markDone(codexEntry.id, env);
  return true;
}

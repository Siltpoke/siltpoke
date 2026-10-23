// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { askYesNo, type WizardIO } from "./wizard";

/**
 * `[63]` — ask before installing anything outside siltpoke (spec
 * an internal design note §2.4, §8 D-B).
 *
 * Bun, git, Claude Code, codex, the project-lifecycle plugin and the local
 * Ollama model each get ONE question before anything is recorded or run. A
 * run with no terminal to ask on does not guess: it skips the install and
 * prints the command to run by hand.
 */
export interface ConsentOpts {
  /**
   * `--yes`: the user typed it on purpose, and it counts as "yes" for bun, git,
   * Claude Code, codex and PLC (the caller hands in an io that answers "y").
   * It never reaches the Ollama model — that has its own flag.
   */
  yes?: boolean;
  /** False when there is no terminal to ask on. Omitted ⇒ interactive. */
  interactive?: boolean;
}

/** The commands a user can run by hand when we skipped (or they declined) an install. */
export const HOW_TO = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash",
  codex: "npm install -g @openai/codex",
  plc: "claude plugin marketplace add Siltpoke/project-life-cycle && claude plugin install project-lifecycle@project-life-cycle",
  model: "ollama pull qwen2.5-coder:7b-instruct-q4_K_M   (or re-run setup with --with-local-model)",
} as const;

/**
 * One yes/no before an install. `true` ⇒ go ahead. A "no" and a no-terminal
 * skip both say how to do it later; neither leaves anything behind.
 */
export async function askInstall(
  io: WizardIO,
  question: string,
  howTo: string,
  opts: ConsentOpts & { default?: "yes" | "no" } = {},
): Promise<boolean> {
  if (opts.interactive === false && !opts.yes) {
    io.write(`! No terminal to ask on, so not installing. To do it yourself: ${howTo}\n`);
    return false;
  }
  const ok = await askYesNo(io, question, { default: opts.default ?? "yes" });
  if (!ok) io.write(`Skipped. To do it later: ${howTo}\n`);
  return ok;
}

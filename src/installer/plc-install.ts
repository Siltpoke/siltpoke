// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { WizardIO } from "./wizard";

/** Exec seam that also captures stderr (needed for idempotency detection). */
export type PlcExec = (
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => { status: number; stdout: string; stderr: string };

export interface PlcInstallResult {
  added: boolean;
  installed: boolean;
  reason: "no-claude" | "ok" | "already";
}

const PLC_MARKETPLACE = "Siltpoke/project-life-cycle";
const PLC_PLUGIN = "project-lifecycle@project-life-cycle";

// AC17: suppress siltpoke's Stop/SessionStart hooks if the claude-plugin call
// triggers one mid-install (reuses the existing shouldFire suppression path).
const SUPPRESS_ENV = {
  SILTPOKE_SUPPRESSION_ENABLED: "1",
  SILTPOKE_SUPPRESSION_DISABLE_RESPAWN: "1",
};

function isAlready(r: { stdout: string; stderr: string }): boolean {
  return /already/i.test(`${r.stdout}\n${r.stderr}`);
}

/**
 * Install project-lifecycle via the public Claude-plugin marketplace (AC15).
 * Account-free (no GitHub login). Idempotent: an "already added/installed"
 * non-zero exit is treated as success. Non-fatal: PLC is additive over the
 * core siltpoke install, so a real failure warns rather than throws.
 */
export function installPlc(opts: {
  exec: PlcExec;
  io: WizardIO;
  claudePresent: boolean;
  claudeBin?: string;
}): PlcInstallResult {
  const { exec, io } = opts;
  const claudeBin = opts.claudeBin ?? "claude";
  if (!opts.claudePresent) {
    io.write(
      "! Claude Code not found — skipping project-lifecycle install (it's a claude plugin). Install it later with:\n" +
        `  claude plugin marketplace add ${PLC_MARKETPLACE}\n  claude plugin install ${PLC_PLUGIN}\n`,
    );
    return { added: false, installed: false, reason: "no-claude" };
  }

  const env = { ...process.env, ...SUPPRESS_ENV };
  const add = exec(claudeBin, ["plugin", "marketplace", "add", PLC_MARKETPLACE], env);
  const install = exec(claudeBin, ["plugin", "install", PLC_PLUGIN], env);

  const addOk = add.status === 0 || isAlready(add);
  const installOk = install.status === 0 || isAlready(install);
  const reason: PlcInstallResult["reason"] =
    isAlready(add) || isAlready(install) ? "already" : "ok";

  if (!addOk || !installOk) {
    io.write(
      "! project-lifecycle install did not fully succeed — siltpoke core is fine. Retry later with:\n" +
        `  claude plugin marketplace add ${PLC_MARKETPLACE}\n  claude plugin install ${PLC_PLUGIN}\n`,
    );
  } else {
    // AC16: PLC methodology runs on local git alone; GitHub tail is optional.
    io.write(
      "✓ project-lifecycle installed. Its workflow (brainstorm → spec → plan → TDD → journal) works with just local git — no GitHub account needed.\n",
    );
  }

  return { added: addOk, installed: installOk, reason };
}

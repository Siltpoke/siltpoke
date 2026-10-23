// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { markDone, recordBefore } from "./receipt";
import { outsideToolEntry } from "./receipt-sites";
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
export const PLC_PLUGIN ="project-lifecycle@project-life-cycle";

// AC17: suppress siltpoke's Stop/SessionStart hooks if the claude-plugin call
// triggers one mid-install (reuses the existing shouldFire suppression path).
const SUPPRESS_ENV = {
  SILTPOKE_SUPPRESSION_ENABLED: "1",
  SILTPOKE_SUPPRESSION_DISABLE_RESPAWN: "1",
};

/**
 * What `claude plugin list` says about the plugin. `unknown` = the probe itself
 * failed (could not spawn, non-zero exit): for ASKING it counts as absent (we
 * never install without a question on a guess), for ownership it counts as
 * "not ours" (never claim what we cannot show).
 */
type PlcProbe = "present" | "absent" | "unknown";

export function probePlc(exec: PlcExec, claudeBin: string, env: NodeJS.ProcessEnv = process.env): PlcProbe {
  const listed = exec(claudeBin, ["plugin", "list"], { ...env, ...SUPPRESS_ENV });
  if (listed.status !== 0) return "unknown";
  return listed.stdout.includes("project-lifecycle") ? "present" : "absent";
}

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
  /** Env for the install receipt (`~/.siltpoke/receipt.json`); defaults to process.env. */
  receiptEnv?: NodeJS.ProcessEnv;
  /** The caller's `probePlc` result, so the plugin list is read once. Omitted ⇒ probed here. */
  probe?: PlcProbe;
}): PlcInstallResult {
  const { exec, io } = opts;
  const receiptEnv = opts.receiptEnv ?? process.env;
  const claudeBin = opts.claudeBin ?? "claude";
  if (!opts.claudePresent) {
    io.write(
      "! Claude Code not found — skipping project-lifecycle install (it's a claude plugin). Install it later with:\n" +
        `  claude plugin marketplace add ${PLC_MARKETPLACE}\n  claude plugin install ${PLC_PLUGIN}\n`,
    );
    return { added: false, installed: false, reason: "no-claude" };
  }

  const env = { ...process.env, ...SUPPRESS_ENV };
  // Receipt (spec §2.1, §5): was the plugin there before we act? An unreadable
  // probe counts as "yes, it was" — never claim ownership we cannot show.
  const probe = opts.probe ?? probePlc(exec, claudeBin);
  const entry = outsideToolEntry("tool:plc", PLC_PLUGIN, probe === "absent", {
    type: "claude-plugin-uninstall",
    plugin: PLC_PLUGIN,
    marketplace: PLC_MARKETPLACE,
  });
  recordBefore(entry, receiptEnv);
  if (probe === "present") {
    // Already installed (not by us): run nothing — a second `plugin install` can duplicate a copy from another marketplace.
    markDone(entry.id, receiptEnv);
    io.write("✓ project-lifecycle is already installed — left as it is.\n");
    return { added: false, installed: true, reason: "already" };
  }
  const add = exec(claudeBin, ["plugin", "marketplace", "add", PLC_MARKETPLACE], env);
  const install = exec(claudeBin, ["plugin", "install", PLC_PLUGIN], env);

  const addOk = add.status === 0 || isAlready(add);
  const installOk = install.status === 0 || isAlready(install);
  if (addOk && installOk) markDone(entry.id, receiptEnv);
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

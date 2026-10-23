// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { markDone, type NewReceiptEntry, readReceipt, recordBefore } from "./receipt";
import type { WizardIO } from "./wizard";
import { askYesNo } from "./wizard";

export type Exec = (cmd: string, args: string[]) => { status: number; stdout: string };
export type PrereqName = "bun" | "git" | "brew" | "node";
export interface PrereqStatus { name: PrereqName; present: boolean; version: string | null }
export interface EnsureResult { name: PrereqName; action: "present" | "installed" | "declined" | "gui-pending" | "guide" }

const BIN: Record<PrereqName, string> = { bun: "bun", git: "git", brew: "brew", node: "node" };

export function detectPrereqs(
  exec: Exec,
  names: PrereqName[] = ["bun", "git", "brew", "node"],
  platform: NodeJS.Platform = process.platform,
): PrereqStatus[] {
  return names.map((name) => {
    const r =
      platform === "win32"
        ? exec("where", [BIN[name]])
        : exec("command", ["-v", BIN[name]]);
    return { name, present: r.status === 0, version: null };
  });
}

/**
 * Install-receipt entry for a general tool (spec §2.2 `outside-tool`, §5: bun
 * and git are never offered for removal, but the record says who put them
 * there). `byUs` is what the presence probe saw a moment ago.
 */
function toolEntry(name: "bun" | "git", byUs: boolean): NewReceiptEntry {
  return {
    id: `tool:${name}`,
    kind: "outside-tool",
    target: name,
    byUs,
    level: "purge",
    undo: { type: "none", reason: "general tool — never offered for removal (spec §5)" },
  };
}

/**
 * Record a tool that was already there: nothing was done, so it is done. An
 * entry that is already in the receipt wins: on a re-run the tool is on PATH
 * because an earlier run (or bootstrap.sh) installed it, and seeing it there
 * must not turn "ours" into "was already there".
 */
function recordPresent(name: "bun" | "git", env: NodeJS.ProcessEnv): void {
  if (readReceipt(env)?.entries.some((e) => e.id === `tool:${name}` && e.state === "done")) return;
  recordBefore(toolEntry(name, false), env);
  markDone(`tool:${name}`, env);
}

export async function ensureBun(
  exec: Exec,
  io: WizardIO,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnsureResult> {
  if (detectPrereqs(exec, ["bun"], platform)[0].present) {
    recordPresent("bun", env);
    return { name: "bun", action: "present" };
  }
  const ok = await askYesNo(io, "Bun is required and not installed. Install it now?");
  if (!ok) {
    // [63]: a No (or a run with no terminal: Enter / EOF means No here) says how to do it later.
    io.write(
      `Skipped. To install Bun later: ${platform === "win32" ? "irm bun.sh/install.ps1 | iex" : "curl -fsSL https://bun.com/install | bash"}\n`,
    );
    return { name: "bun", action: "declined" };
  }
  recordBefore(toolEntry("bun", true), env);
  const r =
    platform === "win32"
      ? exec("powershell", ["-Command", "irm bun.sh/install.ps1 | iex"])
      : exec("bash", ["-c", "curl -fsSL --proto '=https' --tlsv1.2 https://bun.com/install | bash"]);
  // A failed installer leaves the entry pending; the planner checks the disk.
  if (r.status === 0) markDone("tool:bun", env);
  return { name: "bun", action: "installed" };
}

export async function ensureGit(
  exec: Exec,
  io: WizardIO,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnsureResult> {
  if (detectPrereqs(exec, ["git"], platform)[0].present) {
    recordPresent("git", env);
    return { name: "git", action: "present" };
  }
  const question =
    platform === "win32"
      ? "git is required (local version control) and not installed. Install it now?"
      : "git is required (local version control) and not installed. Install Apple developer tools now?";
  const ok = await askYesNo(io, question);
  if (!ok) {
    io.write(
      `Skipped. To install git later: ${platform === "win32" ? "winget install --id Git.Git -e --source winget" : "xcode-select --install"}\n`,
    );
    return { name: "git", action: "declined" };
  }
  if (platform === "win32") {
    const hasWinget = exec("where", ["winget"]).status === 0;
    if (hasWinget) {
      recordBefore(toolEntry("git", true), env);
      const r = exec("winget", ["install", "--id", "Git.Git", "-e", "--source", "winget"]);
      if (r.status === 0) markDone("tool:git", env);
      return { name: "git", action: "installed" };
    }
    io.write(
      "winget not found. Install Git for Windows manually from https://gitforwindows.org, then re-run the installer.\n",
    );
    return { name: "git", action: "guide" };
  }
  // xcode-select only opens Apple's GUI installer and returns; whether git
  // arrives is unknown here, so the entry stays pending.
  recordBefore(toolEntry("git", true), env);
  exec("xcode-select", ["--install"]);
  return { name: "git", action: "gui-pending" };
}

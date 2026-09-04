// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
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

export async function ensureBun(
  exec: Exec,
  io: WizardIO,
  platform: NodeJS.Platform = process.platform,
): Promise<EnsureResult> {
  if (detectPrereqs(exec, ["bun"], platform)[0].present) return { name: "bun", action: "present" };
  const ok = await askYesNo(io, "Bun is required and not installed. Install it now?");
  if (!ok) return { name: "bun", action: "declined" };
  if (platform === "win32") {
    exec("powershell", ["-Command", "irm bun.sh/install.ps1 | iex"]);
  } else {
    exec("bash", ["-c", "curl -fsSL --proto '=https' --tlsv1.2 https://bun.com/install | bash"]);
  }
  return { name: "bun", action: "installed" };
}

export async function ensureGit(
  exec: Exec,
  io: WizardIO,
  platform: NodeJS.Platform = process.platform,
): Promise<EnsureResult> {
  if (detectPrereqs(exec, ["git"], platform)[0].present) return { name: "git", action: "present" };
  const question =
    platform === "win32"
      ? "git is required (local version control) and not installed. Install it now?"
      : "git is required (local version control) and not installed. Install Apple developer tools now?";
  const ok = await askYesNo(io, question);
  if (!ok) return { name: "git", action: "declined" };
  if (platform === "win32") {
    const hasWinget = exec("where", ["winget"]).status === 0;
    if (hasWinget) {
      exec("winget", ["install", "--id", "Git.Git", "-e", "--source", "winget"]);
      return { name: "git", action: "installed" };
    }
    io.write(
      "winget not found. Install Git for Windows manually from https://gitforwindows.org, then re-run the installer.\n",
    );
    return { name: "git", action: "guide" };
  }
  exec("xcode-select", ["--install"]);
  return { name: "git", action: "gui-pending" };
}

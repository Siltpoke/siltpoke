// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Doctor row: can the interpreter named in `statusLine.command` actually run?
 *
 * Defect [10] (install audit 2026-09-16 §11.1 / §17.1): the plugin install
 * wrote `sh <shim>` on every platform. Windows has no bare `sh`, so the command
 * never started and the pet never appeared — while every doctor row stayed
 * green, because nothing here checked the one external condition the statusline
 * depends on. That is the gap §10.1 of the audit named in general: doctor
 * asserted on its own files and never on what those files point AT.
 *
 * Deliberately narrow. Only Siltpoke's own statusline is graded — a user
 * running starship keeps their prompt and gets an info row, not a red one.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveClaudeHome } from "../installer/paths";
import { splitInterpreter } from "../installer/statusline-interpreter";
import { type CheckResult, type DoctorOptions, detectDoctorHost } from "./doctor";

const CHECK_NAME = "statusline interpreter runnable";

/** The settings file's `statusLine.command`, or null when there is nothing to read. */
function readStatuslineCommand(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const statusLine = (parsed as { statusLine?: { command?: unknown } }).statusLine;
    return typeof statusLine?.command === "string" ? statusLine.command : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether this install's statusLine is ours to grade, and if so which
 * interpreter it names. Returns a finished row when there is nothing to grade.
 */
function interpreterToCheck(opts: DoctorOptions, path: string): CheckResult | string {
  const host = detectDoctorHost(opts);
  if (host !== "claude-code") {
    return {
      name: CHECK_NAME,
      pass: true,
      status: "info",
      detail: `skipped — this is a ${host} install; ${path} is not what it is wired through`,
    };
  }
  const command = readStatuslineCommand(path);
  if (command === null || command.trim().length === 0) {
    // An unreadable settings.json is already reported loudly by
    // `checkSettingsJson`; a second red row would be the same fault twice.
    return {
      name: CHECK_NAME,
      pass: true,
      status: "info",
      detail:
        "no Siltpoke statusLine to check — the pet's statusline is opt-in (`/siltpoke-setup --statusline`)",
    };
  }
  if (!command.includes("statusline.sh") && !command.includes("siltpoke")) {
    return {
      name: CHECK_NAME,
      pass: true,
      status: "info",
      detail: "the wired statusLine is not Siltpoke's — left alone",
    };
  }
  const interpreter = splitInterpreter(command);
  if (interpreter === null) {
    return {
      name: CHECK_NAME,
      pass: false,
      detail: `could not read an interpreter out of statusLine.command in ${path} (${command})`,
    };
  }
  return interpreter;
}

export function checkStatuslineInterpreter(opts: DoctorOptions = {}): CheckResult {
  const path = join(opts.claudeHome ?? resolveClaudeHome(), "settings.json");
  const decided = interpreterToCheck(opts, path);
  if (typeof decided !== "string") return decided;

  const isPath = decided.includes("/") || decided.includes("\\");
  const found = isPath
    ? (opts.statuslineExistsFn ?? existsSync)(decided)
    : (opts.statuslineWhichFn ?? ((c: string) => Bun.which(c)))(decided) !== null;
  if (found) {
    return { name: CHECK_NAME, pass: true, detail: null };
  }
  return {
    name: CHECK_NAME,
    pass: false,
    detail:
      `statusLine.command in ${path} runs the shim with \`${decided}\`, which ` +
      `${isPath ? "does not exist on disk" : "is not on PATH"} — the statusline ` +
      "cannot start, and renders nothing rather than an error. " +
      (isPath
        ? "Point it at a shell that exists."
        : 'On Windows use Git Bash, e.g. "C:/Program Files/Git/bin/bash.exe".'),
  };
}

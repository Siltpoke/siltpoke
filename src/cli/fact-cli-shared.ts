// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Shared plumbing for the single-fact-id CLI commands (approve-fact.ts /
 * reject-fact.ts): the stdout output helper, single-positional-id arg
 * parsing, and the "read the fact store, report not-found" preamble. Both
 * commands repeated this byte-for-byte, differing only in the command name
 * baked into user-facing messages — extracted so that difference is the
 * only thing left in each file.
 */

import type { CoreMemory, readMemory, writeMemory } from "../memory/memory";
import { siltpokeRoot } from "../installer/paths";

export type OutputFn = (msg: string) => void;

export const defaultOutput: OutputFn = (msg: string) => {
  process.stdout.write(`${msg}\n`);
};

export type ParsedFactIdArgs =
  | { ok: true; id: string }
  | { ok: false; message: string };

/**
 * Parse `argv` for a single-fact-id CLI command: reject any `--flag`,
 * require exactly one positional arg (the fact id). `commandName` is used
 * only in the "missing id" usage message (e.g. "approve" / "reject").
 */
export function parseSingleFactIdArg(
  argv: string[],
  commandName: string,
): ParsedFactIdArgs {
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith("--")) {
      return { ok: false, message: `unknown flag: ${arg}` };
    }
    positional.push(arg);
  }

  if (positional.length === 0) {
    return {
      ok: false,
      message: `missing fact id — usage: siltpoke ${commandName} <fact-id>`,
    };
  }

  return { ok: true, id: positional[0]! };
}

export type LoadMemoryResult =
  | { ok: true; memory: CoreMemory }
  | { ok: false; exitCode: number };

/**
 * Read the fact store and report a not-found exit (1) both on a read error
 * and on an empty/missing store (the CLI's existing "no file yet" ==
 * "fact not found" behavior). `commandName` and `id` are used only in the
 * output message text.
 */
export async function loadMemoryOrReport(
  readFn: typeof readMemory,
  homeBase: string,
  commandName: string,
  id: string,
  out: OutputFn,
): Promise<LoadMemoryResult> {
  let memory: CoreMemory | null;
  try {
    memory = await readFn(homeBase);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`siltpoke ${commandName}: read failed: ${msg}`);
    return { ok: false, exitCode: 1 };
  }

  if (!memory) {
    out(`siltpoke ${commandName}: fact not found: ${id}`);
    return { ok: false, exitCode: 1 };
  }

  return { ok: true, memory };
}

/**
 * Write the fact store back, reporting a "write failed" exit (1) on error.
 * Returns `null` on success (caller proceeds to its own success output),
 * or the exit code to return immediately on failure.
 */
export async function writeMemoryOrReport(
  writeFn: typeof writeMemory,
  homeBase: string,
  memory: CoreMemory,
  commandName: string,
  out: OutputFn,
): Promise<number | null> {
  try {
    await writeFn(homeBase, memory);
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`siltpoke ${commandName}: write failed: ${msg}`);
    return 1;
  }
}

/**
 * `if (import.meta.main)` entry-point boilerplate shared by both single-fact
 * CLI commands: read argv/HOME, run, exit with the returned code.
 */
export async function runFactCliMain(
  run: (opts: { argv: string[]; homeBase: string }) => Promise<number>,
): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const homeBase = siltpokeRoot();
  const code = await run({ argv: rawArgs, homeBase });
  process.exit(code);
}

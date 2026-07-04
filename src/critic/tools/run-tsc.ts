// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { spawnWithTimeout } from "../spawn";
import type { TscDiagnostic, ToolResult, ToolStatus } from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTICS = 20;

// Matches lines like: src/foo.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.
const DIAGNOSTIC_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/;

function parseTscOutput(stdout: string): TscDiagnostic[] {
  const lines = stdout.split("\n");
  const diagnostics: TscDiagnostic[] = [];
  let current: TscDiagnostic | null = null;

  for (const line of lines) {
    // Skip "Found N error(s)" footer
    if (/^Found \d+ error/.test(line)) continue;

    const match = DIAGNOSTIC_RE.exec(line);
    if (match) {
      current = {
        file: match[1]!,
        line: parseInt(match[2]!, 10),
        col: parseInt(match[3]!, 10),
        severity: match[4] as "error" | "warning",
        code: match[5]!,
        message: match[6]!,
      };
      diagnostics.push(current);
    } else if (current !== null && /^\s/.test(line) && line.trim().length > 0) {
      // Continuation line (indented) — append to previous diagnostic's message
      const prev: TscDiagnostic = current;
      current = { ...prev, message: `${prev.message}\n${line}` };
      diagnostics[diagnostics.length - 1] = current;
    }
  }

  return diagnostics;
}

function sortAndCap(diagnostics: TscDiagnostic[]): TscDiagnostic[] {
  const sorted = [...diagnostics].sort((a, b) => {
    // errors first
    if (a.severity !== b.severity) {
      return a.severity === "error" ? -1 : 1;
    }
    // then alphabetical by file
    const fileCmp = a.file.localeCompare(b.file);
    if (fileCmp !== 0) return fileCmp;
    // then by line
    return a.line - b.line;
  });
  return sorted.slice(0, MAX_DIAGNOSTICS);
}

function buildRaw(stdout: string, stderr: string): string {
  if (stderr.trim().length === 0) return stdout;
  return `${stdout}\n--- stderr ---\n${stderr}`;
}

export async function runTsc(opts: {
  cwd: string;
  tsconfigPath: string;
  timeoutMs?: number;
  /** Test-only affordance: override the process env passed to the spawned process. */
  _env?: Record<string, string>;
}): Promise<Extract<ToolResult, { tool: "tsc" }>> {
  const { cwd, tsconfigPath, timeoutMs = DEFAULT_TIMEOUT_MS, _env } = opts;

  const argv = [
    "bunx",
    "tsc",
    "--noEmit",
    "--project",
    tsconfigPath,
    "--pretty",
    "false",
  ];

  const result = await spawnWithTimeout({ argv, cwd, env: _env, timeoutMs });
  const raw = buildRaw(result.stdout, result.stderr);

  if (result.timedOut) {
    return { tool: "tsc", status: "timeout", parsed: [], raw };
  }

  // ENOENT path: spawnWithTimeout catches spawn errors and returns exitCode 1 with empty stdout/stderr.
  // We detect "not_installed" when exitCode != 0 AND stdout is empty AND stderr is empty
  // (tsc always writes something to stdout/stderr on real errors).
  // A more reliable check: if exit is non-zero and there's no parseable output and
  // stderr is also empty, it was likely an ENOENT.
  if (result.exitCode !== 0 && result.stdout.trim() === "" && result.stderr.trim() === "") {
    return { tool: "tsc", status: "not_installed", parsed: [], raw };
  }

  let parsed: TscDiagnostic[];
  try {
    parsed = parseTscOutput(result.stdout);
  } catch {
    return { tool: "tsc", status: "error", parsed: [], raw };
  }

  const capped = sortAndCap(parsed);

  let status: ToolStatus;
  if (result.exitCode !== 0 && capped.length === 0) {
    // tsc itself crashed (non-zero, no parseable output, but stdout/stderr non-empty)
    status = "error";
  } else {
    // exit 0 → ok (clean or warnings)
    // exit != 0 with parsed errors → ok (normal errors-found state)
    status = "ok";
  }

  return { tool: "tsc", status, parsed: capped, raw };
}

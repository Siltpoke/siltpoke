// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { spawnWithTimeout } from "../spawn";
import type { EslintFinding, ToolResult, ToolStatus } from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_FINDINGS = 20;

type EslintMessage = {
  ruleId: string | null;
  severity: 1 | 2;
  message: string;
  line: number;
  column: number;
};

type EslintLintResult = {
  filePath: string;
  messages: EslintMessage[];
};

function parseEslintOutput(stdout: string): EslintFinding[] {
  if (stdout.trim() === "") return [];

  let results: EslintLintResult[];
  try {
    results = JSON.parse(stdout) as EslintLintResult[];
  } catch {
    return [];
  }

  const findings: EslintFinding[] = [];
  for (const fileResult of results) {
    for (const msg of fileResult.messages) {
      findings.push({
        file: fileResult.filePath,
        line: msg.line,
        col: msg.column,
        severity: msg.severity === 2 ? "error" : "warning",
        ruleId: msg.ruleId ?? "(unknown)",
        message: msg.message,
      });
    }
  }

  return findings;
}

function sortAndCap(findings: EslintFinding[]): EslintFinding[] {
  const sorted = [...findings].sort((a, b) => {
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
  return sorted.slice(0, MAX_FINDINGS);
}

function buildRaw(stdout: string, stderr: string): string {
  if (stderr.trim().length === 0) return stdout;
  return `${stdout}\n--- stderr ---\n${stderr}`;
}

export async function runEslint(opts: {
  cwd: string;
  changedFiles: string[];
  timeoutMs?: number;
  /** Test-only affordance: override the process env passed to the spawned process. */
  _env?: Record<string, string>;
}): Promise<Extract<ToolResult, { tool: "eslint" }>> {
  const { cwd, changedFiles, timeoutMs = DEFAULT_TIMEOUT_MS, _env } = opts;

  if (changedFiles.length === 0) {
    return { tool: "eslint", status: "not_applicable", parsed: [], raw: "" };
  }

  // Defensive: skip any path whose last segment starts with "-" to prevent
  // option injection (e.g. a filename like "--inspect" would be treated as an argv flag).
  // Note: changedFiles flowing into ripgrep's argv is not a concern today (rg gets cwd only).
  const safeFiles = changedFiles.filter((p) => {
    const lastSep = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    const basename = p.slice(lastSep + 1);
    const isSuspicious = basename.startsWith("-");
    if (isSuspicious) {
      console.error("[siltpoke critic] eslint: skipped suspicious path: %s", p);
    }
    return !isSuspicious;
  });

  if (safeFiles.length === 0) {
    return { tool: "eslint", status: "not_applicable", parsed: [], raw: "" };
  }

  const argv = ["bunx", "eslint", "--format", "json", ...safeFiles];

  const result = await spawnWithTimeout({ argv, cwd, env: _env, timeoutMs });
  const raw = buildRaw(result.stdout, result.stderr);

  if (result.timedOut) {
    return { tool: "eslint", status: "timeout", parsed: [], raw };
  }

  // ENOENT detection: exitCode != 0 AND empty stdout/stderr
  if (result.exitCode !== 0 && result.stdout.trim() === "" && result.stderr.trim() === "") {
    return { tool: "eslint", status: "not_installed", parsed: [], raw };
  }

  // ESLint exit code 2 = config error / fatal error
  if (result.exitCode === 2) {
    return { tool: "eslint", status: "error", parsed: [], raw };
  }

  let parsed: EslintFinding[];
  try {
    parsed = parseEslintOutput(result.stdout);
  } catch {
    return { tool: "eslint", status: "error", parsed: [], raw };
  }

  const capped = sortAndCap(parsed);

  // exit 0 or 1 → ok (clean or findings)
  const status: ToolStatus = "ok";
  return { tool: "eslint", status, parsed: capped, raw };
}

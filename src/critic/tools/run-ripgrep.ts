// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { spawnWithTimeout } from "../spawn";
import type { RipgrepMatch, ToolResult, ToolStatus } from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_MATCHES = 50;

const DEFAULT_PATTERN =
  "TODO|FIXME|HACK|XXX|SECRET|API_KEY|TODO\\(.*\\)";

type RipgrepJsonLine =
  | { type: "match"; data: RipgrepMatchData }
  | { type: "begin" | "end" | "summary" | "context"; data: unknown };

type RipgrepMatchData = {
  path: { text: string };
  line_number: number;
  lines: { text: string };
  submatches: Array<{
    match: { text: string };
    start: number;
    end: number;
  }>;
};

function parseRipgrepOutput(stdout: string): RipgrepMatch[] {
  const matches: RipgrepMatch[] = [];

  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;

    let parsed: RipgrepJsonLine;
    try {
      parsed = JSON.parse(line) as RipgrepJsonLine;
    } catch {
      // Skip malformed lines
      continue;
    }

    if (parsed.type !== "match") continue;

    const data = parsed.data as RipgrepMatchData;
    const file = data.path.text;
    const lineNum = data.line_number;
    const text = data.lines.text.trimEnd();

    // Extract pattern from the first submatch — take leading keyword
    const firstSubmatch = data.submatches[0];
    let pattern = "";
    if (firstSubmatch !== undefined) {
      // Extract the leading keyword (e.g. "TODO", "FIXME", "HACK", etc.)
      const matchText = firstSubmatch.match.text;
      const keywordMatch = /^(TODO|FIXME|HACK|XXX|SECRET|API_KEY)/.exec(matchText);
      pattern = keywordMatch !== null ? keywordMatch[1]! : matchText;
    }

    matches.push({ file, line: lineNum, text, pattern });
  }

  return matches;
}

function sortAndCap(matches: RipgrepMatch[]): RipgrepMatch[] {
  const sorted = [...matches].sort((a, b) => {
    const fileCmp = a.file.localeCompare(b.file);
    if (fileCmp !== 0) return fileCmp;
    return a.line - b.line;
  });
  return sorted.slice(0, MAX_MATCHES);
}

function buildRaw(stdout: string, stderr: string): string {
  if (stderr.trim().length === 0) return stdout;
  return `${stdout}\n--- stderr ---\n${stderr}`;
}

export async function runRipgrep(opts: {
  cwd: string;
  patterns?: string[];
  timeoutMs?: number;
  /** Override the rg binary path. Defaults to "rg" (resolved via PATH). Used in tests. */
  rgBin?: string;
}): Promise<Extract<ToolResult, { tool: "ripgrep" }>> {
  const { cwd, patterns, timeoutMs = DEFAULT_TIMEOUT_MS, rgBin = "rg" } = opts;

  const pattern =
    patterns !== undefined && patterns.length > 0
      ? patterns.join("|")
      : DEFAULT_PATTERN;

  const argv = [rgBin, "--json", "-e", pattern, "--max-count", "100", cwd];

  const result = await spawnWithTimeout({ argv, cwd, timeoutMs });
  const raw = buildRaw(result.stdout, result.stderr);

  if (result.timedOut) {
    return { tool: "ripgrep", status: "timeout", parsed: [], raw };
  }

  // ENOENT: exitCode != 0, empty stdout and stderr
  if (result.exitCode !== 0 && result.stdout.trim() === "" && result.stderr.trim() === "") {
    return { tool: "ripgrep", status: "not_installed", parsed: [], raw };
  }

  // ripgrep exits 2 on error
  if (result.exitCode !== null && result.exitCode >= 2) {
    return { tool: "ripgrep", status: "error", parsed: [], raw };
  }

  let parsed: RipgrepMatch[];
  try {
    parsed = parseRipgrepOutput(result.stdout);
  } catch {
    return { tool: "ripgrep", status: "error", parsed: [], raw };
  }

  // exit 0 → matches found → ok
  // exit 1 → no matches → ok (clean)
  const capped = sortAndCap(parsed);
  const status: ToolStatus = "ok";

  return { tool: "ripgrep", status, parsed: capped, raw };
}

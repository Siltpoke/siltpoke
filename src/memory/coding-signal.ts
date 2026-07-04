// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Coding-signal loader for memory consolidation. Reads the developer's recent
 * git commits as a consolidation input stream so working-style / project-context
 * facts can be distilled automatically. Mirrors chat-signal.ts; reuses its
 * write-boundary secret filter. Degrades to [] on any git error.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { containsSecret } from "./chat-signal";

const execFileAsync = promisify(execFile);
const DEFAULT_CAP = 30;
const RS = "\x1e"; // record separator
const FS = "\x1f"; // field separator

export type CommitSignal = {
  sha: string;
  subject: string;
  files: string[];
  additions: number;
  deletions: number;
  date: string;
};

async function defaultRunGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export async function loadRecentCommits(
  projectRoot: string,
  since: Date,
  opts?: { cap?: number; runGit?: (args: string[], cwd: string) => Promise<string> },
): Promise<CommitSignal[]> {
  const cap = opts?.cap ?? DEFAULT_CAP;
  const runGit = opts?.runGit ?? defaultRunGit;
  let raw: string;
  try {
    raw = await runGit(
      [
        "log",
        `--since=${since.toISOString()}`,
        `-n`,
        String(cap),
        "--no-merges",
        `--pretty=format:${RS}%H${FS}%s${FS}%cI`,
        "--numstat",
      ],
      projectRoot,
    );
  } catch {
    return [];
  }

  const out: CommitSignal[] = [];
  for (const rec of raw.split(RS)) {
    if (!rec.trim()) continue;
    const lines = rec.split("\n");
    const header = lines[0] ?? "";
    const [sha, subject, date] = header.split(FS);
    if (!sha || subject === undefined || !date) continue;
    if (containsSecret(subject)) continue; // write-boundary drop
    let additions = 0;
    let deletions = 0;
    const files: string[] = [];
    for (const ln of lines.slice(1)) {
      if (!ln.trim()) continue;
      const [a, d, path] = ln.split("\t");
      if (!path) continue;
      additions += Number(a) || 0;
      deletions += Number(d) || 0;
      files.push(path);
    }
    out.push({ sha, subject, files, additions, deletions, date });
    if (out.length >= cap) break;
  }
  return out;
}

export type CriticEventSummary = { byCategory: Record<string, number>; total: number };

// Known rubric rule-ids (see src/critic/rubric/descriptions.ts). Extend as the
// rubric grows; unmatched bodies bucket as "other".
const RULE_MARKERS = [
  "god-file",
  "long-function",
  "long-param-list",
  "many-params",
  "deep-nesting",
  "magic-number",
  "duplicate-code",
];

export function summarizeCriticEvents(
  critiques: Array<{ ts: string; body: string }>,
  since: Date,
): CriticEventSummary {
  const byCategory: Record<string, number> = {};
  let total = 0;
  for (const c of critiques) {
    if (new Date(c.ts).getTime() < since.getTime()) continue;
    total += 1;
    const hit = RULE_MARKERS.find((m) => c.body.includes(m)) ?? "other";
    byCategory[hit] = (byCategory[hit] ?? 0) + 1;
  }
  return { byCategory, total };
}

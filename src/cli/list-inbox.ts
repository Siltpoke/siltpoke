// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readStatus } from "../state/critique-status";
import { readMemory, type Fact } from "../memory/memory";

interface HistoryEntry {
  timestamp: string;
  critique_id: string;
  session_id?: string;
  cwd?: string;
  mood?: string;
  severity?: string;
  confidence?: string;
  bubble_short?: string;
  path?: string;
}

export interface ListInboxOptions {
  basePath: string;
  /** When true, list pending facts instead of pending critiques (PQ7). */
  facts?: boolean;
}

/** Return a human-readable relative time string, e.g. "3d ago", "2h ago". */
function relativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  if (diffSecs < 60) return `${diffSecs}s ago`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/**
 * List pending facts from memory.
 * PQ7: siltpoke-inbox --facts surface.
 */
async function listFactsInbox(homeBase: string): Promise<string> {
  const memory = await readMemory(homeBase);
  if (!memory) {
    return "no pending facts\n";
  }

  const pending: Fact[] = memory.facts
    .filter((f) => f.status === "pending")
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

  if (pending.length === 0) {
    return "no pending facts\n";
  }

  const rows = pending.map((f) => {
    const id = f.id;
    const claim = f.text.length > 60 ? `${f.text.slice(0, 60)}…` : f.text;
    const conf = f.confidence.toFixed(2);
    const rel = relativeTime(f.created_at);
    return `${id} | ${claim} | conf=${conf} | ${rel}`;
  });

  const footer =
    `${pending.length} pending facts. ` +
    `Approve: /siltpoke-approve <id>  Reject: /siltpoke-reject <id>`;

  return `${rows.join("\n")}\n${footer}\n`;
}

function parseHistoryLine(line: string): HistoryEntry | null {
  try {
    return JSON.parse(line) as HistoryEntry;
  } catch {
    return null;
  }
}

export async function listInbox(opts: ListInboxOptions): Promise<string> {
  if (opts.facts) {
    return listFactsInbox(opts.basePath);
  }

  const historyPath = join(opts.basePath, "critiques", "history.jsonl");
  if (!existsSync(historyPath)) {
    return "# Siltpoke inbox is empty — no pending critiques.\n";
  }

  let raw: string;
  try {
    raw = await readFile(historyPath, "utf8");
  } catch {
    return "# Siltpoke inbox is empty — no pending critiques.\n";
  }

  const entries = raw
    .split("\n")
    .map(parseHistoryLine)
    .filter((e): e is HistoryEntry => e !== null && !!e.path);

  const pending: HistoryEntry[] = [];
  for (const entry of entries) {
    const status = await readStatus(entry.path!);
    if (status === "pending") pending.push(entry);
  }

  if (pending.length === 0) {
    return "# Siltpoke inbox is empty — no pending critiques.\n";
  }

  const rows = [
    "ID       SEVERITY  TIMESTAMP            BUBBLE",
    ...pending.map((e) => {
      const id = (e.critique_id ?? "").padEnd(8);
      const sev = (e.severity ?? "").padEnd(9);
      const ts = (e.timestamp ?? "").slice(0, 19).padEnd(20);
      const rawBubble = e.bubble_short ?? "";
      const bubble = rawBubble.length > 80 ? `${rawBubble.slice(0, 80)}…` : rawBubble;
      return `${id} ${sev} ${ts} ${bubble}`;
    }),
  ];
  return `${rows.join("\n")}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const facts = args.includes("--facts");
  // Critiques are per-project; facts come from ~/.siltpoke/ (global home).
  const basePath = facts
    ? join(process.env.HOME ?? "", ".siltpoke")
    : join(process.cwd(), ".siltpoke");
  const out = await listInbox({ basePath, facts });
  process.stdout.write(out);
  process.exit(0);
}

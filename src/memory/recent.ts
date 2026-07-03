// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export interface RecentEntry {
  ts: string;
  critique_id: string;
  verdict: "forwarded" | "dismissed" | "acked";
  reason: string | null;
  critique_snippet?: string;
  file?: string;
  line?: number;
}

const DEFAULT_MAX = 20;

export function resolveRecentPath(
  cwd: string | undefined,
  homeBase: string,
): string {
  if (cwd && cwd.length > 0) {
    return join(cwd, ".siltpoke", "recent_feedback.jsonl");
  }
  return join(homeBase, "recent_feedback.jsonl");
}

function parseLine(line: string): RecentEntry | null {
  try {
    const parsed = JSON.parse(line) as RecentEntry;
    if (
      typeof parsed.ts !== "string" ||
      typeof parsed.critique_id !== "string" ||
      (parsed.verdict !== "forwarded" &&
        parsed.verdict !== "dismissed" &&
        parsed.verdict !== "acked")
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function readRecent(
  path: string,
  maxEntries: number = DEFAULT_MAX,
): Promise<RecentEntry[]> {
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, "utf8");
    const entries = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map(parseLine)
      .filter((e): e is RecentEntry => e !== null);
    return entries.slice(-maxEntries);
  } catch {
    return [];
  }
}

export async function appendRecent(
  path: string,
  entry: RecentEntry,
  maxEntries: number = DEFAULT_MAX,
): Promise<void> {
  try {
    const existing = await readRecent(path, maxEntries);
    const combined = [...existing, entry].slice(-maxEntries);
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
    await writeFile(
      tmpPath,
      `${combined.map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf8",
    );
    await rename(tmpPath, path);
  } catch {
    // never crash the caller
  }
}

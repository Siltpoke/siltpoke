// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { writeFile, rename, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface SkipStateEntry {
  hash: string;
  updated_at_ms: number;
}

export interface SkipState {
  schemaVersion: 1;
  entries: Record<string, SkipStateEntry>;
}

const FILENAME = "skip-state.json";
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

function skipStatePath(basePath: string): string {
  return join(basePath, FILENAME);
}

export function emptySkipState(): SkipState {
  return { schemaVersion: 1, entries: {} };
}

export async function readSkipState(basePath: string): Promise<SkipState> {
  const path = skipStatePath(basePath);
  if (!existsSync(path)) return emptySkipState();
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<SkipState>;
    if (parsed.schemaVersion !== 1 || typeof parsed.entries !== "object") {
      return emptySkipState();
    }
    return { schemaVersion: 1, entries: parsed.entries ?? {} };
  } catch {
    return emptySkipState();
  }
}

export async function writeSkipState(
  basePath: string,
  state: SkipState,
): Promise<void> {
  try {
    await mkdir(basePath, { recursive: true });
    const finalPath = skipStatePath(basePath);
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tmpPath, finalPath);
  } catch {
    // never crash the caller
  }
}

export function pruneExpired(
  state: SkipState,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now(),
): SkipState {
  const fresh: Record<string, SkipStateEntry> = {};
  for (const [key, entry] of Object.entries(state.entries)) {
    if (now - entry.updated_at_ms <= ttlMs) {
      fresh[key] = entry;
    }
  }
  return { schemaVersion: 1, entries: fresh };
}

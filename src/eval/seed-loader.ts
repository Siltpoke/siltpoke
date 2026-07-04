// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadFixtures, type Fixture } from "./harness";

export { loadFixtures };

const SEED_SET_PATH = join(homedir(), ".siltpoke", "eval", "seed-set.jsonl");

/**
 * Load eval fixtures from a seed-set JSONL file at `~/.siltpoke/eval/seed-set.jsonl`.
 * Returns an empty array when the file is absent (graceful fallback).
 */
export async function loadSeedSet(): Promise<Fixture[]> {
  let raw: string;
  try {
    raw = await readFile(SEED_SET_PATH, "utf8");
  } catch {
    // seed-set.jsonl is optional; return empty when missing
    return [];
  }

  const fixtures: Fixture[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      fixtures.push(JSON.parse(trimmed) as Fixture);
    } catch {
      // skip malformed lines
    }
  }
  return fixtures;
}

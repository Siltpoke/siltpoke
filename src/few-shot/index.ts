// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { FewShotIndexEntry } from "./types";
import { siltpokeRoot } from "../installer/paths";

const DEFAULT_PATH = join(siltpokeRoot(), "few-shot-index.json");

export async function loadIndex(path = DEFAULT_PATH): Promise<FewShotIndexEntry[]> {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(await readFile(path, "utf8")) as FewShotIndexEntry[];
  } catch {
    return [];
  }
}

export async function saveIndex(
  entries: FewShotIndexEntry[],
  path = DEFAULT_PATH,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(entries));
}

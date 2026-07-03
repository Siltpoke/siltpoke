// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function getCached(cacheDir: string, hash: string): Promise<string | null> {
  const path = join(cacheDir, `${hash}.md`);
  if (!existsSync(path)) return null;
  return readFile(path, "utf8");
}

export async function setCached(cacheDir: string, hash: string, content: string): Promise<void> {
  const path = join(cacheDir, `${hash}.md`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

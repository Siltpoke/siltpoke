// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type CritiqueStatus = "pending" | "forwarded" | "dismissed" | "acked";

const STATUS_LINE = /^status:\s*(\S+)\s*$/m;

export async function readStatus(
  critiquePath: string,
): Promise<CritiqueStatus | null> {
  try {
    const raw = await readFile(critiquePath, "utf8");
    const match = raw.match(STATUS_LINE);
    if (!match) return null;
    const value = match[1] as CritiqueStatus;
    if (
      value === "pending" ||
      value === "forwarded" ||
      value === "dismissed" ||
      value === "acked"
    ) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

export async function setStatus(
  critiquePath: string,
  next: CritiqueStatus,
): Promise<boolean> {
  try {
    const raw = await readFile(critiquePath, "utf8");
    if (!STATUS_LINE.test(raw)) return false;
    const rewritten = raw.replace(STATUS_LINE, `status: ${next}`);
    await writeFile(critiquePath, rewritten, "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function findCritiqueByIdOrLatest(
  basePath: string,
  idOrLatest: string,
): Promise<string | null> {
  const critiqueRoot = join(basePath, "critiques");

  if (idOrLatest === "latest") {
    const latestPath = join(critiqueRoot, "latest.md");
    return existsSync(latestPath) ? latestPath : null;
  }

  const archiveRoot = join(critiqueRoot, "archive");
  if (!existsSync(archiveRoot)) return null;

  try {
    const dates = await readdir(archiveRoot);
    for (const date of dates.sort().reverse()) {
      const dateDir = join(archiveRoot, date);
      const files = await readdir(dateDir);
      const match = files.find((f) => f === `${idOrLatest}.md`);
      if (match) return join(dateDir, match);
    }
    return null;
  } catch {
    return null;
  }
}

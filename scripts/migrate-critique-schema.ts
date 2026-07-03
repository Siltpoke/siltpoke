#!/usr/bin/env bun
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export function migrateCritiqueFile(content: string): string {
  if (/^schema_version:\s*2\b/m.test(content)) return content;
  return content.replace(
    /^---\n/,
    `---
schema_version: 2
category: correctness
intent_classification: exploration
intent_confidence: 0.0
signal_sources: []
`,
  );
}

export async function main(): Promise<void> {
  const archiveDir = join(homedir(), ".siltpoke", "critiques", "archive");
  let archiveDays: string[];
  try {
    archiveDays = await readdir(archiveDir);
  } catch {
    return;
  }
  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  const CHECKPOINT_INTERVAL = 50;
  let batch = 0;
  for (const day of archiveDays) {
    const dayPath = join(archiveDir, day);
    let files: string[];
    try {
      files = await readdir(dayPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const fp = join(dayPath, f);
      try {
        const original = await readFile(fp, "utf8");
        const updated = migrateCritiqueFile(original);
        if (updated === original) { skipped++; continue; }
        await writeFile(fp, updated);
        migrated++;
        if (++batch % CHECKPOINT_INTERVAL === 0) {
          await writeFile(
            join(archiveDir, "migration-checkpoint.json"),
            JSON.stringify({ last_file: fp, migrated, skipped, errors, ts: new Date().toISOString() }),
          );
        }
      } catch (e: unknown) {
        errors++;
        console.error(`Error on ${fp}:`, e);
      }
    }
  }
}

if (import.meta.main) main();

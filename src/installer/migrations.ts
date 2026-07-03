// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  copyFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  learnedRuleSchema,
  personalityDriftSchema,
} from "../memory/memory";
import { quarantineCorrupt } from "../utils/quarantine";

export type MigrationTarget =
  | "config"
  | "memory"
  | "state"
  | "skip-state"
  | "usage";

export interface Migration {
  file: MigrationTarget;
  from: number;
  to: number;
  migrate(state: Record<string, unknown>): Record<string, unknown>;
}

const FILE_PATHS: Record<MigrationTarget, string> = {
  config: "config.json",
  memory: "memory.json",
  state: "state.json",
  "skip-state": "skip-state.json",
  usage: "usage.json",
};

const memoryV1Schema = z.object({
  schemaVersion: z.literal(1),
  long_term_summary: z.string(),
  learned_rules: z.array(learnedRuleSchema),
  personality_drift: personalityDriftSchema,
  last_consolidated_at: z.string(),
  consolidation_due_at: z.string(),
});

export const memoryV1toV2: Migration = {
  file: "memory",
  from: 1,
  to: 2,
  migrate(raw) {
    const v1 = memoryV1Schema.parse(raw);
    return {
      ...v1,
      schemaVersion: 2,
      user_profile: {
        communication_style: "neutral",
        goals: [],
        constraints: [],
        prefs: {},
      },
      chat_sessions: [],
      facts: [],
    };
  },
};

export const MIGRATIONS: Migration[] = [memoryV1toV2];

// The SessionStart hook (handle-session-start.ts) writes
// {cwd}/.siltpoke/baseline.json at runtime — not a versioned JSON state file
// and therefore not managed by the MIGRATIONS registry above. Registration of
// the hook into settings.json is handled by registerSessionStartHook() in
// src/installer/register-session-start.ts, called from src/cli/install.ts.

// critique-schema-v1-to-v2 operates on markdown files in the archive
// filesystem tree (not JSON state files), so it does not fit the Migration
// interface above. It is registered here as a named export and is invoked
// by the installer as a separate step after MIGRATIONS run.
//
// id: "critique-schema-v1-to-v2"
// from: 1, to: 2
// description: "Add schema_version + category + intent fields to critique frontmatter"
export async function runCritiqueSchemaMigration(): Promise<void> {
  const { main } = await import("../../scripts/migrate-critique-schema");
  await main();
}

export interface MigrateResult {
  migrated: number;
  files_seen: number;
  errors: { file: MigrationTarget; message: string }[];
}

async function atomicWriteJson(
  path: string,
  data: unknown,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
  await rename(tmpPath, path);
}

async function clearOldBackups(
  path: string,
  fromVersion: number,
): Promise<void> {
  const dir = dirname(path);
  const prefix = `${basename(path)}.bak.v${fromVersion}.`;
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (entry.startsWith(prefix)) {
      await unlink(join(dir, entry)).catch(() => {});
    }
  }
}

async function backupBeforeMigrate(
  path: string,
  fromVersion: number,
): Promise<string> {
  await clearOldBackups(path, fromVersion);
  const backupPath = `${path}.bak.v${fromVersion}.${Date.now()}`;
  await copyFile(path, backupPath);
  return backupPath;
}

function chainFor(
  target: MigrationTarget,
  from: number,
  migrations: readonly Migration[],
): Migration[] {
  const chain: Migration[] = [];
  let current = from;
  while (true) {
    const step = migrations.find(
      (m) => m.file === target && m.from === current,
    );
    if (!step) break;
    chain.push(step);
    current = step.to;
  }
  return chain;
}

export async function migrateAll(
  homeBase: string,
  registry: readonly Migration[] = MIGRATIONS,
): Promise<MigrateResult> {
  const result: MigrateResult = { migrated: 0, files_seen: 0, errors: [] };
  for (const target of Object.keys(FILE_PATHS) as MigrationTarget[]) {
    const path = join(homeBase, FILE_PATHS[target]);
    if (!existsSync(path)) continue;
    result.files_seen += 1;
    let parsed: Record<string, unknown>;
    try {
      const raw = await readFile(path, "utf8");
      parsed = JSON.parse(raw);
    } catch (err) {
      const baseMsg = `parse failed: ${err instanceof Error ? err.message : String(err)}`;
      if (target === "memory") {
        const corruptPath = await quarantineCorrupt(path);
        result.errors.push({
          file: target,
          message: `quarantined corrupt file to ${corruptPath} (${baseMsg})`,
        });
      } else {
        result.errors.push({ file: target, message: baseMsg });
      }
      continue;
    }
    const version =
      typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1;
    const chain = chainFor(target, version, registry);
    if (chain.length === 0) continue;
    try {
      // backupBeforeMigrate copies file aside; on FS errors (full disk,
      // permission) it throws and is caught below — surfaces in result.errors
      // rather than crashing the installer.
      await backupBeforeMigrate(path, version);
      let state: Record<string, unknown> = parsed;
      for (const step of chain) {
        state = step.migrate(state);
      }
      await atomicWriteJson(path, state);
      result.migrated += 1;
    } catch (err) {
      result.errors.push({
        file: target,
        message: `migrate failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return result;
}

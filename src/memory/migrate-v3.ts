// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * v2 → v3 migration.
 *
 * Splits the v2 `~/.siltpoke/memory.json` into:
 *   - `~/.siltpoke/global.json` (identity: name / level / xp / appearance /
 *     personality_base / achievements / streak / bond / daily_caps + user
 *     name + communication_style)
 *   - `~/.siltpoke/projects/<sha>/memory.json` (observed memory: facts /
 *     chat_sessions / learned_rules / personality_drift / consolidation
 *     timestamps + project-scoped user_profile overrides)
 *
 * Resolves project for the v2 content at migration time via PQ1 walk on
 * `process.cwd()`. If cwd doesn't resolve to a real project (no .git, no
 * marker, etc.), falls back to a sentinel `__legacy__` project so data is
 * never dropped.
 *
 * Idempotent: re-runs when schemaVersion already 3 → no-op.
 * Atomic: each file write goes through tmp+rename.
 * Resumable: crash before step 6 (legacy rename) leaves backup + live v2
 *   intact; re-running picks up at step 1.
 */
import {
  copyFile,
  mkdir,
  rename,
  readFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { coreMemorySchema, type CoreMemory } from "./memory";
import {
  emptyGlobal,
  writeGlobal,
} from "./global";
import {
  resolveProjectRoot,
  emptyProject,
  writeProject,
  type ResolvedProject,
} from "./project";
import type { GlobalMemory, ProjectMemory } from "./schema-v3";

const V2_FILENAME = "memory.json";
const V2_LEGACY_RENAME = "memory.v2.legacy.json";
const BACKUPS_DIR = "backups";

export interface MigrateResult {
  migrated: boolean;
  project_id?: string;
  legacy_used?: boolean;
  backup_path?: string;
  reason?: string;
}

function v2Path(home: string): string {
  return join(home, V2_FILENAME);
}

async function readMaybeV2(path: string): Promise<CoreMemory | null> {
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    const r = coreMemorySchema.safeParse(parsed);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function buildGlobalFromV2(
  v2: CoreMemory,
  now: Date,
): GlobalMemory {
  const base = emptyGlobal(now);
  return {
    ...base,
    user_profile: {
      name: v2.user_profile.name ?? "",
      communication_style: v2.user_profile.communication_style,
    },
  };
}

function buildProjectFromV2(
  v2: CoreMemory,
  resolved: ResolvedProject,
): ProjectMemory {
  const base = emptyProject(resolved);
  return {
    ...base,
    facts: v2.facts,
    chat_sessions: v2.chat_sessions,
    learned_rules: v2.learned_rules,
    long_term_summary: v2.long_term_summary,
    last_consolidated_at: v2.last_consolidated_at,
    consolidation_due_at: v2.consolidation_due_at,
    // v2 drift is 4-dim; v3 adds curiosity. Migrate values; curiosity → 0.
    personality_drift: {
      snark: v2.personality_drift.snark,
      patience: v2.personality_drift.patience,
      style_strictness: v2.personality_drift.style_strictness,
      proactivity: v2.personality_drift.proactivity,
      curiosity: 0,
    },
    user_profile_override: {
      goals: v2.user_profile.goals,
      constraints: v2.user_profile.constraints,
      prefs: v2.user_profile.prefs,
      communication_style: null, // inherit from global by default
    },
  };
}

function legacyResolved(home: string): ResolvedProject {
  // Sentinel project for content that pre-dates the hybrid split. project_id
  // is a stable literal so re-running the migration always lands content in
  // the same place.
  return {
    project_id: "__legacy__",
    project_root: home,
    display_name: "legacy",
    source: "fallback",
  };
}

export interface MigrateOptions {
  home: string;
  cwd?: string;
  now?: Date;
  /**
   * Test seam — when true, all v2 content lands under the `__legacy__`
   * sentinel project regardless of cwd. Lets tests skip the
   * resolveProjectRoot side effect.
   */
  forceLegacy?: boolean;
}

export async function migrateV2toV3(
  opts: MigrateOptions,
): Promise<MigrateResult> {
  const { home } = opts;
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? new Date();

  const v2 = await readMaybeV2(v2Path(home));
  if (v2 === null) {
    return { migrated: false, reason: "no_v2_file" };
  }

  // Idempotency guard. coreMemorySchema accepts only schemaVersion 2, so
  // anything that parsed as `v2` literally has schemaVersion 2 — we're good
  // to proceed.

  // Step 1: backup.
  await mkdir(join(home, BACKUPS_DIR), { recursive: true });
  const backupPath = join(
    home,
    BACKUPS_DIR,
    `memory.v2.${now.toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await copyFile(v2Path(home), backupPath);

  // Step 2: resolve project.
  let resolved: ResolvedProject;
  let legacyUsed = false;
  if (opts.forceLegacy) {
    resolved = legacyResolved(home);
    legacyUsed = true;
  } else {
    const r = resolveProjectRoot(cwd);
    if (r.source === "fallback") {
      // cwd at migration time wasn't a real project (e.g., ran from $HOME).
      // Don't attribute facts to an arbitrary directory.
      resolved = legacyResolved(home);
      legacyUsed = true;
    } else {
      resolved = r;
    }
  }

  // Step 3: build + write global.
  await writeGlobal(home, buildGlobalFromV2(v2, now));

  // Step 4: build + write per-project memory.
  await writeProject(home, resolved.project_id, buildProjectFromV2(v2, resolved));

  // Step 5: rename legacy v2 file out of the way. Commit point: after this
  // the live read path sees only v3 files.
  await rename(v2Path(home), join(home, V2_LEGACY_RENAME));

  return {
    migrated: true,
    project_id: resolved.project_id,
    legacy_used: legacyUsed,
    backup_path: backupPath,
  };
}

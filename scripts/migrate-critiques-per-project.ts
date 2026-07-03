#!/usr/bin/env bun
/**
 * One-shot migration: split ~/.siltpoke/critiques/* into per-project
 * {cwd}/.siltpoke/critiques/*.
 *
 * Each row of the old ~/.siltpoke/critiques/history.jsonl carries a `cwd`
 * field pointing at the project that produced it. We use that to:
 *   1) rewrite the row's `path` to its new per-project location,
 *   2) copy the .md file from the old archive to the new archive,
 *   3) append the row to {cwd}/.siltpoke/critiques/history.jsonl.
 *
 * memory.json is NOT auto-migrated — a global learned rule has no
 * project to land in. The user can manually copy rules into a specific
 * project's {cwd}/.siltpoke/memory.json if they want to keep them.
 *
 * Run: `bun scripts/migrate-critiques-per-project.ts [--dry-run]`
 *
 * The old global directory is left in place as a backup. Re-running the
 * script is safe — rows that already exist in the per-project history
 * are detected by critique_id and skipped.
 */
import { readFile, appendFile, mkdir, copyFile, } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";

interface HistoryRow {
  timestamp?: string;
  critique_id?: string;
  session_id?: string;
  cwd?: string;
  mood?: string;
  severity?: string;
  confidence?: string;
  bubble_short?: string;
  path?: string;
}

interface MigrationSummary {
  rows_read: number;
  rows_migrated: number;
  rows_skipped_no_cwd: number;
  rows_skipped_no_path: number;
  rows_skipped_already_present: number;
  rows_failed: number;
  projects_touched: Set<string>;
}

function parseRow(line: string): HistoryRow | null {
  try {
    return JSON.parse(line) as HistoryRow;
  } catch {
    return null;
  }
}

async function readExistingIds(perProjectHistoryPath: string): Promise<Set<string>> {
  const seen = new Set<string>();
  if (!existsSync(perProjectHistoryPath)) return seen;
  try {
    const raw = await readFile(perProjectHistoryPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const row = parseRow(line);
      if (row?.critique_id) seen.add(row.critique_id);
    }
  } catch {
    // best-effort
  }
  return seen;
}

async function migrateOne(
  row: HistoryRow,
  _oldCritiquesRoot: string,
  dryRun: boolean,
  summary: MigrationSummary,
  perProjectIds: Map<string, Set<string>>,
): Promise<void> {
  if (!row.cwd) {
    summary.rows_skipped_no_cwd += 1;
    return;
  }
  if (!row.path || !row.critique_id) {
    summary.rows_skipped_no_path += 1;
    return;
  }

  const projectCritiquesRoot = join(row.cwd, ".siltpoke", "critiques");
  const perProjectHistory = join(projectCritiquesRoot, "history.jsonl");

  let existingIds = perProjectIds.get(perProjectHistory);
  if (!existingIds) {
    existingIds = await readExistingIds(perProjectHistory);
    perProjectIds.set(perProjectHistory, existingIds);
  }
  if (existingIds.has(row.critique_id)) {
    summary.rows_skipped_already_present += 1;
    return;
  }

  const oldMdPath = row.path;
  const dateSegment = basename(
    oldMdPath.replace(`/${basename(oldMdPath)}`, ""),
  );
  const newArchiveDir = join(projectCritiquesRoot, "archive", dateSegment);
  const newMdPath = join(newArchiveDir, `${row.critique_id}.md`);

  const rewrittenRow: HistoryRow = { ...row, path: newMdPath };
  const newHistoryLine = `${JSON.stringify(rewrittenRow)}\n`;

  if (dryRun) {
    summary.rows_migrated += 1;
    summary.projects_touched.add(row.cwd);
    return;
  }

  try {
    await mkdir(newArchiveDir, { recursive: true });
    if (existsSync(oldMdPath)) {
      await copyFile(oldMdPath, newMdPath);
    }
    await appendFile(perProjectHistory, newHistoryLine);
    existingIds.add(row.critique_id);
    summary.rows_migrated += 1;
    summary.projects_touched.add(row.cwd);
  } catch (err) {
    summary.rows_failed += 1;
    process.stderr.write(
      `  ! failed to migrate ${row.critique_id} (${row.cwd}): ${err}\n`,
    );
  }
}

async function maybeMigrateLatest(
  cwd: string,
  oldCritiquesRoot: string,
  dryRun: boolean,
): Promise<void> {
  const oldLatest = join(oldCritiquesRoot, "latest.md");
  if (!existsSync(oldLatest)) return;
  let body = "";
  try {
    body = await readFile(oldLatest, "utf8");
  } catch {
    return;
  }
  // Only migrate to a project if the latest critique's cwd matches.
  const cwdMatch = body.match(/^cwd:\s*(.+)$/m);
  if (!cwdMatch || cwdMatch[1]?.trim() !== cwd) return;
  if (dryRun) return;
  const target = join(cwd, ".siltpoke", "critiques", "latest.md");
  try {
    await mkdir(join(cwd, ".siltpoke", "critiques"), { recursive: true });
    await copyFile(oldLatest, target);
  } catch {
    // non-fatal
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const home = process.env.HOME;
  if (!home) {
    process.stderr.write("HOME env not set — cannot locate ~/.siltpoke/\n");
    process.exit(1);
  }
  const oldRoot = join(home, ".siltpoke", "critiques");
  const oldHistory = join(oldRoot, "history.jsonl");
  if (!existsSync(oldHistory)) {
    process.stdout.write(
      "No ~/.siltpoke/critiques/history.jsonl found — nothing to migrate.\n",
    );
    return;
  }

  let raw: string;
  try {
    raw = await readFile(oldHistory, "utf8");
  } catch (err) {
    process.stderr.write(`failed to read ${oldHistory}: ${err}\n`);
    process.exit(1);
  }

  const summary: MigrationSummary = {
    rows_read: 0,
    rows_migrated: 0,
    rows_skipped_no_cwd: 0,
    rows_skipped_no_path: 0,
    rows_skipped_already_present: 0,
    rows_failed: 0,
    projects_touched: new Set<string>(),
  };
  const perProjectIds = new Map<string, Set<string>>();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    summary.rows_read += 1;
    const row = parseRow(line);
    if (!row) continue;
    await migrateOne(row, oldRoot, dryRun, summary, perProjectIds);
  }

  for (const cwd of summary.projects_touched) {
    await maybeMigrateLatest(cwd, oldRoot, dryRun);
  }

  const verb = dryRun ? "would migrate" : "migrated";
  process.stdout.write(
    [
      `Siltpoke per-project migration — ${dryRun ? "DRY RUN" : "applied"}`,
      `  rows read:                     ${summary.rows_read}`,
      `  ${verb}:                  ${summary.rows_migrated}`,
      `  skipped (no cwd):              ${summary.rows_skipped_no_cwd}`,
      `  skipped (no path):             ${summary.rows_skipped_no_path}`,
      `  skipped (already per-project): ${summary.rows_skipped_already_present}`,
      `  failed:                        ${summary.rows_failed}`,
      `  projects touched:              ${summary.projects_touched.size}`,
      "",
      `Old global directory at ${oldRoot} left in place as a backup.`,
      `Delete it manually after verifying the per-project data looks right.`,
      "",
    ].join("\n"),
  );

  if (existsSync(join(home, ".siltpoke", "memory.json"))) {
    process.stdout.write(
      [
        "Note: ~/.siltpoke/memory.json (tier-1 learned rules) was NOT migrated.",
        "Global rules don't belong to any single project. If you want to keep",
        "them, copy specific rules into the relevant {project}/.siltpoke/memory.json.",
        "",
      ].join("\n"),
    );
  }
}

if (import.meta.main) {
  await main();
}

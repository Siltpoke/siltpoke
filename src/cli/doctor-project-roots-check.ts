// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Every registered project's `project_root` still exists on disk.
 *
 * `project_root` is an absolute path recorded when the project was first seen,
 * and nothing updates it when the directory is moved or renamed. Every surface
 * that resolves a project filters on `existsSync(project_root)`
 * (`resolveDaemonProject`, `listSwitchableRepos`), so a stale root removes the
 * project from the dashboard, the repo switcher and /knowledge -- while all
 * Three still answer 200. Measured 2026-08-13, right after a bulk move of the
 * Parent directory holding every checkout: nine of ten registered projects had
 * Dead roots and not one surface said so. The diagnosis took reading source and recomputing
 * sha256 by hand, which is not a path a user can walk.
 *
 * The detail deliberately does NOT name a remedy command. `siltpoke relocate`
 * exists (`src/cli/relocate.ts`) but is not registered in the dispatcher and is
 * not built into `dist/`, so naming it would point the reader at a subcommand
 * that answers "unknown subcommand" -- the same shape as the Stop-hook remedy
 * that pointed at a function no code path could reach. Add the mention in the
 * same change that wires the subcommand up, not before.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { siltpokeRoot } from "../installer/paths";
import type { CheckResult, DoctorOptions } from "./doctor";

/** Why one registered project could not be confirmed healthy. */
interface BrokenProject {
  label: string;
  /** `dead-root` is the case this check was built for; the rest are "could not tell". */
  reason: "dead-root" | "unreadable" | "no-root-field";
  detail: string;
}

function describe(b: BrokenProject): string {
  return b.reason === "dead-root" ? `${b.label} → ${b.detail}` : `${b.label} — ${b.detail}`;
}

/**
 * Read one project's store. Returns `null` for "this directory entry is not a
 * project" (no `memory.json`, or the entry is a plain file), and throws for
 * every other failure so the caller reports it instead of skipping it.
 *
 * Deliberately NOT gated on `existsSync(memoryPath)`: `existsSync` returns
 * false for a permission error exactly as it does for a missing file, so a
 * store the doctor is not allowed to read would drop out of the count
 * entirely -- silently understating how much of the install is broken, which
 * is the failure this check exists to prevent.
 */
function readStore(memoryPath: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(memoryPath, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // ENOENT: no store here. ENOTDIR: the entry is a plain file, not a project
    // directory. Neither is a broken project.
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("memory.json root is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function checkProjectRoots(opts: DoctorOptions = {}): CheckResult {
  const name = "registered project roots still exist";
  const projectsDir = join(opts.siltpokeHome ?? siltpokeRoot(), "projects");
  if (!existsSync(projectsDir)) {
    return { name, pass: true, detail: null };
  }

  let entries: string[];
  try {
    // Names only, NOT `withFileTypes` + `isDirectory()`. `Dirent.isDirectory()`
    // reflects lstat and is false for a symlink to a directory, so filtering on
    // it would drop a symlinked project store without reading it and still
    // report pass -- the check going blind in exactly the way it was built to
    // catch elsewhere. Whether the entry is usable is decided by reading it.
    entries = readdirSync(projectsDir);
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${projectsDir}: ${e instanceof Error ? e.message : String(e)}` };
  }

  const broken: BrokenProject[] = [];
  let total = 0;
  for (const id of entries) {
    let store: Record<string, unknown> | null;
    try {
      store = readStore(join(projectsDir, id, "memory.json"));
    } catch (e) {
      total += 1;
      broken.push({ label: id, reason: "unreadable", detail: `unreadable memory.json (${e instanceof Error ? e.message : String(e)})` });
      continue;
    }
    if (store === null) continue;
    total += 1;

    const root = store.project_root;
    if (typeof root !== "string" || root.length === 0) {
      broken.push({ label: id, reason: "no-root-field", detail: "memory.json has no project_root" });
      continue;
    }
    if (!existsSync(root)) {
      const display = store.display_name;
      broken.push({
        label: typeof display === "string" && display.length > 0 ? display : id,
        reason: "dead-root",
        detail: root,
      });
    }
  }

  if (broken.length === 0) {
    return { name, pass: true, detail: null };
  }

  // The count leads: a bare list does not convey that an install is almost
  // entirely dead, which "9 of 10" does at a glance. The verb stays neutral
  // ("could not be confirmed") because `broken` mixes dead roots with stores
  // that could not be read at all -- claiming every row is a moved directory
  // would be wrong for the latter.
  const deadRoots = broken.filter((b) => b.reason === "dead-root").length;
  const headline =
    deadRoots === broken.length
      ? `${broken.length} of ${total} registered projects point at a path that no longer exists;`
      : `${broken.length} of ${total} registered projects could not be confirmed (${deadRoots} point at a path that no longer exists);`;

  return {
    name,
    pass: false,
    detail: [
      headline,
      "they are invisible to the dashboard, the repo switcher and /knowledge:",
      ...broken.map((b) => `  - ${describe(b)}`),
    ].join("\n       "),
  };
}

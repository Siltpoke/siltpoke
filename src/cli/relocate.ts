// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * siltpoke relocate <new-root> — update the current project's
 * `project_root` (and any opt-in marker.json) to point at a new path.
 * `project_id` stays stable so the per-project memory file in
 * `~/.siltpoke/projects/<id>/memory.json` is unchanged — just its
 * recorded path moves.
 *
 * Usage:
 *   siltpoke relocate /new/absolute/path
 *   siltpoke relocate --from /old/abs/path /new/absolute/path
 *
 * Without --from: looks up the project from the current cwd (marker or git
 * root). Use this when a `.siltpoke/marker.json` is present OR git keeps
 * the same root — i.e. the project_id resolves to the same value before
 * and after the rename.
 *
 * With --from <old-abs-path>: recomputes the project_id from the original
 * absolute path. Use this when the repo was renamed/moved and there is NO
 * marker file — git-root-based ids are derived from path, so without
 * --from there is no way to recover the original id.
 *
 * Exit codes:
 *   0  relocated successfully
 *   1  read/write error or no per-project memory found
 *   3  CLI flag error (missing new-root, malformed --from)
 */
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, isAbsolute, resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import {
  resolveProjectRoot,
  readProject,
  writeProject,
} from "../memory/project";
import { markerSchema } from "../memory/schema-v3";

function hashId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export interface RelocateOptions {
  argv: string[];
  cwd?: string;
  homeBase?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  now?: () => Date;
}

const HOME_DEFAULT = ".siltpoke";

function siltpokeHome(): string {
  return join(process.env.HOME ?? "", HOME_DEFAULT);
}

export async function runRelocate(opts: RelocateOptions): Promise<number> {
  const out = opts.out ?? ((s) => process.stdout.write(s));
  const err = opts.err ?? ((s) => process.stderr.write(s));
  const cwd = opts.cwd ?? process.cwd();
  const homeBase = opts.homeBase ?? siltpokeHome();
  const now = (opts.now ?? (() => new Date()))();

  let fromOldPath: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < opts.argv.length; i++) {
    const a = opts.argv[i]!;
    if (a === "--from") {
      const v = opts.argv[++i];
      if (!v) {
        err("siltpoke relocate: --from requires an old absolute path\n");
        return 3;
      }
      fromOldPath = v;
      continue;
    }
    positional.push(a);
  }

  if (positional.length === 0) {
    err("siltpoke relocate: missing <new-root> argument\n");
    return 3;
  }
  const candidate = positional[0]!;
  const newRoot = isAbsolute(candidate) ? candidate : resolvePath(cwd, candidate);

  if (!existsSync(newRoot)) {
    err(`siltpoke relocate: path does not exist: ${newRoot}\n`);
    return 1;
  }

  const resolved = resolveProjectRoot(cwd);
  const projectId = fromOldPath ? hashId(fromOldPath) : resolved.project_id;
  const project = await readProject(homeBase, projectId);
  if (!project) {
    err(
      `siltpoke relocate: no per-project memory found for project_id ${projectId}${fromOldPath ? "" : " (try --from <old-path> if the project was renamed without a marker)"}\n`,
    );
    return 1;
  }

  const updated = {
    ...project,
    project_root: newRoot,
  };
  await writeProject(homeBase, projectId, updated);

  // If a marker exists in the current resolution, also update its
  // project_root + written_at. We do NOT create a new marker if the user
  // never opted in.
  if (resolved.source === "marker") {
    const markerDir = join(resolved.project_root, ".siltpoke");
    const markerPath = join(markerDir, "marker.json");
    const newMarker = markerSchema.parse({
      project_id: projectId,
      project_root: newRoot,
      display_name: resolved.display_name,
      written_by: "siltpoke",
      written_at: now.toISOString(),
    });
    try {
      await writeFile(markerPath, JSON.stringify(newMarker, null, 2), "utf8");
    } catch (e) {
      err(
        `siltpoke relocate: marker.json write failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 1;
    }
  }

  const oldRoot = project.project_root;
  out(`relocated ${projectId}: ${oldRoot} -> ${newRoot}\n`);
  return 0;
}

if (import.meta.main) {
  const code = await runRelocate({ argv: process.argv.slice(2) });
  process.exit(code);
}

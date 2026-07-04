// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * siltpoke where — print the resolved project identity for the current
 * working directory.
 *
 * Output (JSON to stdout, single line):
 *   { project_id, project_root, display_name, source: "marker"|"git"|"fallback" }
 *
 * Exit 0 always (no failure mode — fallback is a legitimate result).
 */
import { resolveProjectRoot } from "../memory/project";

export interface WhereOptions {
  cwd?: string;
  out?: (s: string) => void;
}

export function runWhere(opts: WhereOptions = {}): number {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const resolved = resolveProjectRoot(cwd);
  out(`${JSON.stringify(resolved)}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(runWhere());
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findCritiqueByIdOrLatest } from "../state/critique-status";
import { absentCritiqueMessage } from "./critique-absent";
import { parseFrontmatter, renderFreshness } from "./critique-freshness";

export interface GetCritiqueOptions {
  basePath: string;
  idOrLatest: string;
  /** Repo the reader is standing in; the freshness banner compares against it. */
  cwd?: string;
  /** @internal test seams. */
  now?: Date;
  gitFn?: (args: string[], cwd: string) => string | null;
}

export async function getCritique(
  opts: GetCritiqueOptions,
): Promise<string> {
  const path = await findCritiqueByIdOrLatest(opts.basePath, opts.idOrLatest);
  if (!path) {
    return absentCritiqueMessage(opts.basePath, opts.idOrLatest);
  }
  try {
    const md = await readFile(path, "utf8");
    // Prepended at READ time, never stored: a banner baked in when the review
    // was written is stale the moment anything changes. See
    // ./critique-freshness for why a bare timestamp is not enough.
    const fm = parseFrontmatter(md);
    const banner = renderFreshness({
      ...fm,
      cwd: opts.cwd ?? process.cwd(),
      now: opts.now ?? new Date(),
      ...(opts.gitFn ? { gitFn: opts.gitFn } : {}),
    });
    return banner + md;
  } catch (err) {
    return `# Siltpoke: failed to read review at ${path}: ${err}\n`;
  }
}

if (import.meta.main) {
  const idOrLatest = process.argv[2] ?? "latest";
  // Critiques are per-project — read from {cwd}/.siltpoke/.
  const basePath = join(process.cwd(), ".siltpoke");
  const out = await getCritique({ basePath, idOrLatest, cwd: process.cwd() });
  process.stdout.write(out);
  process.exit(0);
}

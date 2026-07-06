// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findCritiqueByIdOrLatest } from "../state/critique-status";

export interface GetCritiqueOptions {
  basePath: string;
  idOrLatest: string;
}

export async function getCritique(
  opts: GetCritiqueOptions,
): Promise<string> {
  const path = await findCritiqueByIdOrLatest(opts.basePath, opts.idOrLatest);
  if (!path) {
    return `# Siltpoke: review '${opts.idOrLatest}' not found.\n`;
  }
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    return `# Siltpoke: failed to read review at ${path}: ${err}\n`;
  }
}

if (import.meta.main) {
  const idOrLatest = process.argv[2] ?? "latest";
  // Critiques are per-project — read from {cwd}/.siltpoke/.
  const basePath = join(process.cwd(), ".siltpoke");
  const out = await getCritique({ basePath, idOrLatest });
  process.stdout.write(out);
  process.exit(0);
}

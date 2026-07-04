// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { rename } from "node:fs/promises";

/**
 * Move a corrupt/unparseable file aside instead of silently overwriting it.
 * Returns the quarantine path. Caller decides whether to bootstrap a fresh
 * file or surface a hard error.
 */
export async function quarantineCorrupt(path: string): Promise<string> {
  const corruptPath = `${path}.corrupt-${Date.now()}`;
  await rename(path, corruptPath).catch(() => {});
  process.stderr.write(
    `[siltpoke] ${path} was unparseable; moved to ${corruptPath}\n`,
  );
  return corruptPath;
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @module project-pin — the daemon's server-side "last viewed" project pin.
 * A single JSON at ~/.siltpoke/active-project.json. Cwd-independent, shared
 * across browser tabs (single-user loopback daemon). Never throws on read.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidProjHash } from "../repo-graph/repo-registry";
import { atomicWrite } from "../utils/atomic-write";

interface ProjectPinFile {
  pinned_proj_hash?: unknown;
}

function pinPath(home: string): string {
  return join(home, "active-project.json");
}

export async function readProjectPin(home: string): Promise<string | null> {
  try {
    const raw = await readFile(pinPath(home), "utf8");
    const parsed = JSON.parse(raw) as ProjectPinFile;
    const hash = parsed?.pinned_proj_hash;
    return typeof hash === "string" && isValidProjHash(hash) ? hash : null;
  } catch {
    return null;
  }
}

export async function writeProjectPin(
  home: string,
  projHash: string,
): Promise<void> {
  if (!isValidProjHash(projHash)) return;
  atomicWrite(pinPath(home), JSON.stringify({ pinned_proj_hash: projHash }));
}

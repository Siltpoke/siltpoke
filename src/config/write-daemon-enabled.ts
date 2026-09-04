// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";

/**
 * Set `daemon.enabled` in `<home>/config.json`, preserving every other
 * section. Used when the user opts into a daemon-backed surface (opening the
 * dashboard) so the on-stop respawn gate then keeps the daemon alive.
 *
 * `atomicWrite` is synchronous (writeFileSync + renameSync) — this function
 * stays `async` to mirror `loadDaemonConfig`'s signature and because the
 * config read below is async (`readFile`).
 */
export async function setDaemonEnabled(home: string, enabled: boolean): Promise<void> {
  const configPath = join(home, "config.json");
  let obj: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      obj = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    } catch {
      obj = {};
    }
  }
  const daemon = { ...(obj.daemon as object | undefined), enabled };
  atomicWrite(configPath, `${JSON.stringify({ ...obj, daemon }, null, 2)}\n`);
}

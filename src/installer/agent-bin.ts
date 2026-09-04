// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { spawnSync } from "node:child_process";
import { existsSync as realExistsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type WhichFn = (bin: string) => string | null;

function defaultWhich(bin: string): string | null {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(finder, [bin], { encoding: "utf8" });
    const out = (r.stdout || "").split("\n")[0]?.trim() ?? "";
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a freshly-installed agent binary to an ABSOLUTE path so the caller
 * does not depend on the process's snapshotted $PATH (which a mid-run install
 * cannot update). Order: which/where hit first, then the dirs installers drop
 * binaries into, then a bare-name degrade (preserves the old best-effort).
 */
export function resolveAgentBinary(
  name: string,
  deps: { which?: WhichFn; home?: string; existsSync?: (p: string) => boolean } = {},
): string {
  const which = deps.which ?? defaultWhich;
  const home = deps.home ?? homedir();
  const existsSync = deps.existsSync ?? realExistsSync;

  const hit = which(name);
  if (hit) return hit;

  const candidates = [
    join(home, ".local", "bin", name), // claude.ai/install.sh target
    join(home, ".bun", "bin", name),
    join(home, ".npm-global", "bin", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return name;
}

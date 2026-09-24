// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/**
 * The version of siltpoke that is actually running.
 *
 * Found by WALKING UP from a starting directory until a
 * `.claude-plugin/plugin.json` appears, rather than by counting `..` segments.
 * That is deliberate: this module is read from at least three different depths —
 * `src/…` in a source run, `dist/` in a plugin install, and
 * `.antigravity-plugin/dist/` in an agy install — and relative-path arithmetic
 * across those layouts is this repo's most repeated defect. A search has no
 * depth to get wrong.
 *
 * `.claude-plugin/plugin.json` is the anchor rather than `package.json` because
 * every host's install ships it and it is the file the plugin loader itself
 * reads. `package.json` is the fallback for a bare source checkout.
 *
 * Returns null when nothing is found or the file is unreadable/malformed —
 * callers must treat "unknown version" as "say nothing", never as "0.0.0".
 */
export function findInstalledVersion(startDir: string): string | null {
  let dir = startDir;
  const root = parse(dir).root;
  for (;;) {
    for (const rel of [join(".claude-plugin", "plugin.json"), "package.json"]) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) {
        const v = readVersionField(candidate);
        if (v) return v;
      }
    }
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readVersionField(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Compare two plain SemVer strings. Returns true when `candidate` is strictly
 * newer than `current`.
 *
 * Pre-releases are treated as OLDER than the release they precede, and a
 * pre-release NEVER counts as newer than a plain version with the same numbers
 * — the opposite of what `sort -V` does, which cost the v1.2.0 release its
 * "Latest" badge logic a first draft (see .github/workflows/release.yml).
 * Anything unparseable returns false: an update notice is not worth guessing at.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  }
  // Same numbers: a release beats a pre-release; two pre-releases never
  // trigger a notice (we do not rank rc1 against rc2 — nobody is served by it).
  return !a.pre && !!b.pre;
}

function parseSemver(v: string): { nums: [number, number, number]; pre: string | null } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ?? null,
  };
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Shared source-file classifier for the disk-awareness slice.
 *
 * `isSource` decides whether a changed-file path is worth treating as "real
 * source" for reverse-deps (Task 2) and test-gap (Task 4) purposes: not a
 * test file itself, not generated/build output, not an empty/deleted-marker
 * path. Path-shape only — no disk access — so it stays fast and pure and
 * matches the same fail-soft posture as the rest of this feature dir. A
 * caller that needs a real disk-existence check (e.g. confirming a "deleted"
 * path no longer resolves) must do that separately; this module only
 * classifies the path string.
 */
import { canonicalPath } from "./path";

// Mirrors importers.ts's own TEST_GLOB — kept as a separate literal here
// (not imported) so this module has zero dependency on importers.ts and can
// be reused standalone by Task 4 without pulling in the ripgrep substrate.
const TEST_GLOB = /(\.test\.|\.spec\.|(^|\/)tests?\/|(^|\/)__tests__\/)/i;
const GENERATED_DIR = /(^|\/)(node_modules|dist|build|\.next|coverage|generated|\.turbo|\.vercel)\//i;
const GENERATED_FILE = /\.generated\.[a-z]+$|\.d\.ts$/i;

/**
 * True when `path` should be treated as real, reviewable source: not a test
 * file, not generated/build output, not empty (the closest pure-path signal
 * for a "deleted" entry, which upstream diff processing represents as an
 * empty/blank path rather than a status flag on the string itself).
 */
export function isSource(path: string): boolean {
  const trimmed = path.trim();
  if (trimmed.length === 0) return false;
  const canon = canonicalPath(trimmed);
  if (TEST_GLOB.test(canon)) return false;
  if (GENERATED_DIR.test(canon)) return false;
  if (GENERATED_FILE.test(canon)) return false;
  return true;
}

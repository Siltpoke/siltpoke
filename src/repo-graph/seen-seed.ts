// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Seed `seen.json` at index time (slice ③, spec §4, C2 from the plan's
 * cross-family review). Split out of `builder.ts` to keep that file under
 * the LOC ratchet — this module owns the seed decision + its best-effort
 * git HEAD capture, `runIndexBuild` just calls `seedSeenWatermark` once
 * per successful build.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnWithTimeout } from "../critic/spawn";
import { emptySeen, readFingerprints, writeSeen } from "./store";
import type { SeenWatermark } from "./types";

const SEEN_FILE = "seen.json";
const GIT_REV_PARSE_TIMEOUT_MS = 5_000;

/** Shape of `writeSeen` — overridable in tests to inject a failing write. */
export type WriteSeenFn = typeof writeSeen;

/**
 * Best-effort `git rev-parse HEAD` in `project_root`. Returns null (never
 * throws) when the dir isn't a git repo, git isn't installed, or the call
 * times out — the seed must never fail an index build over an optional
 * provenance field.
 *
 * Exported (fix round 1, reviewer 2026-07-27) so `markAllSeen`
 * (`seen-advance.ts`) can reuse it to re-stamp `baseline_sha` on a full
 * re-baseline, rather than duplicating this best-effort git-capture logic.
 */
export async function captureGitHeadSha(project_root: string): Promise<string | null> {
  try {
    const result = await spawnWithTimeout({
      argv: ["git", "-C", project_root, "rev-parse", "HEAD"],
      cwd: project_root,
      timeoutMs: GIT_REV_PARSE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 || result.timedOut) return null;
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Seed `seen.json` after a successful index build. Called from
 * `runIndexBuild` AFTER `buildInner` has returned (i.e. fingerprints are
 * durably written).
 *
 * Rules (never read-modify-write an EXISTING seen.json, incl. `--force`):
 *   - `seen.json` already exists → do nothing.
 *   - `seen.json` absent AND `hadPriorIndexBeforeBuild` is false (fresh
 *     index) → seed `files` = the fingerprints this build just wrote
 *     (nothing is "unseen" yet), `unknown_baseline: false`, best-effort
 *     `baseline_sha`.
 *   - `seen.json` absent AND `hadPriorIndexBeforeBuild` is true (upgrade
 *     path — e.g. a slice-②-era index missing seen.json) → the baseline is
 *     genuinely unknown; seed `{ files: {}, unknown_baseline: true }`
 *     rather than fabricating a "seen = current" baseline for a repo the
 *     user may already know well (or not at all). Downstream callers treat
 *     `unknown_baseline` as "degrade conservatively", not "nothing seen".
 *
 * The write itself is wrapped in try/catch and NEVER propagates: this
 * function is called from inside `runIndexBuild`'s try block, whose catch
 * runs failure cleanup that, for a FRESH build, `rm -rf`s the storage dir
 * (see `cleanupFailedBuild`). A disk-full/permission/rename error on this
 * OPTIONAL watermark write must not be mistaken for "the index build
 * failed" and wipe an otherwise-complete, successful
 * graph.json/fingerprints.json/queryIndex.json/meta.json. Skipping the seed
 * on write failure is safe — the next index build retries it (still
 * `!existsSync(seen.json)`).
 *
 * `writeSeenFn` defaults to the real `writeSeen`; overridable so tests can
 * inject a failing write without touching disk permissions.
 */
export async function seedSeenWatermark(
  storage_dir: string,
  project_root: string,
  hadPriorIndexBeforeBuild: boolean,
  writeSeenFn: WriteSeenFn = writeSeen,
): Promise<void> {
  if (existsSync(join(storage_dir, SEEN_FILE))) return;

  try {
    if (!hadPriorIndexBeforeBuild) {
      const fingerprints = await readFingerprints(storage_dir);
      const files: SeenWatermark["files"] = {};
      for (const [path, fp] of Object.entries(fingerprints.files)) {
        files[path] = { content_sha256: fp.content_sha256, ast_sig: fp.ast_sig };
      }
      const baseline_sha = await captureGitHeadSha(project_root);
      await writeSeenFn(storage_dir, { ...emptySeen(), files, unknown_baseline: false, baseline_sha });
      return;
    }

    await writeSeenFn(storage_dir, { ...emptySeen(), files: {}, unknown_baseline: true });
  } catch {
    // Best-effort — see doc comment above. Swallow: the seed is optional,
    // the index build it rode in on already succeeded.
  }
}

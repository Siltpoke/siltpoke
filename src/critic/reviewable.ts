// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Is a changed file something the AI reviewer must read?
 *
 * Gate spec 2026-08-20 §4.3 / D6. The test is "would a mistake in this file
 * change how the system behaves?" — not "is it source code". `deploy.sh`,
 * `Dockerfile` and `schema.sql` are not source by any `src/` convention and
 * still break things.
 *
 * Exclusion is by extension or file-name shape, NEVER by directory: a
 * `docs/` or `.claude/` rule would leave `docs/samples/auth.py` and
 * `.claude/hooks/stop.sh` unreviewed forever. The one directory rule is
 * `dist/`, which the spec names explicitly as generated output.
 *
 * A file nothing here recognises counts as reviewable: guessing low costs one
 * review call, guessing high costs a missed review.
 *
 * Not `tierOf` in `src/brain/hunk-selection.ts`: that one ORDERS hunks inside
 * a budget and demotes whole `docs/` and `.claude/` directories, which is fine
 * for ranking and wrong for deciding whether the reviewer looks at all.
 */

const DOC_EXT = new Set(["md", "mdx", "rst"]);

const ASSET_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "tiff",
  "pdf", "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "mov", "wav", "webm",
  "zip", "gz", "tgz", "tar", "jar",
]);

/** Data, logs and run output — an agent's test run produces these. */
const DATA_EXT = new Set(["csv", "tsv", "log", "txt"]);
/**
 * `.txt` files that DO change behaviour — dependency pins and build scripts.
 * The spec's test ("would a mistake here change behaviour?") outranks its
 * `.txt` row for these names.
 */
const BEHAVIOUR_TXT_RE = /^(requirements[\w.-]*\.txt|constraints[\w.-]*\.txt|cmakelists\.txt)$/;

const GENERATED_NAME_RE = /(-lock\.json|\.lock|\.min\.js|\.min\.css|\.map|\.snap|^pnpm-lock\.yaml|^go\.sum)$/;
/**
 * Directories whose content nobody writes by hand: build output and
 * third-party code. The spec names `dist/` only; the rest are shapes
 * `hunk-selection.ts` also demotes. `build/` and `out/` are deliberately NOT
 * here even though hunk-selection demotes them: Bazel, Make and Go repos keep
 * hand-written scripts under `build/` (`build/deploy.sh`), and the spec's rule
 * is that executable code is never excluded by directory.
 */
const GENERATED_DIR_RE = /(^|\/)(dist|coverage|node_modules|vendor|\.next|\.turbo)\//;
const AGENT_CONFIG_DIR_RE = /(^|\/)\.claude\//;
const AGENT_CONFIG_EXT = new Set(["md", "json"]);

function extOf(base: string): string {
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function isReviewable(path: string): boolean {
  // Lower-cased once: case-insensitive file systems make `DIST/` and
  // `APP.MIN.JS` the same files as `dist/` and `app.min.js`.
  const p = path.replace(/\\/g, "/").toLowerCase();
  const base = p.slice(p.lastIndexOf("/") + 1);
  const ext = extOf(base);

  if (GENERATED_NAME_RE.test(base) || GENERATED_DIR_RE.test(p)) return false;
  if (BEHAVIOUR_TXT_RE.test(base)) return true;
  if (DOC_EXT.has(ext) || ASSET_EXT.has(ext) || DATA_EXT.has(ext)) return false;
  if (base === ".env.example") return false;
  if (AGENT_CONFIG_DIR_RE.test(p) && AGENT_CONFIG_EXT.has(ext)) return false;
  return true;
}

export function anyReviewable(paths: readonly string[]): boolean {
  return paths.some(isReviewable);
}

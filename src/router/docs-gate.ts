// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The docs gate (spec D7 / AC7-AC9) — "was any of this a code change?"
 *
 * A turn that only touched prose has nothing for a code reviewer to say, and
 * reviewing it anyway spends a Brain call to produce a shrug. But the failure
 * directions here are NOT symmetric, and that asymmetry is what decides the
 * shape of this file:
 *
 * - calling a docs change "code" costs one wasted review, and the user sees it;
 * - calling a CODE change "docs" is a silent miss — the review never happens,
 *   nothing says so, and the anchor moves on.
 *
 * The second is the exact silent-liar shape this whole track exists to delete.
 *
 * ## Why this is not `SOURCE_EXT_TO_LANG`
 *
 * Spec D7 proposed `isCode(path)` = the walker's language table
 * (`src/repo-graph/walker.ts:18`) OR a `prompts/` path OR `*.prompt.md`. The
 * plan flagged that table as UNVERIFIED for gating (R3) and required it be
 * enumerated before being relied on. Enumerating it settles the question against
 * it: the table is `ts | tsx | js | jsx | py` and nothing else, so in this repo
 * alone it calls "not code" 72 `.json` files (every plugin manifest,
 * `.claude/close-gate.json`), 21 `.sh` files (`scripts/close-gate.sh`), 10
 * `.yml`/`.yaml` (every GitHub workflow, `docs/tracks.yaml`), 3 `.css`, 2
 * `.toml`, `.dependency-cruiser.cjs`, and `Makefile`. A turn that edits only
 * `.github/workflows/ci.yml` is a real change to how this project gates itself,
 * and under the literal D7 rule it would be filed as docs and skipped in
 * silence.
 *
 * That table is right for what it does — it feeds a tree-sitter parser, so it
 * lists exactly the languages there is a parser for. It is the wrong shape for
 * a gate.
 *
 * So the rule is inverted, gate-locally, per the story's contingency (extend a
 * gate-local list; do NOT edit the walker's table): **docs is the closed set,
 * and code is the default.** The set of things that are prose is small and
 * stable; the set of things that are code is open-ended. An unrecognised
 * extension resolves to code, which fails toward a wasted review rather than a
 * silent skip.
 *
 * Pure functions — no IO, no side effects.
 */

/**
 * Extensions whose changes a code reviewer has nothing to say about.
 * Lowercased, no leading dot. Deliberately SHORT: every addition here creates a
 * new way for a real change to be skipped silently, so a new entry needs a
 * reason, not a hunch.
 */
const PROSE_EXT = new Set<string>([
  "md",
  "mdx",
  "markdown",
  "rst",
  "adoc",
  "asciidoc",
  "org",
  "txt",
]);

/**
 * Binary assets. Same "nothing to review" logic as prose, but kept separate
 * because the reasons differ — these are not read, they are shipped.
 *
 * `.wasm` was in this set and has been taken OUT. It is the one extension here
 * that is EXECUTED rather than displayed, and this repo tracks four of them
 * (`dist/wasm/tree-sitter-*.wasm`, `web-tree-sitter.wasm`). A turn whose only
 * edit swapped one of those binaries — a version bump, or a substituted
 * binary — would have been filed `docs_only` and skipped in silence, with the
 * ledger naming the exact file nobody looked at. That is the failure this whole
 * file exists to prevent, sitting inside the file itself. A `.wasm` change may
 * be un-reviewable in practice (nobody reads a binary diff), but "the reviewer
 * had nothing useful to say" is a visible outcome and "the turn was never
 * looked at" is not.
 */
const ASSET_EXT = new Set<string>([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "svg",
  "webp",
  "pdf",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "mov",
  "webm",
]);

/**
 * Extension-less files that are prose. Everything else without an extension
 * (`Makefile`, `Dockerfile`, `Procfile`, `CODEOWNERS`) is code, which is why
 * this list is named for what it holds rather than being a general fallback.
 */
const PROSE_BASENAMES = new Set<string>([
  "LICENSE",
  "LICENCE",
  "NOTICE",
  "AUTHORS",
  "CONTRIBUTORS",
  "COPYING",
]);

/** Lowercased extension with no dot, or `""` when the basename carries none. */
function extensionOf(basename: string): string {
  const dot = basename.lastIndexOf(".");
  // `<= 0` and not `=== -1`: a dotfile like `.gitignore` has its only dot at
  // index 0, and "gitignore" is not an extension — treating it as one would
  // make every dotfile's name its own type.
  if (dot <= 0) return "";
  return basename.slice(dot + 1).toLowerCase();
}

/**
 * Does this path count as code for the purpose of deciding whether to review?
 *
 * AC8 — a prompt is code, even when it is a `.md`. Both forms the spec names
 * are honoured: a file under a `prompts/` directory at any depth, and a
 * `*.prompt.md` basename anywhere.
 */
export function isCode(path: string): boolean {
  // Normalise separators so a Windows-style path is not silently a different
  // string than the same POSIX one. Nothing downstream depends on the result
  // being a usable path — only on the segments.
  const segments = path.split(/[\\/]+/).filter((s) => s.length > 0);
  const basename = segments[segments.length - 1] ?? "";
  if (basename === "") return false;

  // AC8, both spellings. Checked BEFORE the prose set, because the whole point
  // is that a `.md` here is code.
  if (segments.slice(0, -1).some((s) => s.toLowerCase() === "prompts")) return true;
  if (basename.toLowerCase().endsWith(".prompt.md")) return true;

  if (PROSE_BASENAMES.has(basename.toUpperCase())) return false;

  const ext = extensionOf(basename);
  if (ext === "") return true;
  return !PROSE_EXT.has(ext) && !ASSET_EXT.has(ext);
}

/**
 * The gate's question in one call: of the files this turn touched, is any of
 * them code?
 *
 * An EMPTY list answers `false`, but callers must not report that as
 * `docs_only` — "the turn touched nothing" and "the turn touched only prose"
 * are different facts and AC9 requires the log say which one decided.
 */
export function anyCodeChanged(changedFiles: readonly string[]): boolean {
  return changedFiles.some(isCode);
}

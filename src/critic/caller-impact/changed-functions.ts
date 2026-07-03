// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Changed-function extraction from a unified git diff.
 *
 * Given a unified diff plus a way to read each file's pre-image (git HEAD)
 * and post-image (working tree), return the functions the diff changed,
 * each classified `added` / `removed` / `modified`.
 *
 * Design (locked):
 *  1. Parse the diff into per-file added-new-line + removed-old-line sets.
 *  2. Re-extract function ranges from the pre/post images via the repo-graph
 *     extractor (no name/arrow/method logic reimplemented here).
 *  3. Classify by matching pre/post functions by name and intersecting their
 *     ranges with the touched line sets.
 *  4. A parse failure or function-less image contributes nothing for that
 *     side — never throw, never fall back to a whole-file dump.
 */
import { extractFile } from "../../repo-graph/extractor.ts";
import { parseSource, type SupportedLang } from "../rubric/tier2/ast-loader.ts";

export type ChangeKind = "added" | "removed" | "modified";

export interface ChangedFunction {
  name: string;
  kind: ChangeKind;
  /** New path for added/modified, old path for removed. */
  file: string;
  /** 1-based, inclusive. Post-image range (pre-image range for removed). */
  lineRange: { start: number; end: number };
}

export interface ImageReader {
  /** Pre-image (git HEAD) source, or null if the file is absent on that side. */
  pre: (path: string) => string | null;
  /** Post-image (working tree) source, or null if absent on that side. */
  post: (path: string) => string | null;
}

/** One file's touched-line sets, keyed by the side's line numbers. */
export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  /** New-side (post-image) line numbers that were added. */
  addedNewLines: Set<number>;
  /** Old-side (pre-image) line numbers that were removed. */
  removedOldLines: Set<number>;
}

const DEV_NULL = "/dev/null";

/** Strip a leading `a/` or `b/` git path prefix; pass `/dev/null` through. */
function stripPrefix(raw: string): string {
  if (raw === DEV_NULL) return raw;
  if (raw.startsWith("a/") || raw.startsWith("b/")) return raw.slice(2);
  return raw;
}

/** Parse the `@@ -oldStart,oldCount +newStart,newCount @@` hunk header. */
function parseHunkHeader(
  line: string,
): { oldStart: number; newStart: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

/** Mutable cursor threaded through the diff walk. */
interface DiffState {
  files: FileDiff[];
  current: FileDiff | null;
  oldLine: number;
  newLine: number;
}

/** Handle a `---`/`+++`/`@@` header line; returns true if it consumed one. */
function applyHeaderLine(line: string, st: DiffState): boolean {
  if (line.startsWith("diff --git ")) {
    st.current = null;
    return true;
  }
  if (line.startsWith("--- ")) {
    const path = stripPrefix(line.slice(4).trim());
    st.current = {
      oldPath: path === DEV_NULL ? null : path,
      newPath: null,
      addedNewLines: new Set<number>(),
      removedOldLines: new Set<number>(),
    };
    st.files.push(st.current);
    return true;
  }
  if (line.startsWith("+++ ")) {
    if (st.current) {
      const path = stripPrefix(line.slice(4).trim());
      st.current.newPath = path === DEV_NULL ? null : path;
    }
    return true;
  }
  if (line.startsWith("@@")) {
    const header = parseHunkHeader(line);
    if (header) {
      st.oldLine = header.oldStart;
      st.newLine = header.newStart;
    }
    return true;
  }
  return false;
}

/** Handle a hunk-body line, advancing counters + recording touched lines. */
function applyBodyLine(line: string, st: DiffState): void {
  const fd = st.current;
  if (!fd) return;
  if (line.startsWith("\\")) return; // "\ No newline at end of file"
  if (line.startsWith("+")) {
    fd.addedNewLines.add(st.newLine);
    st.newLine += 1;
    return;
  }
  if (line.startsWith("-")) {
    fd.removedOldLines.add(st.oldLine);
    st.oldLine += 1;
    return;
  }
  if (line.startsWith(" ")) {
    st.oldLine += 1;
    st.newLine += 1;
  }
  // Any other line (e.g. "index ...", empty trailing) is ignored.
}

/**
 * Parse a unified diff into per-file touched-line sets. Exposed for isolated
 * unit testing. Walks each hunk body: ` ` advances both counters, `+` records
 * the new-side line, `-` records the old-side line, `\ No newline...` is
 * ignored. `/dev/null` paths surface as that literal for pure add/delete.
 */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const st: DiffState = { files: [], current: null, oldLine: 0, newLine: 0 };
  for (const line of diff.split("\n")) {
    if (applyHeaderLine(line, st)) continue;
    applyBodyLine(line, st);
  }
  return st.files;
}

interface FnRange {
  name: string;
  start: number;
  end: number;
}

/** Extract function name + line range from a source image, or [] on failure. */
async function functionRanges(
  src: string | null,
  relPath: string,
  lang: SupportedLang,
): Promise<FnRange[]> {
  if (src === null) return [];
  const tree = await parseSource(src, lang);
  if (!tree) return [];
  const { nodes } = extractFile(tree, {
    relPath,
    lang,
    lineCount: src.split("\n").length,
  });
  const out: FnRange[] = [];
  for (const n of nodes) {
    if (n.type !== "function") continue;
    out.push({ name: n.name, start: n.lineRange[0], end: n.lineRange[1] });
  }
  return out;
}

/**
 * The innermost (smallest-span) function whose range contains `line`, or null.
 * Attributing a touched line to its innermost enclosing function — rather than
 * every enclosing function — is what stops an edit inside a nested helper from
 * also flagging the outer function as modified.
 */
function innermostContaining(ranges: FnRange[], line: number): FnRange | null {
  let best: FnRange | null = null;
  for (const r of ranges) {
    if (line < r.start || line > r.end) continue;
    if (best === null || r.end - r.start < best.end - best.start) best = r;
  }
  return best;
}

/** Group parsed file diffs so we resolve each touched file exactly once. */
function effectivePath(fd: FileDiff): string | null {
  return fd.newPath ?? fd.oldPath;
}

/**
 * The set of POST function instances that were genuinely edited. Each touched
 * line attributes to exactly one (innermost) function, keyed by range identity
 * so distinct same-named functions are tracked separately.
 */
function modifiedPostInstances(
  fd: FileDiff,
  preNames: Set<string>,
  preRanges: FnRange[],
  postNames: Set<string>,
  postRanges: FnRange[],
): Set<FnRange> {
  const modified = new Set<FnRange>();
  // Added lines land on the post image directly.
  for (const ln of fd.addedNewLines) {
    const fn = innermostContaining(postRanges, ln);
    if (fn && preNames.has(fn.name)) modified.add(fn); // name-new ⇒ `added`, not `modified`
  }
  // Removed lines land on the pre image; map back to the post instance by name.
  // Only when that name is unambiguous in the post image — with duplicate names
  // the pre→post instance correspondence is undecidable, so we lean on the
  // added-line path (which covers the common modify = delete+add case).
  for (const ln of fd.removedOldLines) {
    const fn = innermostContaining(preRanges, ln);
    if (!fn || !postNames.has(fn.name)) continue;
    const postWithName = postRanges.filter((r) => r.name === fn.name);
    if (postWithName.length === 1) modified.add(postWithName[0]);
  }
  return modified;
}

async function changedFunctionsForFile(
  fd: FileDiff,
  images: ImageReader,
  lang: SupportedLang,
): Promise<ChangedFunction[]> {
  const path = effectivePath(fd);
  if (path === null) return []; // pathless diff stanza — nothing to resolve

  const preRanges = await functionRanges(images.pre(fd.oldPath ?? path), path, lang);
  const postRanges = await functionRanges(images.post(fd.newPath ?? path), path, lang);
  const preNames = new Set(preRanges.map((r) => r.name));
  const postNames = new Set(postRanges.map((r) => r.name));
  const modified = modifiedPostInstances(fd, preNames, preRanges, postNames, postRanges);

  const out: ChangedFunction[] = [];
  // added / modified, in post source order.
  for (const post of postRanges) {
    if (!preNames.has(post.name)) {
      out.push({
        name: post.name,
        kind: "added",
        file: fd.newPath ?? path,
        lineRange: { start: post.start, end: post.end },
      });
    } else if (modified.has(post)) {
      out.push({
        name: post.name,
        kind: "modified",
        file: fd.newPath ?? path,
        lineRange: { start: post.start, end: post.end },
      });
    }
    // present-in-both but untouched → emit nothing.
  }
  // removed: pre instances whose name vanished from the post image.
  for (const pre of preRanges) {
    if (postNames.has(pre.name)) continue;
    out.push({
      name: pre.name,
      kind: "removed",
      file: fd.oldPath ?? path,
      lineRange: { start: pre.start, end: pre.end },
    });
  }
  return out;
}

/**
 * Extract the changed functions from a unified diff.
 *
 * @param diff   unified git diff text
 * @param images reader for pre (HEAD) + post (working tree) images
 * @param lang   language to parse both images as
 */
export async function extractChangedFunctions(
  diff: string,
  images: ImageReader,
  lang: SupportedLang,
): Promise<ChangedFunction[]> {
  const result: ChangedFunction[] = [];
  for (const fd of parseUnifiedDiff(diff)) {
    result.push(...(await changedFunctionsForFile(fd, images, lang)));
  }
  return result;
}

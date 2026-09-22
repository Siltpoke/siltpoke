// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Reading a unified diff out of the citation corpus.
 *
 * Split out of `evidence-guard.ts` when a later change pushed that file past this
 * project's 800-line hard cap. The boundary is not arbitrary: everything here
 * is PARSING — it decides what the diff says and nothing about whether a
 * citation is allowed. Every judgement stays in the guard, where
 * `auditEvidenceInDiff` wraps `guardCritique` and can therefore see it. A check
 * moved out of that function's reach is a check that gate goes blind to, which
 * is the recurring shape here: the defence exists and cannot fire.
 *
 * The edge cases below were not designed; each one is a citation this project
 * refused and should not have. They are described where they are handled.
 */
/**
 * ALL THREE GROUPS ARE NAMED, deliberately. The two counts used to be numbered
 * groups read as `header[1]` / `header[2]`; adding a group for the `+` side's
 * start position would have renumbered them silently, and the counts are what
 * stops a hunk running on into the text after it. Named groups cannot be
 * renumbered by a later edit.
 */
const HUNK_HEADER = /^@@ -\d+(?:,(?<oldLines>\d+))? \+(?<newStart>\d+)(?:,(?<newLines>\d+))? @@/;

/**
 * Lines siltpoke itself writes after a tool's stdout, both of which begin with
 * `-` and so would read as a removed line inside a hunk left open by a cut-short
 * diff: the corpus separator (`buildToolOutputSection`, src/brain/prompt-tools.ts)
 * and the stderr marker (`buildRaw`, src/critic/tools/run-git-diff.ts).
 * Matched exactly, not by prefix: a removed SQL comment `-- x` prints as
 * `--- x`, and that one is code.
 */
const APPENDED_BY_SILTPOKE = new Set(["--- corpus separator ---", "--- stderr ---"]);

/**
 * Whether the empty line at `lines[j]` is a blank context line that the hunk
 * visibly continues past.
 *
 * Under `diff.suppressBlankEmpty` git prints blank context with no leading
 * space, so an empty line can be one — but it can also be the newline a
 * cut-short diff ended on, right before siltpoke appends `--- stderr ---`
 * (cross-family review, 2026-09-10). The two look identical when nothing diff-
 * shaped follows, so only a blank line with more hunk after it is quotable.
 * The hunk's final owed line is handled by the caller: counted, not quoted.
 */
function blankContextContinues(lines: readonly string[], j: number, oldLeft: number, newLeft: number): boolean {
  if (lines[j] !== "" || oldLeft < 2 || newLeft < 2) return false;
  const next = lines[j + 1];
  if (next === undefined || APPENDED_BY_SILTPOKE.has(next)) return false;
  // A run of blank lines is judged by whatever ends the run.
  if (next === "") return blankContextContinues(lines, j + 1, oldLeft - 1, newLeft - 1);
  return next[0] === " " || next[0] === "+" || next[0] === "-" || next[0] === "\\";
}

/**
 * Every diff hunk in the corpus: which file each belongs to, where it starts in
 * that file, and its line prefixes removed to give the two
 * texts it describes: the file after the change (context + added lines) and
 * the file before it (context + removed lines).
 *
 * Why this exists: a unified diff prefixes every line with `+`, `-` or a
 * space, and a reviewer quotes code as the FILE reads. So a multi-line quote of
 * real, shown code was never a verbatim substring of the corpus, and was
 * refused. Measured 2026-09-10 over every recorded review whose drop count this
 * guard reproduces: 18 of 98 refused citations were exactly that.
 *
 * Every side is its own string, matched on its own. Matching against both
 * sides at once would accept a removed line stitched to an added one — a block
 * that exists in no version of the file — and matching across hunks would
 * accept two pieces of code that are adjacent in the diff text and dozens of
 * lines apart in the file. A joined string with a separator was the first
 * draft, and any separator made of ordinary characters is one a snippet can
 * contain.
 *
 * Only the RAW diff is parsed — never the formatted section's copy of it.
 * The formatted copy puts siltpoke's own text inside a hunk: an elision marker
 * where the middle was cut, and for a very long hunk a summary right under the
 * header, while the header keeps promising the full line count. Today both
 * start with `[` and would end the parse, but a summary is free to start with
 * `- ` and would then read as removed code. The raw diff holds every line the
 * formatted copy shows, so parsing only the raw loses no real quote.
 *
 * A hunk ends where its header's line counts say, or at the first line that
 * is not a diff line, whichever comes first. Without the counts, text that
 * follows a hunk and happens to start with a space or a dash would be read as
 * code. Without the second rule, a raw diff cut short mid-hunk (a timeout
 * keeps partial stdout) would run on into what siltpoke appends after it.
 */
export interface CorpusHunk {
  /** Path on the `---` side; `null` when that side is `/dev/null` (an add). */
  oldFile: string | null;
  /** Path on the `+++` side; `null` when that side is `/dev/null` (a delete). */
  file: string | null;
  /** First line number this hunk describes in the `+++` side's file. */
  newStart: number;
  before: string;
  after: string;
  /**
   * How many EARLIER file blocks in this corpus carried the same `file` value.
   *
   * Only ever non-zero on the recent-commits path, where three commits' diffs
   * are concatenated with their commit headers stripped, so one file can appear
   * two or three times with line numbers that disagree. `git log` emits newest
   * first, so block 0 is the most recent change to that file and the only one
   * whose numbers can be true of the file as it is now.
   */
  blockIndex: number;
}

const DEV_NULL = "/dev/null";

/** `a/src/x.ts` -> `src/x.ts`. `/dev/null` is a marker, not a path, and is left alone. */
function stripDiffPathPrefix(path: string): string {
  return path === DEV_NULL ? path : path.replace(/^[ab]\//, "");
}

/**
 * Whether `lines[i]` opens a file block: a `--- ` line with a `+++ ` line
 * directly under it, which is the only shape a unified diff puts a file header
 * in.
 *
 * REQUIRING THE PAIR IS THE WHOLE POINT. `changed-functions.ts` opens a file
 * record on any line starting `--- `, which is safe in its own domain (one
 * trusted `git diff` blob, scanned flat) and is NOT safe here: this corpus
 * holds `--- corpus separator ---` and `--- stderr ---` by construction, and a
 * removed source line reading `-- x` prints as `--- x`. Those are already
 * excluded from a hunk BODY by `APPENDED_BY_SILTPOKE` and by the hunk counts —
 * this is the same discipline applied to the outer scan, so that neither can
 * invent a file either. `tests/critic/evidence-guard-diff-sides.test.ts` pins
 * the `-- ` case.
 */
function fileHeaderAt(lines: readonly string[], i: number): { oldFile: string | null; file: string | null } | null {
  const minus = lines[i];
  const plus = lines[i + 1];
  if (minus === undefined || plus === undefined) return null;
  if (!minus.startsWith("--- ") || !plus.startsWith("+++ ")) return null;
  if (APPENDED_BY_SILTPOKE.has(minus)) return null;
  const oldPath = stripDiffPathPrefix(minus.slice(4).trim());
  const newPath = stripDiffPathPrefix(plus.slice(4).trim());
  return {
    oldFile: oldPath === DEV_NULL ? null : oldPath,
    file: newPath === DEV_NULL ? null : newPath,
  };
}

/**
 * A parsed citation corpus: every hunk, plus the paths this diff MOVED OFF.
 *
 * `movedAway` cannot be derived from `hunks`, which is why it is here and not
 * computed by the caller. A 100%-similarity rename emits `diff --git`,
 * `similarity index 100%`, `rename from` and `rename to` — and no `---`, no
 * `+++`, no `@@` at all. An empty file's deletion is the same shape with a
 * `---`/`+++` pair and still no hunk. Both leave a name whose most recent fate
 * is invisible to a hunk scan, and a line number derived for that name from an
 * older block points into a file that is no longer there.
 */
export interface ParsedCorpus {
  hunks: CorpusHunk[];
  /** Paths whose newest appearance in this corpus renames or deletes them. */
  movedAway: Set<string>;
}

export function diffHunks(corpus: string): ParsedCorpus {
  const hunks: CorpusHunk[] = [];
  // CRLF files: git passes the `\r` through, and a reviewer's JSON quote has
  // plain `\n`. Left in, every multi-line quote of such a file was refused.
  const lines = corpus.split(/\r?\n/);
  let currentOldFile: string | null = null;
  let currentFile: string | null = null;
  let currentBlockIndex = 0;
  /** How many blocks already seen per `+++` path, so `blockIndex` can be assigned. */
  const blocksPerFile = new Map<string, number>();
  const movedAway = new Set<string>();
  // A header only opens a hunk where a raw diff can put one: straight after a
  // file's `+++` line (`git diff` / `git log -p`), or straight after a hunk
  // that ran to its full counts (the next hunk of the same file). Anywhere
  // else — another tool's output, the formatted section's ```` ```diff ````
  // fences — a line shaped like `@@ -1,2 +1,2 @@` is not a hunk this parser
  // should trust, and stripping a column off what follows it would verify
  // text no tool produced (found by cross-family review, 2026-09-10).
  //
  // Residual, stated rather than implied: a tool whose output held a `+++ `
  // line directly above a hunk-shaped one would still open a hunk. None of the
  // four tools prints that — ripgrep and eslint emit JSON, tsc leads every line
  // with a path.
  let headerAllowed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Only reached for lines OUTSIDE a hunk body: the inner loop below consumes
    // its own lines and the outer index resumes past them (`i = j - 1`). That is
    // what keeps a removed `-- ` line from being read as a file header.
    // A rename with NO content change writes only these two lines — no header
    // pair and no hunk — so it is the one file event the loop below can never
    // see. Read here, where the inner hunk-body loop has already consumed
    // anything that merely looks like it (a removed source line reading
    // `rename from x` arrives as `-rename from x`, and a context one as
    // ` rename from x`; neither starts at column zero).
    const renameFrom = /^rename from (.+)$/.exec(line);
    if (renameFrom !== null) movedAway.add(renameFrom[1]!.trim());

    const fileHeader = fileHeaderAt(lines, i);
    if (fileHeader !== null) {
      currentOldFile = fileHeader.oldFile;
      currentFile = fileHeader.file;
      // A delete, or a rename that did change content. The delete case matters
      // even though it usually has hunks: deleting an EMPTY file has none.
      if (fileHeader.oldFile !== null && fileHeader.file !== fileHeader.oldFile) {
        movedAway.add(fileHeader.oldFile);
      }
      // Counted per `+++` path only. A deleted file has no `+++` path, and its
      // `blockIndex` is never read: a hunk with no `file` can never be the one
      // a finding's own `file` selects. Giving it 0 is not a claim about it.
      if (currentFile === null) {
        currentBlockIndex = 0;
      } else {
        currentBlockIndex = blocksPerFile.get(currentFile) ?? 0;
        blocksPerFile.set(currentFile, currentBlockIndex + 1);
      }
    }
    const header: RegExpExecArray | null = headerAllowed ? HUNK_HEADER.exec(line) : null;
    headerAllowed = line.startsWith("+++ ");
    if (header === null) continue;
    // An omitted count means 1 (unified diff format).
    const groups = header.groups ?? {};
    const newStart: number = Number(groups["newStart"]);
    let oldLeft: number = groups["oldLines"] === undefined ? 1 : Number(groups["oldLines"]);
    let newLeft: number = groups["newLines"] === undefined ? 1 : Number(groups["newLines"]);
    const before: string[] = [];
    const after: string[] = [];
    let j = i + 1;
    // The counts are enforced per branch, not in the loop condition: once a
    // side has no lines left, a line for it falls through to `break`.
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      const mark = line[0];
      if (APPENDED_BY_SILTPOKE.has(line)) {
        break;
      } else if ((mark === " " || blankContextContinues(lines, j, oldLeft, newLeft)) && oldLeft > 0 && newLeft > 0) {
        before.push(line.slice(1));
        after.push(line.slice(1));
        oldLeft--;
        newLeft--;
      } else if (line === "" && oldLeft === 1 && newLeft === 1) {
        // Possibly a blank last context line, possibly a cut-short diff's final
        // newline. Counted either way, so a following hunk of the same file can
        // still open; quoted neither way, so it cannot vouch for a trailing `\n`.
        oldLeft--;
        newLeft--;
      } else if (mark === "-" && oldLeft > 0) {
        before.push(line.slice(1));
        oldLeft--;
      } else if (mark === "+" && newLeft > 0) {
        after.push(line.slice(1));
        newLeft--;
      } else if (mark === "\\") {
        // "\ No newline at end of file" — describes the line above, is not one.
      } else {
        break;
      }
    }
    hunks.push({
      oldFile: currentOldFile,
      file: currentFile,
      newStart,
      before: before.join("\n"),
      after: after.join("\n"),
      blockIndex: currentBlockIndex,
    });
    headerAllowed = oldLeft === 0 && newLeft === 0;
    i = j - 1;
  }
  return { hunks, movedAway };
}

/**
 * The two texts each hunk describes, in hunk order — the shape every existing
 * citation check reads.
 *
 * A HUNK IS NEVER SKIPPED HERE, including one whose `+++` side is `/dev/null`.
 * Dropping those would hand the checks fewer strings than before and quietly
 * refuse a citation of deleted code that has always verified — a regression
 * with no test pointing at it, on the one path ruler G would have caught and
 * which produces no evidence this slice.
 */
export function sidesOf(hunks: readonly CorpusHunk[]): string[] {
  return hunks.flatMap((h) => [h.before, h.after]);
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Splitting a `git log -N -p --stat` blob into ONE review subject + the diffs.
 *
 * Why this exists: the recent-commits fallback (`runRecentCommitsDiff`) hands the
 * reviewer a single blob in which every commit carries its own message inline and
 * nothing marks where one commit ends and the next begins. Twice on 2026-08-25 —
 * independently, in the same repo — the reviewer read the TOP commit's message
 * against a LOWER commit's hunks and filed an accusatory false positive ("the
 * message concealed the real scope"). Write-up:
 * an internal design note.
 *
 * It is worse than "a message sits in the blob": `parseUnifiedDiffRaw` stops a
 * hunk body at `diff --git` / `--- ` / `+++ ` / the next `@@`, and a bare `---`
 * (git's own separator between message and `--stat`) matches none of those. So an
 * intervening commit header is swallowed INTO the previous commit's last hunk body
 * and reaches the prompt attached to an unrelated file.
 *
 * The fix keeps all N diffs — `commitCount = 1` was measured out, 63% of 1703 real
 * review inputs carry three commits — and instead strips every inline header, then
 * names exactly one commit as the subject.
 *
 * Anchoring: a `commit <40hex>` line at COLUMN 0 can only be a log header. Every
 * diff-content line carries a `+`/`-`/space prefix, and `git log` indents every
 * message line by four spaces — which is why the rendered subject block below keeps
 * the message indented rather than dedenting it. That makes "exactly one commit
 * block reached the reviewer" a checkable property rather than a hope.
 *
 * Pure functions — no IO, no side effects.
 */

/** The one commit a critique may attribute the diff's intent to. */
export type ReviewSubject = {
  /** Full 40-hex sha of the newest commit in the blob. */
  sha: string;
  /** Its message, still indented four spaces exactly as `git log` emits it. */
  message: string;
  /** How many OLDER commits' diffs are present as background. */
  backgroundCommits: number;
};

/** A log header at column 0. Trailing text allows `log.decorate` output. */
const COMMIT_HEADER_RE = /^commit ([0-9a-f]{40})(?:\s.*)?$/;
/**
 * Header metadata lines that precede the message body. Exactly the three
 * `--pretty=medium` emits, which is the format `runRecentCommitsDiff` pins —
 * `AuthorDate:`/`CommitDate:`/`Commit:` are `--pretty=fuller` and `Reflog:` needs
 * `-g`, so matching them here would be branches no caller can reach.
 */
const HEADER_META_RE = /^(?:Author|Date|Merge):/;

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * Pull the message out of one commit's header block (the lines from `commit <sha>`
 * up to that commit's first `diff --git`). Drops the metadata lines and the
 * `--stat` tail, and leaves the message's four-space indent in place.
 */
function extractMessage(headerLines: string[]): string {
  // git's own separator between the message and a `--stat` block is a bare `---`.
  // The pinned argv no longer asks for `--stat`, so this is a structural guard
  // against it coming back, not a live branch: without it, a restored `--stat`
  // would silently render its file summary as part of the commit message.
  const dashIdx = headerLines.indexOf("---");
  const zone = headerLines.slice(1, dashIdx === -1 ? headerLines.length : dashIdx);
  const withoutMeta = zone.filter((l) => !HEADER_META_RE.test(l));
  return trimBlankEdges(withoutMeta).join("\n");
}

/**
 * Split a `git log -N -p --stat` blob into the newest commit's identity and the
 * diff content of every commit with all inline headers removed.
 *
 * Unrecognised shape (no column-0 `commit <40hex>` line at all) is passed through
 * untouched with no subject, rather than emptied — the same fail-soft posture
 * `scopeDiffRawToFiles` takes. A caller that gets `subject === null` is looking at
 * a blob this function did not understand.
 */
export function splitRecentCommitsLog(
  stdout: string,
): { subject: ReviewSubject | null; diffOnly: string } {
  const lines = stdout.split("\n");

  // Locate every commit header at column 0.
  const headerIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (COMMIT_HEADER_RE.test(lines[i]!)) headerIdx.push(i);
  }
  if (headerIdx.length === 0) return { subject: null, diffOnly: stdout };

  // Only commits that actually put a diff on the table can be spoken about. A
  // merge under plain `-p`, and an empty commit, emit a header and no diff — and
  // naming one of those as the subject would hand the reviewer a message belonging
  // to none of the code below it, which is the very mistake this file removes.
  const diffBearing: Array<{ sha: string; message: string; diff: string }> = [];

  for (let c = 0; c < headerIdx.length; c++) {
    const start = headerIdx[c]!;
    const end = c + 1 < headerIdx.length ? headerIdx[c + 1]! : lines.length;
    const block = lines.slice(start, end);

    const diffStart = block.findIndex((l) => l.startsWith("diff --git "));
    if (diffStart === -1) continue;

    diffBearing.push({
      sha: COMMIT_HEADER_RE.exec(lines[start]!)![1]!,
      message: extractMessage(block.slice(0, diffStart)),
      diff: trimBlankEdges(block.slice(diffStart)).join("\n"),
    });
  }

  // Nothing to attribute: every commit in the window is diff-less. Pass through
  // rather than emit a subject block over an empty diff — there are no hunks to
  // misattribute, so there is nothing for this function to protect.
  const newest = diffBearing[0];
  if (newest === undefined) return { subject: null, diffOnly: stdout };

  return {
    subject: {
      sha: newest.sha,
      message: newest.message,
      // Counts commits whose diff is present, NOT log headers: saying "spans 3
      // commits" over a two-commit diff is a fresh falsehood, not a rounding error.
      backgroundCommits: diffBearing.length - 1,
    },
    diffOnly: diffBearing.map((d) => d.diff).join("\n"),
  };
}

/**
 * Render the one commit block the reviewer is allowed to attribute intent to.
 *
 * The `commit <sha>` line sits at column 0 on purpose: that is the anchor the
 * cross-commit assertion counts, and message lines keep their four-space indent so
 * message text can never forge a second one.
 *
 * Two variants, built from the same parts so they cannot drift:
 * - `shown` goes into the prompt the Brain reads.
 * - `citable` drops the leading notice, which is siltpoke's own prose. The evidence
 *   guard treats its corpus as "things a tool said"; leaving the notice in would let
 *   a critique quote siltpoke back at itself and pass the verbatim check. Same
 *   reason `formatCoverageNotice`'s text is held out of `citationSection`. The
 *   commit line and its message stay — those are real `git log` output.
 */
export function formatReviewSubjectBlock(
  subject: ReviewSubject,
): { shown: string; citable: string } {
  const notice =
    subject.backgroundCommits === 0
      ? "REVIEW SUBJECT — the diff below is this one commit."
      : `REVIEW SUBJECT — the diff below spans ${subject.backgroundCommits + 1} commits, but only the commit named here is under review. The other ${subject.backgroundCommits} are BACKGROUND: do not attribute their changes to this message, and do not make a scope claim that crosses commits.`;
  const citable = [`commit ${subject.sha}`, subject.message].join("\n");
  return { shown: [notice, "", citable].join("\n"), citable };
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { appendFile, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { BrainOutput, EvidenceItem, Finding } from "../brain/schema";
import type { EvidenceLabel, EvidenceVerdict } from "../critic/evidence-guard";
import { withFindingIds } from "../critic/evidence-guard";

export interface CritiqueInput {
  brain_output: BrainOutput;
  session_id: string;
  cwd: string;
  /**
   * @internal test seam — stub git-branch resolution so tests never shell out.
   * Production default reads `git rev-parse --abbrev-ref HEAD` in `cwd`.
   */
  gitBranchFn?: (cwd: string) => string | null;
  /**
   * What the evidence guard made of this review — defect ⑩ step 1.
   *
   * Optional because exactly one caller has it: `guardCritique` runs in the
   * NORMAL phase only (`src/critic/phases/normal.ts`), and the PASSIVE_BUBBLE
   * phase — 79% of triggers — never calls it. Absent therefore means "the
   * guard did not run", which is written to disk as `not_checked` rather than
   * left blank: an absent section and an uncited review must not be the same
   * bytes on disk, or every later count over this archive is reading its own
   * missing instrumentation as a finding about the reviewer.
   */
  evidence_verdict?: EvidenceVerdict;
}

export interface CritiqueResult {
  id: string;
  path: string;
}

function shortId(): string {
  return `c-${randomBytes(2).toString("hex")}`;
}

function todayDir(): string {
  return new Date().toISOString().slice(0, 10);
}

function escapeForFence(text: string): string {
  // Find any existing run of backticks and use a fence one longer than
  // the longest run, so the body can never close our fence early.
  let longest = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === "`") {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * What to say when `critique_for_claude` is empty — defect [15], audit §19/§21.
 *
 * An empty critique is NOT a malfunction: it is what `severity: info` looks
 * like. Measured over the 3,776 critiques in this repo's local archive, empty
 * is **1,862 of 1,862** info reviews and **0 of 1,914** graded ones (low +
 * medium + high). That is why the schema keeps `critique_for_claude:
 * z.string()` with no `.min(1)` — audit §19.3 proposed adding it, and a parse
 * failure there is not a loud red: `parseBrainOutput` throws, every provider
 * wraps it as a `BrainError`, and `phases/normal.ts` turns that into
 * HARD_SUPPRESS. Half of all reviews would have been discarded in silence.
 *
 * The defect is that an empty string rendered as an EMPTY FENCED BLOCK, which
 * reads identically to a reviewer that died. So say which case it is, and drop
 * the fence — do not fill it: `src/daemon/routes/critique.tsx` maps the fenced
 * body back onto `critique_for_claude`, so a placebo sentence inside the fence
 * would arrive downstream as a critique the reviewer never wrote.
 *
 * The graded branch below has **no observed instance** — the "1 in 4,865
 * medium" first recorded in §21 was an artifact of a counting script carrying
 * the very fence bug this change had to fix. It is kept because it is
 * reachable, and that was checked rather than assumed: `autoPromoteSeverity`
 * (src/critic/phases/severity-promotion.ts) back-fills an empty critique only
 * on the `info → low` promotion path, so nothing stops Brain returning `medium`
 * with nothing written.
 */
export function emptyCritiqueNote(severity: BrainOutput["severity"]): string {
  return severity === "info"
    ? "The reviewer had no actionable concerns this round, so there is nothing to forward. This is a clean review, not a failed one."
    : `The reviewer graded this ${severity} but wrote no critique. That is a malfunction, not a clean bill of health — the grade is unexplained, so do not read this as approval.`;
}

/**
 * The one place the absent-verdict default is decided.
 *
 * It is a function rather than three `?? "not_checked"` expressions because it
 * was three, and a mutation run proved two of them were unasserted: flipping
 * the body's default to `no_evidence` — a materially different claim, "the
 * reviewer cited nothing" instead of "nobody checked" — left the whole suite
 * green. One source, one thing to pin.
 */
/**
 * The labels that mean "nothing was examined" — as a predicate, because there
 * are now two and every consumer that hard-coded the first one would silently
 * treat the second as a checked review. TypeScript cannot catch that: both are
 * members of the same union, so `=== "not_checked"` stays valid and just stops
 * being true.
 */
export function isUnchecked(label: EvidenceLabel | null): boolean {
  return label === "not_checked" || label === "not_checked_budget";
}

function labelOf(input: CritiqueInput): EvidenceLabel {
  return input.evidence_verdict?.label ?? "not_checked";
}

/**
 * One evidence item, rendered so a human can walk straight to the code it
 * points at. `file:line` first because that is what a reader retypes; the
 * snippet is fenced so a citation containing markdown cannot reshape the page.
 */
function renderEvidenceItem(item: EvidenceItem): string[] {
  const where = item.line === undefined ? item.file : `${item.file}:${item.line}`;
  // Same fence escaping `critique_for_claude` gets, for the same reason and
  // then some: a snippet is a verbatim slice of tool stdout, and a `git-diff`
  // hunk of any markdown file routinely contains a ``` line. A fixed 3-backtick
  // fence let such a snippet close the block and inject document-level markdown
  // — headings, a `status:` line at column 0 — into a file that
  // `src/cli/get-critique.ts` pastes wholesale into Claude's context.
  //
  // The body is NOT indented: indenting only the first line of a multi-line
  // snippet (which is what string interpolation does) mangles the rest.
  const fence = escapeForFence(item.snippet);
  return ["", `- \`${where}\` (${item.tool})`, "", fence, item.snippet, fence];
}

/**
 * The Evidence section, written on EVERY critique.
 *
 * Never conditional on having something to say. The whole reason defect ⑩'s
 * first step is "make it land on disk" is that the archive could not tell
 * "cited nothing" apart from "this build recorded nothing" — an absent section
 * would rebuild that ambiguity in a new place.
 */
function buildEvidenceSection(input: CritiqueInput): string[] {
  const verdict = input.evidence_verdict;
  const label = labelOf(input);
  const lines = ["", "## Evidence", "", `label: ${label}`];

  if (verdict === undefined) {
    lines.push(
      "",
      "The evidence guard did not run on this review — this is not a claim about",
      "what the reviewer cited. `guardCritique` runs in the NORMAL phase only.",
    );
    // The model's own citations still land, guard or no guard: they are what a
    // later pass has to check against the code.
    lines.push(...renderCitedItems(input.brain_output.evidence, "Cited by the reviewer, unchecked"));
    return lines;
  }

  if (verdict.label === "no_evidence") {
    // "Cited nothing" and "cited things siltpoke could not use" are different
    // facts, and since 2026-09-01 they arrive at the same label: the schema layer
    // drops evidence items that fail their own shape (`coerceBrainOutputShape`),
    // so an all-malformed citation list becomes `evidence: []` — which reads
    // here exactly like a reviewer that pointed at nothing. Saying so would put
    // the blame on the reviewer for a discard siltpoke performed.
    const malformed = input.brain_output.truncated?.evidence_malformed ?? 0;
    lines.push(
      "",
      malformed > 0
        ? `The reviewer cited ${malformed} line${malformed === 1 ? "" : "s"}, and none of them arrived in a usable shape — siltpoke dropped them, so there is no line to walk to.`
        : "The reviewer cited nothing — there is no line to walk to.",
    );
    return lines;
  }

  // `not_checked` also lands here, and its `verified` array is a PASS-THROUGH,
  // not a result: `guardCritique` returns `out.evidence` untouched for the modes
  // it does not examine, and says in its own comment that calling those items
  // verified would be a false claim. Unreachable today — the one production call
  // site hardcodes "NORMAL" — but the branch is retained precisely so defect ①'s
  // REVIEW mode can arrive here, which is when printing "Confirmed" over
  // unexamined citations would start lying.
  // Both unchecked labels take the pass-through heading: neither examined
  // anything, and printing "Confirmed" over unexamined citations is the lie
  // this branch exists to avoid. They differ only in WHY, which the mark on the
  // dashboard says; the markdown says the same true thing for both.
  const heading = isUnchecked(verdict.label)
    ? "Cited by the reviewer, unchecked"
    : "Confirmed";
  lines.push(...renderCitedItems(verdict.verified, heading));

  if (verdict.unverified.length > 0) {
    lines.push("", "### Refused", "");
    lines.push(
      "Cited by the reviewer and refused by the guard. Kept because a bare count",
      "cannot say WHICH citation went, or why.",
    );
    for (const bad of verdict.unverified) {
      const where = bad.line === undefined ? bad.file : `${bad.file}:${bad.line}`;
      lines.push("", `- \`${where}\` (citation #${bad.index}) — ${bad.reason}`);
    }
  }

  return lines;
}

function renderCitedItems(items: readonly EvidenceItem[], heading: string): string[] {
  if (items.length === 0) return ["", `### ${heading}`, "", "(none)"];
  const lines = ["", `### ${heading}`];
  for (const item of items) lines.push(...renderEvidenceItem(item));
  return lines;
}

/**
 * Branch the review was written against, recorded so a critique file can
 * answer "is this about what I am doing now?" on its own, without joining
 * `brain-calls.jsonl`. Guarded like every other git read in this codebase:
 * a non-git dir, a detached HEAD or any spawn failure yields null and the
 * line is simply omitted — a reader that only has the timestamp still works,
 * which is also what every critique written before this field looks like.
 */
export function readCritiqueBranch(cwd: string): string | null {
  if (!cwd) return null;
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
    });
    const b = r.status === 0 ? r.stdout.trim() : "";
    return b && b !== "HEAD" ? b : null;
  } catch {
    return null;
  }
}

/**
 * The "## Critique (for Claude, if forwarded)" section.
 *
 * Fenced when there is a critique, a plain sentence when there is not — see
 * `emptyCritiqueNote` for why the empty case is not an error and why it must
 * not be rendered as a fence.
 */
function renderCritiqueSection(out: BrainOutput): string[] {
  const head = ["", "## Critique (for Claude, if forwarded)", ""];
  if (out.critique_for_claude.trim().length === 0) {
    return [...head, emptyCritiqueNote(out.severity)];
  }
  const fence = escapeForFence(out.critique_for_claude);
  return [...head, fence, out.critique_for_claude, fence];
}

/**
 * `src/foo.ts` or `src/foo.ts:41-43`.
 *
 * A range is printed only when the guard derived one it stands behind. Absent
 * is the honest rendering for every other case — a line number nothing
 * anchored, printed with a caveat a reader may not notice, is worse than no
 * line number, and that is the whole reason the guard withholds it.
 */
function describeFindingLocation(f: Finding): string {
  if (f.start_line === undefined) return f.file;
  return f.end_line === undefined || f.end_line === f.start_line
    ? `${f.file}:${f.start_line}`
    : `${f.file}:${f.start_line}-${f.end_line}`;
}

/**
 * ` · quote: strong` / ` · quote: weak`, or nothing at all.
 *
 * NOTHING is the case to get right. A finding written before this field
 * existed, or one from a mode that checked nothing, carries no tier — and
 * rendering that as `weak` would state a result where none was reached. The
 * badge says what was found; its absence says nobody looked.
 */
function tierSuffix(f: Finding): string {
  return f.quote_tier === undefined ? "" : ` · quote: ${f.quote_tier}`;
}

/**
 * The findings, one addressable block each.
 *
 * Omitted entirely when there are none — which is the common shape, not an edge
 * case, and is why this returns `[]` rather than a heading over an empty list.
 * Every critique written before this field existed lands here too, and gets the
 * same silence; the `## Evidence` section below is unchanged and still carries
 * what those files have.
 *
 * Ids are numbered HERE, over the array as persisted — which is the array the
 * guard already filtered. See `withFindingIds`.
 */
function buildFindingsSection(out: BrainOutput): string[] {
  if (out.findings.length === 0) return [];
  const lines: string[] = ["", "## Findings", ""];
  for (const f of withFindingIds(out.findings)) {
    lines.push(`### ${f.id} — ${f.title}`, "");
    lines.push(`- \`${describeFindingLocation(f)}\` · severity: ${f.severity}${tierSuffix(f)}`, "");
    lines.push("```", f.quote, "```", "");
    lines.push(f.body, "");
  }
  return lines;
}

function buildMarkdown(input: CritiqueInput, id: string): string {
  const out = input.brain_output;
  const branch = (input.gitBranchFn ?? readCritiqueBranch)(input.cwd);
  const timestamp = new Date().toISOString();
  const project = input.cwd ? basename(input.cwd) : "";

  const frontmatter = [
    "---",
    `schemaVersion: 1`,
    `timestamp: ${timestamp}`,
    `critique_id: ${id}`,
    `session_id: ${input.session_id}`,
    `cwd: ${input.cwd}`,
    `project: ${project}`,
    `mood: ${out.mood}`,
    `pose: ${out.pose}`,
    `severity: ${out.severity}`,
    `confidence: ${out.confidence}`,
    // Defect ⑩: `confidence` is a constant in practice (99.5% `high` over
    // 6,033 archived critiques), so it says nothing about how well grounded a
    // finding is. This one does, and it sits in frontmatter so a scan over the
    // archive can read it without parsing the body.
    `evidence_label: ${labelOf(input)}`,
    // Read-time freshness inputs. A reader that only has a timestamp makes the
    // user do arithmetic and still cannot answer the question they actually
    // have, which is "is this about what I just did" — see `renderFreshness`.
    ...(branch ? [`branch: ${branch}`] : []),
    `status: pending`,
    "---",
  ].join("\n");

  const body = [
    "",
    "# [SILTPOKE CRITIQUE]",
    "",
    "> ⚠️ This is a secondary AI reviewer's opinion from Siltpoke, a buddy assistant.",
    "> It MAY BE WRONG. Verify against the actual code before acting on this feedback.",
    "> Your primary source of truth is the user and the codebase itself.",
    "",
    "## Bubble (user-facing)",
    "",
    out.bubble_short,
  ];
  if (out.bubble_long) {
    body.push("", out.bubble_long);
  }
  body.push(
    ...renderCritiqueSection(out),
    "",
    "## Severity / Confidence",
    "",
    `severity: ${out.severity}`,
    `confidence: ${out.confidence}`,
  );

  body.push(...buildFindingsSection(out));
  body.push(...buildEvidenceSection(input), "");

  return `${frontmatter}\n${body.join("\n")}`;
}

export async function writeCritique(
  basePath: string,
  input: CritiqueInput,
): Promise<CritiqueResult> {
  const id = shortId();
  const dateDir = todayDir();
  const archiveDir = join(basePath, "critiques", "archive", dateDir);
  const filename = `${id}.md`;
  const fullPath = join(archiveDir, filename);
  const historyPath = join(basePath, "critiques", "history.jsonl");
  const latestPath = join(basePath, "critiques", "latest.md");
  const md = buildMarkdown(input, id);

  try {
    await mkdir(archiveDir, { recursive: true });
    await writeFile(fullPath, md, "utf8");
  } catch {
    return { id, path: fullPath };
  }

  // The same review, as data.
  //
  // WHY A SECOND FILE AND NOT A RICHER HEADING. Everything structured about a
  // critique has been readable only by parsing the markdown back — the daemon
  // route does exactly that, with a regex per section and a hardcoded empty
  // evidence array where the parse gives up. Prose read by a parser is a
  // contract: the heading text becomes load-bearing, and a wording change
  // downstream silently empties a page. `findings` would have inherited that
  // on day one.
  //
  // Best-effort on purpose, in its own try: the markdown is the artifact of
  // record and a critique that renders but has no sidecar is strictly better
  // than one that failed to write at all. Readers therefore treat an absent
  // sidecar as "older than this", never as "empty" — which is also what makes
  // every critique already on disk keep working.
  try {
    await writeFile(
      join(archiveDir, `${id}.json`),
      `${JSON.stringify({ schemaVersion: 1, critique_id: id, brain_output: input.brain_output }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Intentionally silent: see above.
  }

  try {
    const historyLine =
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        critique_id: id,
        session_id: input.session_id,
        cwd: input.cwd,
        mood: input.brain_output.mood,
        severity: input.brain_output.severity,
        confidence: input.brain_output.confidence,
        // The same facts the file carries, on the line a scan reads. Absent
        // verdict is written as `not_checked` here too, so a count over this
        // log never has to guess whether a blank means unchecked or uncited.
        evidence_label: labelOf(input),
        // Two separate numbers, because they answer two questions and the
        // common case is that only the first has an answer. `cited` is what the
        // model claimed; `verified` is what the guard confirmed, and it is
        // **0 when the guard never ran** — the first draft fell back to the
        // cited count there, which wrote `evidence_verified: 2` onto every
        // PASSIVE_BUBBLE row (79% of them) where nothing had been checked at
        // all. That is the exact ambiguity this change exists to remove,
        // reintroduced one field over.
        // `cited` comes from the VERDICT when there is one, not from
        // `brain_output.evidence`. On the real NORMAL path the caller
        // reassigns `critique.evidence` to the confirmed items BEFORE calling
        // this, so by write time the model's original citation count is gone
        // from that array — reading it there reported `cited: 0` for a review
        // that cited one item and had it refused. The verdict still holds both
        // halves, and their sum is what the model actually emitted.
        //
        // Caught only by `tests/critic/evidence-reaches-disk.test.ts`, which
        // runs the pipeline into the real writer; every direct-call unit test
        // passed because it built the two fields to agree by hand.
        //
        // `evidence_malformed` is added back for the same reason: since
        // 2026-09-01 the schema layer drops citations that fail their own shape
        // BEFORE the guard sees them, so the verdict's two halves no longer add
        // up to what the model emitted. This is the field a citation-count
        // analysis reads — #481's "reported count saturates at 4-5" headline came
        // out of it — and leaving it short would bias that count downward
        // silently. RESIDUAL, stated rather than implied: citations dropped by
        // the 5-item CAP (`truncated.evidence`) are still not counted here, and
        // never were; that predates this change and is not fixed by it.
        evidence_cited:
          (input.evidence_verdict
            ? input.evidence_verdict.verified.length + input.evidence_verdict.unverified.length
            : input.brain_output.evidence.length) +
          (input.brain_output.truncated?.evidence_malformed ?? 0),
        // `not_checked` is excluded on both routes into it — an absent verdict
        // AND a verdict that carries the label — because in that mode
        // `verified` is `out.evidence` passed through untouched, not a result.
        // Zero for BOTH unchecked labels. `verified` carries the pass-through
        // items, not a result, so counting them would report examinations that
        // never happened — the same reason the original line excluded
        // `not_checked`, applied to the label added beside it.
        evidence_verified: isUnchecked(labelOf(input))
          ? 0
          : (input.evidence_verdict?.verified.length ?? 0),
        evidence_unverified: input.evidence_verdict?.unverified.length ?? 0,
        // The findings half of the same three facts, on the same line, so a
        // scan does not have to open the file to get them.
        //
        // `findings_prose_only` is the one that answers a question nothing
        // could answer before: how often does the reviewer have something to
        // say that does not reduce to a quotable item? Measured on this repo's
        // own store, that is the ordinary case rather than an edge one, and a
        // count is the difference between knowing it and assuming it. It is
        // recorded as its own boolean rather than left to be derived from a
        // zero, because a zero here has two causes — nothing found, and nothing
        // quotable — and a reader cannot tell them apart.
        // How often the reviewer's own guess at a line number matched the one
        // the code derived. Four mutually-exclusive buckets summing to the
        // findings that survived the check, and the FIRST measurement of this
        // in the project — so there is no pass mark, only a baseline.
        // `range_code_silent` swallows every reason the code produced no range,
        // because "we could not check" is not a verdict on the model.
        range_agree: input.evidence_verdict?.rangeAgreement.agree ?? 0,
        range_disagree: input.evidence_verdict?.rangeAgreement.disagree ?? 0,
        range_model_silent: input.evidence_verdict?.rangeAgreement.model_silent ?? 0,
        range_code_silent: input.evidence_verdict?.rangeAgreement.code_silent ?? 0,
        findings_kept: input.brain_output.findings.length,
        findings_unverified: input.evidence_verdict?.unverifiedFindings.length ?? 0,
        findings_prose_only:
          input.brain_output.findings.length === 0 &&
          input.brain_output.critique_for_claude.trim().length > 0,
        bubble_short: input.brain_output.bubble_short,
        path: fullPath,
      })}\n`;
    await appendFile(historyPath, historyLine);
  } catch {
    // history append failure is non-fatal
  }

  try {
    await copyFile(fullPath, latestPath);
  } catch {
    // latest copy failure is non-fatal
  }

  return { id, path: fullPath };
}

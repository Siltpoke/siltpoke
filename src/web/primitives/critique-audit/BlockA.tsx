// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Block A — WHAT I READ
 *
 * Surfaces the inputs the critic considered before forming its verdict:
 * changed files, user raw query, agent reply, diff intent.
 *
 * **Two sources, not one.** The v2 sidecar is the richer source, but it exists
 * on a small minority of rows. Measured — snapshot
 * `scripts/probes/critic-audit-coverage-probe-output-2026-08-19T19Z.txt`
 * §4/§5, over the 400 most recent fired reviews of a real store: **19 carry a
 * `critique_id` (4.8%)**, and `attachV2Sidecars` matches on that id, so **381
 * rows — 95.3% — can never resolve a sidecar**. Of those 381, **356 (93.4%)
 * carry `diff_summary`** with the changed files, what each one was for, and
 * the diff intent.
 *
 * This block used to return a placeholder before looking — and the fallback to
 * `diff_summary.intent` that WAS written sat after that early return, so the
 * 95% of rows that needed it could never reach it ("written, reviewed, never
 * executed", `docs/lessons.md` L3). It reads the row now.
 *
 * *An earlier draft of this comment said 12/400 = 3%. That is the
 * `snippet not in evidence_corpus` row of the same probe table, read off the
 * wrong line; the row that answers "does this have an id" is
 * `ACCEPTED -> critique written, id minted`. Every number here now names the
 * snapshot it came from, because the store moves between runs.*
 *
 * The one field with no row-level source is the user's own words
 * (`user_raw_query` / `agent_reply`): those were only ever in the sidecar. The
 * write side is what had to change for those, not this renderer — see
 * `src/state/critic-event-log-types.ts`.
 *
 * Extracted from CritiqueAuditBlocks.tsx.
 */
import { tokens } from "../../tokens/tokens";
import type { V2SidecarData } from "../../../state/api";
import type { CriticCall } from "../../../state/api";
import {
  AuditSection,
  PlaceholderNote,
  MonoBlock,
  SubLabel,
  auditAbsenceNote,
} from "./shared";

/**
 * What `captureIntent` actually stores for the agent reply: the FIRST PARAGRAPH
 * of the first prose reply, capped at 1200 chars (`src/critic/intent/capture.ts`).
 * Never the full verbatim reply.
 *
 * This is the DEFAULT now. It used to be an opt-in that only `/timeline` passed,
 * while the default read `"agent reply (verbatim)"` — a label the prop's own
 * JSDoc called inaccurate. `/history` never passed the honest one, and once this
 * block started reading the row the false label went from the ~5% of rows with a
 * sidecar to nearly all of them. A caveat that has to be remembered at each call
 * site is a caveat that will be forgotten at one.
 */
export const AGENT_REPLY_LABEL = "agent reply (opening · first ¶, ≤1200 chars)";

export interface BlockAProps {
  v2: V2SidecarData | null;
  c: CriticCall;
  /**
   * Override for the agent-reply sub-label. Defaults to `AGENT_REPLY_LABEL`,
   * which is the accurate one; an override should only ever be MORE precise.
   */
  agentReplyLabel?: string;
}

/**
 * Redact absolute paths into project-relative or home-relative form:
 *   "${cwd}/src/foo.ts"            → "src/foo.ts"
 *   "/Users/{user}/.claude/x.json" → "~/.claude/x.json"
 *   "/dev/null", "<unknown>"       → unchanged
 *
 * Pure prefix-strip — no path normalization beyond what the input has.
 */
export function redactPath(p: string, cwd: string | null | undefined): string {
  if (!p) return p;
  if (cwd && cwd.length > 0) {
    const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
    if (p.startsWith(prefix)) return p.slice(prefix.length);
    if (p === cwd) return ".";
  }
  const homeMatch = p.match(/^\/(?:Users|home)\/[^/]+\//);
  if (homeMatch) return `~/${p.slice(homeMatch[0].length)}`;
  return p;
}

/** One changed file as this block renders it: the path, plus what it was for. */
interface ReadFile {
  path: string;
  /** From `diff_summary.files_with_purpose`; null when only the path is known. */
  purpose: string | null;
}

/** What `mergeReadFiles` resolved: real files, plus how many it could not name. */
export interface ReadFiles {
  files: ReadFile[];
  /**
   * Files the diff contained that no entry names. Rendered as a count, never
   * as a row — see `isTruncationSentinel`.
   */
  unlisted: number;
}

/**
 * `files_with_purpose` is not purely a list of files.
 *
 * When Haiku summarised fewer files than the diff contains,
 * `run-diff-summary.ts:196-204` APPENDS a synthetic entry whose `path` is
 * `"[15 additional files truncated — see DIFF SNAPSHOT below]"`. It is a note,
 * not a path, and it points at a section that exists on the Diff surface — not
 * under Block A. Rendering it verbatim would put a non-file in a file list and
 * tell the reader to scroll to nothing.
 *
 * It was unreachable before this block learned to read the row (`if (!v2)`
 * returned first). It is not rare: **165 of the 381 no-sidecar rows — 43.3% —**
 * carry it (snapshot
 * `scripts/probes/critic-audit-coverage-probe-output-2026-08-19T19Z.txt` §5).
 *
 * Detected by the `[` prefix, which is what the producer writes and what no
 * real path this renderer sees begins with. Deliberately not a match on the
 * sentence itself: the wording is the producer's to change, the shape is the
 * contract.
 */
function isTruncationSentinel(path: string): boolean {
  return path.startsWith("[");
}

/**
 * Merge the two records of "which files did this turn touch".
 *
 * `v2.changed_files` is authoritative for WHICH files — it is the list the
 * reviewer was handed — but carries no purpose. `diff_summary.files_with_purpose`
 * carries both, and is present on rows that have no sidecar at all. When both
 * exist the sidecar's list wins and the purposes are joined onto it, so a row
 * never trades the accurate file list for the purposes or the reverse.
 *
 * **The join is on the REDACTED path, not the raw one.** The two sources do not
 * share a namespace: `files_with_purpose[].path` is repo-relative
 * (`"docs/BACKLOG.md"`), while `changed_files` is often absolute — a real
 * sidecar on this machine carries `- /Users/…/smoke-desktop.ts`, and
 * `src/router/context.ts` states as policy that those paths are emitted
 * un-normalized. Keying the map on the raw string therefore missed on every
 * entry and silently dropped every purpose. The unit fixtures did not catch it
 * because each used ONE namespace on both sides.
 *
 * Duplicate paths collapse: the reviewer being handed the same file twice is
 * not information the reader needs twice.
 */
export function mergeReadFiles(
  v2Files: string[] | null | undefined,
  summary:
    | { files_with_purpose?: Array<{ path: string; purpose: string }>; file_count?: number }
    | null
    | undefined,
  cwd: string | null,
): ReadFiles {
  const raw = summary?.files_with_purpose ?? [];
  const named = raw.filter((f) => !isTruncationSentinel(f.path));
  const sentinels = raw.length - named.length;

  const purposeByPath = new Map<string, string>();
  for (const f of named) {
    if (f.purpose) purposeByPath.set(redactPath(f.path, cwd), f.purpose);
  }

  const dedupe = (files: ReadFile[]): ReadFile[] => {
    const seen = new Set<string>();
    return files.filter((f) => {
      const key = redactPath(f.path, cwd);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  // The sidecar's list is the one the reviewer was actually handed, so when it
  // exists it is complete by construction and nothing is "unlisted". An EMPTY
  // `changed_files` is treated as absent rather than as "zero files": a sidecar
  // that recorded no list is not a sidecar that recorded an empty diff, and the
  // row below still knows which files there were.
  if (v2Files && v2Files.length > 0) {
    return {
      files: dedupe(
        v2Files.map((path) => ({ path, purpose: purposeByPath.get(redactPath(path, cwd)) ?? null })),
      ),
      unlisted: 0,
    };
  }

  const files = dedupe(named.map((f) => ({ path: f.path, purpose: f.purpose || null })));
  // `file_count` is ground truth — `run-diff-summary.ts` overwrites it with the
  // real `diff --git` header count before appending the sentinel, precisely so
  // the gap stays recoverable when the note itself did not fit under the array
  // cap. Fall back to the sentinel's presence when the count is absent.
  const total = typeof summary?.file_count === "number" ? summary.file_count : 0;
  const unlisted = Math.max(0, total - files.length, sentinels > 0 ? 1 : 0);
  return { files, unlisted: files.length === 0 && total === 0 ? 0 : unlisted };
}

function ChangedFileList({
  files,
  unlisted,
  cwd,
}: {
  files: ReadFile[];
  unlisted: number;
  cwd: string | null;
}) {
  const shown = files.slice(0, 30);
  const overCap = files.length - shown.length;
  return (
    <div
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 10,
        color: tokens.color.ink2,
        background: tokens.color.paper,
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.sm,
        padding: "5px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      {shown.map((f, i) => (
        <span key={i} title={f.path}>
          {redactPath(f.path, cwd)}
          {f.purpose && <span style={{ color: tokens.color.ink3 }}> — {f.purpose}</span>}
        </span>
      ))}
      {overCap > 0 && (
        <span style={{ color: tokens.color.ink3 }}>… and {overCap} more</span>
      )}
      {/* Two different absences, said differently: `overCap` is "this list is
          long", `unlisted` is "the summariser never named these". */}
      {unlisted > 0 && (
        <span style={{ color: tokens.color.ink3 }}>
          … and {unlisted} more the summary did not name
        </span>
      )}
    </div>
  );
}

/**
 * The day the row started carrying the user's own words (`capturedIntentFields`,
 * `src/hooks/handle-stop.ts`). A row stamped before this genuinely predates the
 * write. A row stamped on or after it is NOT proof the update was live when it
 * ran — a date has no hour, and the update reaches each machine when that
 * machine updates — so the later branch names possibilities rather than a cause.
 */
const ROW_QUERY_WIRED_ON = "2026-08-19";

/**
 * Why the user's own words are missing, without asserting a history the page
 * does not know.
 *
 * The first draft said "…and this one is older" unconditionally. `user_raw_query`
 * is null on brand-new rows in at least three reachable ways — an unreadable or
 * missing transcript (`extractTranscriptTurns` returns `[]`), a turn with no
 * user message that survives noise-stripping (`captureIntent` returns null), and
 * `criticPipeline.enabled === false` (the pre-Brain pass never runs, so there is
 * no `capturedIntent` to write). In all three the row was written today and the
 * sentence claimed it predated the wire — the same fixed-sentence defect
 * `src/state/audit-absence.ts` exists to remove, one field over.
 *
 * **The newer branch names no cause either, and that is not hedging.** The date
 * is all this function has, and a row stamped ON the changeover day may simply
 * have run before the update reached that machine. Caught on a real page: the
 * first version of THIS fix said "so this one hit something that stopped it"
 * and rendered it over a row written hours before the code existed. It lists
 * the possibilities and asserts none of them.
 */
function missingQueryNote(timestamp: string): string {
  const predatesWire = timestamp < ROW_QUERY_WIRED_ON;
  return predatesWire
    ? `your own words were not saved with this review — Siltpoke only started storing them on the review's own row on ${ROW_QUERY_WIRED_ON}, and this review is from before that`
    : `your own words were not saved with this review — Siltpoke stores them on every review it files from ${ROW_QUERY_WIRED_ON} on, so either this review ran before that update reached this machine, or something stopped the capture (an unreadable transcript, a turn with no message of yours, or reviews switched off)`;
}

export function BlockA({ v2, c, agentReplyLabel = AGENT_REPLY_LABEL }: BlockAProps) {
  const cwd = c.cwd ?? null;
  const { files, unlisted } = mergeReadFiles(v2?.changed_files, c.diff_summary, cwd);
  // The sidecar wins where it has a value, the row is the fallback. Truthy
  // fallback on purpose for diff_intent: an empty-string diff_intent still
  // falls through to diff_summary.intent, exactly as the old `||` did.
  const diffIntent = v2?.diff_intent || c.diff_summary?.intent || null;
  // `intent` is only a Haiku sentence when Haiku answered. On the heuristic
  // fallback it is a byte-count line ending "(heuristic summary — Haiku
  // unavailable)" — 43 of the 381 no-sidecar rows, 11.3% (snapshot
  // `...-2026-08-19T19Z.txt` §5) — so a fixed "haiku pre-pass" sub-label would
  // sit directly above a sentence saying Haiku was unavailable. The sidecar's
  // own `diff_intent` carries no source field, so it keeps the neutral label.
  const intentFromRow = !v2?.diff_intent && c.diff_summary?.intent;
  const diffIntentLabel =
    intentFromRow && c.diff_summary?.source === "heuristic"
      ? "diff intent (no LLM — counted from the diff)"
      : "diff intent (haiku pre-pass)";
  const userQuery = v2?.user_raw_query || c.user_raw_query || null;
  const agentReply = v2?.agent_reply || c.agent_reply || null;
  // Only claim truncation for the text actually being shown — the row's flag
  // describes the row's copy, which is not what is on screen when the sidecar
  // supplied a longer one.
  const queryTruncated = !v2?.user_raw_query && c.user_raw_query_truncated;

  // The absence note is the WHOLE content only when there is genuinely nothing
  // to show. Printing "no record of what Siltpoke read" above a list of the
  // files it read would be the same defect this block is being fixed for, one
  // line up.
  //
  // The asymmetry with Block C is deliberate but it IS a trade, not a strict
  // improvement: Block C keeps its absence note above a list it always draws,
  // so it still explains why there are no results. Block A drops the note
  // entirely on the ~93% of no-sidecar rows that carry a `diff_summary` — the
  // reader gains the file list and loses the sentence saying why no archive was
  // filed. That reason is still on the page: the row's own evidence mark and
  // Block C carry it.
  const nothingRead =
    files.length === 0 && diffIntent === null && userQuery === null && agentReply === null;
  if (nothingRead) {
    return (
      <AuditSection id="A" label="A · WHAT I READ">
        <PlaceholderNote text={auditAbsenceNote(c.audit_absence, "A")} />
      </AuditSection>
    );
  }

  return (
    <AuditSection id="A" label="A · WHAT I READ">
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <SubLabel>changed files</SubLabel>
        {files.length > 0 ? (
          <ChangedFileList files={files} unlisted={unlisted} cwd={cwd} />
        ) : (
          <PlaceholderNote text="no changed files recorded (older entry or non-code change)" />
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <SubLabel>user raw query (verbatim)</SubLabel>
        {userQuery ? (
          <MonoBlock>{userQuery}</MonoBlock>
        ) : (
          <PlaceholderNote text={missingQueryNote(c.timestamp)} />
        )}
        {queryTruncated && (
          <PlaceholderNote text="long prompt — only the first 2000 characters were stored" />
        )}
      </div>

      {agentReply && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SubLabel>{agentReplyLabel}</SubLabel>
          <MonoBlock>{agentReply}</MonoBlock>
        </div>
      )}

      {diffIntent && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SubLabel>{diffIntentLabel}</SubLabel>
          <MonoBlock>{diffIntent}</MonoBlock>
        </div>
      )}
    </AuditSection>
  );
}

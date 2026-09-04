// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Shared sub-primitives used by every CritiqueAuditBlock (A–F).
 * Extracted from the original CritiqueAuditBlocks.tsx.
 */
import { tokens } from "../../tokens/tokens";
import type { EvidenceLabel } from "../../../critic/evidence-guard";
import { AUDIT_ABSENCE_COPY, type AuditAbsenceKind } from "../../../state/audit-absence";

/**
 * The note shown in place of an audit block that has no data.
 *
 * Was a CONSTANT reading "v2 audit data unavailable — this review pre-dates
 * pipeline wire OR ran on legacy path." — shown for every absence, including on
 * reviews that had run minutes earlier, while the accurate reason sat unread on
 * the same telemetry row. Now keyed on `CriticCall.audit_absence`, which is
 * derived in code from that row (`src/state/audit-absence.ts`).
 *
 * Only the `unrecorded` kind still says anything about pre-dating, and that is
 * asserted by `tests/state/audit-absence.test.ts`.
 */
/**
 * The audit blocks that render a placeholder when they have no data.
 * `E` is excluded on purpose — it degrades field-by-field, not as a whole.
 */
export type AuditBlockId = "A" | "C" | "D";

/**
 * What is missing from THIS block, said in the block's own terms.
 *
 * Without this, `auditAbsenceNote` returned one sentence and all three blocks
 * printed it verbatim, so a review with no v2 sidecar rendered the identical
 * line three times under three different headings — and that line said "the
 * detailed breakdown BELOW", with nothing below it, because the line itself was
 * the whole content. It reads as a copy-paste bug (it was reported as 
 * on a real page).
 *
 * Pre-existing since #607; surfaced now because the 2026-08-19 evidence change
 * routes ~56.5% more reviews through these blocks. Fixed here rather than
 * punted for that reason: this branch is what makes it common.
 */
const MISSING_HERE: Record<AuditBlockId, string> = {
  A: "No record of what Siltpoke read on this turn.",
  // Not "no rubric checklist" any more — the checklist IS drawn now, with a
  // dot on every rule. What is missing is the per-rule RESULT, and saying
  // otherwise would contradict the list rendered directly beneath this line.
  C: "No rule-by-rule result was recorded for this turn, so every check shows a dot rather than a tick or a cross.",
  D: "No record of which signals fed this review.",
};

export function auditAbsenceNote(kind: AuditAbsenceKind, block?: AuditBlockId): string {
  // Defensive lookup, not decoration. The type says this cannot miss, but the
  // type is bypassable: the golden test builds its CriticCall with
  // `as unknown as CriticCall`, and the first re-capture after this field was
  // added produced a golden whose placeholder was BLANK — `AUDIT_ABSENCE_COPY`
  // indexed by `undefined` is `undefined`, and an undefined child renders as
  // nothing at all. A blank note is worse than the wrong sentence it replaces:
  // the wrong one was at least visible. So an unrecognised kind says so out
  // loud rather than vanishing.
  const why =
    AUDIT_ABSENCE_COPY[kind] ??
    "no audit trail, and the reason for it could not be read from this row.";
  // `block` is optional because the Trace tab renders this note with no block
  // of its own — there the bare reason is the whole answer.
  return block ? `${MISSING_HERE[block]} ${why}` : why;
}

export const TIER_LABEL: Record<number, string> = {
  1: "Tier 1 · deterministic",
  2: "Tier 2 · heuristic AST",
  3: "Tier 3 · semantic (not yet implemented)",
};

// Shared "eyebrow" label style for a sub-block heading WITHIN an
// AuditSection (e.g. BlockA's "changed files" / "user raw query", BlockD's
// "signal sources" / "preference history"). Every block used to repeat this
// style object inline — one canonical version + a SubLabel wrapper instead.
export const subLabelStyle = {
  fontFamily: tokens.font.mono,
  fontSize: 9,
  color: tokens.color.ink3,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
} as const;

export function SubLabel({ children }: { children: import("hono/jsx").Child }) {
  return <span style={subLabelStyle}>{children}</span>;
}

/**
 * The "you cannot fully trust this one" strip that sits above a review.
 *
 * This exists because of what the 2026-08-19 evidence-guard change costs: the
 * guard used to delete an unverifiable review, and now it shows it. Showing it
 * without saying so would trade a review the user never sees for a review the
 * user wrongly believes was checked — the worse of the two failures. So the
 * mark is not decoration on the change; it is the half that makes the change
 * safe, and its absence is the regression to watch for.
 *
 * Deliberately plain SSR — no Alpine, no `x-show`, no `display:none` start
 * state. A previous visible-marker slice in this repo shipped an island that
 * was never registered: unit, SSR and route tests were all green while the
 * line rendered `display:none` on every real page, and only an e2e
 * `toBeVisible` caught it. There is nothing here for that failure to hide in.
 */
export function EvidenceMark({
  label,
  unverifiedCount,
}: {
  /**
   * `CriticCall.evidence_label` — `null` on any row that has no recorded
   * answer, which renders nothing. Keyed on this rather than on
   * `audit_absence`: that union is rendered inside empty audit blocks, so a
   * value about dropped citations would be printed as the explanation for a
   * rubric checklist with no results (caught in review).
   */
  label: EvidenceLabel | null;
  /** Items dropped as unverifiable. 0 for `no_evidence` (nothing was cited). */
  unverifiedCount: number;
}) {
  if (label === null || label === "verified" || label === "not_checked") return null;
  // A count of zero alongside a label that promises dropped citations is a
  // contradiction, not a caveat — "0 quotes were dropped" is noise on a review
  // that is fine. Unreachable from today's writer (both fields are written
  // together) but `unverifiedCountOf` coerces any absent or malformed value to
  // 0, so a truncated row can produce it.
  if (label !== "no_evidence" && unverifiedCount < 1) return null;

  // Four sentences, not one template with switches bolted on. The first draft
  // built every case from one string and produced "1 quote … — that was all of
  // them", which reads as a bug; n=1 is the commonest real `none_verified` (a
  // review cites one line and that line cannot be confirmed), so it is the
  // sentence most users would have seen. Writing each case out is longer and
  // is the only version that reads like English in all four.
  const detail =
    label === "no_evidence"
      ? "this review does not point at any line of your code"
      : label === "none_verified"
        ? unverifiedCount === 1
          ? "the only line this review quotes could not be found in the code Siltpoke was given to read, so it was dropped — nothing here is confirmed"
          : `none of the ${unverifiedCount} lines this review quotes could be found in the code Siltpoke was given to read, so all of them were dropped — nothing here is confirmed`
        : unverifiedCount === 1
          ? "1 quote could not be found in the code Siltpoke was given to read, and it was dropped"
          : `${unverifiedCount} quotes could not be found in the code Siltpoke was given to read, and they were dropped`;

  return (
    <div
      data-evidence-mark={label}
      data-unverified-count={String(unverifiedCount)}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        flexWrap: "wrap",
        fontFamily: tokens.font.body,
        fontSize: 11,
        lineHeight: 1.5,
        color: tokens.color.ink2,
        background: `color-mix(in srgb, ${tokens.color.amber} 9%, transparent)`,
        border: `1px solid ${tokens.color.amber}`,
        borderRadius: tokens.radius.sm,
        padding: "6px 10px",
      }}
    >
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontWeight: 600,
          color: tokens.color.amber,
          flexShrink: 0,
        }}
      >
        unconfirmed
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{detail}</span>
    </div>
  );
}

/**
 * "This review was not shown all of your diff."
 *
 * A sibling of `EvidenceMark`, and deliberately a SEPARATE component: that one
 * answers "could the quotes in this review be confirmed", this one answers
 * "how much of the change did the reviewer even see". A review can be fully
 * grounded in the quarter of the diff it was handed.
 *
 * The numbers are siltpoke's own count, not the reviewer's. The prompt does ask
 * the reviewer to state its coverage in `reasoning`, and nothing verifies that
 * it did (`schema.ts` has `reasoning` optional on the path that runs) — so a
 * mark the user can trust cannot depend on the model having complied.
 *
 * Renders nothing when the whole diff fitted, and nothing on rows written
 * before 2026-08-20, which carry no counts. Those two are indistinguishable
 * from a row, so silence here means "no claim", never "full coverage".
 */
export function PartialDiffMark({
  shown,
  total,
}: {
  shown: number | null;
  total: number | null;
}) {
  if (shown === null || total === null) return null;
  if (total <= shown || shown <= 0) return null;

  return (
    <div
      data-partial-diff="true"
      data-diff-shown={String(shown)}
      data-diff-total={String(total)}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        flexWrap: "wrap",
        fontFamily: tokens.font.body,
        fontSize: 11,
        lineHeight: 1.5,
        color: tokens.color.ink2,
        background: `color-mix(in srgb, ${tokens.color.amber} 9%, transparent)`,
        border: `1px solid ${tokens.color.amber}`,
        borderRadius: tokens.radius.sm,
        padding: "6px 10px",
      }}
    >
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontWeight: 600,
          color: tokens.color.amber,
          flexShrink: 0,
        }}
      >
        partial diff
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        {`Siltpoke showed this review ${shown} of the ${total} changed hunks — it did not see the rest of your change.`}
      </span>
    </div>
  );
}

export function AuditSectionHead({ label, note }: { label: string; note?: string }) {
  return (
    <div
      style={{
        paddingBottom: 6,
        borderBottom: `1px dashed ${tokens.color.edge}`,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
      }}
    >
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: tokens.color.ink2,
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      {note && (
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 9,
            color: tokens.color.ink3,
          }}
        >
          {note}
        </span>
      )}
    </div>
  );
}

export function AuditSection({
  id,
  label,
  note,
  children,
}: {
  id: string;
  label: string;
  note?: string;
  children: import("hono/jsx").Child;
}) {
  return (
    <div
      data-audit-block={id}
      style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 10 }}
    >
      <AuditSectionHead label={label} note={note} />
      {children}
    </div>
  );
}

export function PlaceholderNote({ text }: { text: string }) {
  return (
    <div
      style={{
        fontFamily: tokens.font.body,
        fontSize: 11,
        color: tokens.color.ink3,
        fontStyle: "italic",
        lineHeight: 1.55,
      }}
    >
      {text}
    </div>
  );
}

export function MonoBlock({ children }: { children: import("hono/jsx").Child }) {
  return (
    <pre
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 10,
        color: tokens.color.ink2,
        background: tokens.color.paper,
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.sm,
        padding: "6px 10px",
        margin: 0,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        lineHeight: 1.55,
      }}
    >
      {children}
    </pre>
  );
}

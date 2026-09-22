// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { z } from "zod";

// Evidence item schema.
export const evidenceItemSchema = z.object({
  tool: z.enum(["tsc", "eslint", "git-diff", "ripgrep", "rubric"]),
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  snippet: z.string().min(10).max(240),
});

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const moodEnum = z.enum([
  "happy",
  "annoyed",
  "concerned",
  "watching",
  "sleeping_quiet",
  "sleeping_broke",
  "idle",
  "excited",
  "tired",
]);

export const poseEnum = z.enum([
  "base",
  "peek",
  "blink",
  "arms_crossed",
  "shrug",
  "wave",
  "stretch",
  "zen",
]);

export const severityEnum = z.enum(["info", "low", "medium", "high"]);
export const confidenceEnum = z.enum(["low", "medium", "high"]);

/**
 * The seven semantic judgements a review can be about.
 *
 * These are not new — `schema-v2.ts` has declared exactly this list since it was
 * written. What was new is that nothing reachable used it: production parses v1,
 * and v1 had no `category`, so the taxonomy existed and could not arrive. Kept
 * as one shared constant rather than a second copy, so the two cannot drift.
 */
export const categoryEnum = z.enum([
  "correctness", "security", "design", "tests", "readability", "performance", "consistency",
]);

/**
 * Did the reviewer actually run the check that could have disproved its own
 * finding?
 *
 * Deliberately three-valued, not a boolean. `not-possible-from-the-diff` is the
 * honest answer for the failure this exists to catch — 22 of the 24 false
 * findings in the 2026-08-21 corpus asserted something about code the diff did
 * not contain — and without a truthful middle option the model is pushed to pick
 * a side it has no basis for. A boolean here would also be an LLM-generated
 * boolean standing in for a judgement, which is the shape this codebase treats
 * as untrusted by default.
 */
export const refutationCheckedEnum = z.enum(["yes", "no", "not-possible-from-the-diff"]);

/**
 * One discrete finding.
 *
 * FIVE FIELDS, AND THE COUNT IS THE POINT. Everything else a finding carries by
 * the time a reader sees it — its `id`, and in later slices its line range, its
 * provenance tier and its identity hash — is derived by code AFTER this parses.
 * None of it may be declared here, because `z.toJSONSchema(brainOutputSchema)`
 * is handed to OpenAI strict mode (`providers/codex.ts`), where every declared
 * property becomes one the model MUST emit. A derived field declared here is a
 * field the model authors, which is the same failure
 * `stripSystemAuthoredFields` exists to stop for `truncated`/`repaired`: an
 * honesty signal the subject can forge is worse than no signal, because it is
 * believed.
 *
 * `quote` shares `SNIPPET_CAP` and the same `truncStr` path as
 * `evidenceItemSchema.snippet` deliberately. The guard recognises a trimmed
 * quote by the `…` this layer leaves behind (`evidence-guard.ts` `quotedText`);
 * a quote shortened any other way can never match the corpus, so it would land
 * as an unverifiable citation for a reason that is ours, not the model's.
 */
export const modelFindingSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(600),
  severity: severityEnum,
  file: z.string().min(1),
  quote: z.string().min(10).max(240),
  /**
   * Where the model THINKS this quote sits in the file. A hint, and nothing a
   * renderer ever reads.
   *
   * Named `claimed_` and not `start_line` on purpose. Code derives its own
   * range in the guard and that one is what gets persisted; if both were called
   * `start_line`, forgetting to strip the model's copy once would put a number
   * the reviewer wrote for itself in front of a reader with nothing to say so,
   * and nothing anywhere would go red. Under these names a leak is a visibly
   * wrong key.
   *
   * Optional, which under the provider's strict schema means a null-union that
   * `stripNulls` removes before zod sees it — the same shape
   * `evidenceItemSchema.line` has been running in since it was written
   * (`providers/codex.ts`, pinned by `tests/brain/providers/codex.test.ts`).
   * NOT `.nullable()`: that one `stripNulls` swallows silently.
   */
  claimed_start_line: z.number().int().positive().optional(),
  claimed_end_line: z.number().int().positive().optional(),
});

/** What the model authors, hints included. */
export type ModelFinding = z.infer<typeof modelFindingSchema>;

/**
 * What a finding looks like ON DISK — which is not the same contract as what
 * the model must emit, and the two stopped being conflated.
 *
 * The zod schema above answers one question: which keys does the provider
 * require of the model. This type answers a different one: which keys can a
 * `.json` sidecar hold. Four of them are written by code after the model is
 * done, and none may be declared in zod — anything declared there is handed to
 * the provider's strict schema and becomes a key the model must fill, which for
 * `quote_tier` would mean the reviewer grading its own provenance.
 *
 * An earlier rule said the opposite ("a field present at runtime but absent
 * from the schema is a type that lies"), and it was right about `id`: an id is the
 * array position, so re-deriving it at render costs nothing and storing it buys
 * nothing. It does not hold for the rest. A tier or a line range needs the
 * citation corpus to compute, and rendering happens in the daemon, reading a
 * sidecar that may be weeks old, with no corpus anywhere. Not persisting them
 * means the dashboard can never show them.
 *
 * EVERY ADDED FIELD IS OPTIONAL, and that is honesty rather than convenience:
 * a critique written before this slice genuinely has none of them, and
 * `loadSidecar` hands those files back unvalidated. A required field here would
 * be a type that lies in the other direction.
 */
export type PersistedFinding = ModelFinding & {
  id?: string;
  /** Absent means the guard never checked this finding — NOT that it is weak. */
  quote_tier?: "strong" | "weak";
  range_source?: "hunk" | "unanchored" | "stale_block" | "not_located" | "unchecked";
  start_line?: number;
  end_line?: number;
};

/**
 * A finding on its way out: the guard's own range and tier attached, and the
 * model's two hints GONE.
 *
 * The `Omit` is load-bearing, not tidiness. `Q3` requires the model's guess to
 * be telemetry and never something a renderer can read, and the write path is
 * `JSON.stringify` of the whole output (`state/critique.ts`) — so the only
 * moment the hints can be removed is before that, and this type is what says
 * they were. A `Finding` still satisfies `PersistedFinding`, so nothing
 * downstream needs to know which one it holds.
 */
export type Finding = Omit<PersistedFinding, "claimed_start_line" | "claimed_end_line"> & {
  id: string;
};

export const brainOutputSchema = z.object({
  mood: moodEnum,
  pose: poseEnum,
  critique_for_claude: z.string(),
  severity: severityEnum,
  confidence: confidenceEnum,
  xp_earned_events: z.array(
    z.object({
      type: z.string(),
      amount: z.number().int().nonnegative(),
    }),
  ),
  // Evidence array — additive, defaults to [] so existing critique files
  // without this field still parse correctly.
  // Zod 4 chain semantics: .max(5) constrains explicit input arrays; .default([])
  // fires only when the field is absent — orders are independent, both apply.
  evidence: z.array(evidenceItemSchema).max(5).default([]),

  /**
   * The discrete findings. Additive and defaulted, so every critique already on
   * disk still parses (AC9).
   *
   * NO `.max()` HERE, AND THAT IS DELIBERATE. A `.max()` on the declaration
   * REJECTS — it fails the parse and takes the whole review with it, which is
   * exactly the `evidence: too_big` incident recorded below: a diff carrying
   * seven planted defects failed 3 of 3, twice, four weeks apart. The ceiling
   * is applied in `coerceBrainOutputShape`, which TRIMS instead, and reports
   * what it cut in `truncated.findings`.
   */
  findings: z.array(modelFindingSchema).default([]),

  // ── The bubble sits AFTER `findings`, and the order is load-bearing ────────
  // Zod preserves declaration order, `z.toJSONSchema` preserves Zod's, and the
  // strict schema handed to the provider preserves that — so this is the order
  // the model generates in. The bubble is a REACTION to the findings; written
  // before them it is a reaction to nothing, and the findings then have to
  // agree with a verdict that was already committed to.
  bubble_short: z.string().min(1).max(200),
  bubble_long: z.string().max(2000),
  // Brain explains WHY it chose this severity + whether it wrote a
  // critique. Surfaced on the /history expand panel so the user can see the
  // model's decision trace, not just the final bubble. Optional + bounded
  // so older entries (and test fixtures) without this field still parse.
  reasoning: z.string().max(800).optional(),

  // The three semantic fields (P1).
  //
  // All optional for the same reason `reasoning` above is: every critique file
  // already on disk was written before they existed, and those files are read
  // back by the dashboard, the memory extractor and the eval arms.
  //
  // They have to live in the SCHEMA, not only in the prompt: this object has no
  // `.strict()`, so Zod strips unknown keys silently. Asking the model for a
  // `category` without declaring it here would produce a model that answers and
  // a parser that throws the answer away — designed, and unreachable, which is
  // the exact defect this change exists to close.
  category: categoryEnum.optional(),
  /** The observation that would show this finding is wrong. */
  what_would_refute: z.string().max(200).optional(),
  /** Whether that observation was actually looked for. */
  refutation_checked: refutationCheckedEnum.optional(),

  /**
   * How much each capped field lost to its own cap, keyed by field name. Absent
   * (never an empty object) means nothing was dropped, so its presence always
   * carries information.
   *
   * Array fields report ENTRIES dropped; string fields report CHARACTERS dropped.
   *
   * It lives in its own field rather than as a marker inside the data, for the
   * reason `run-diff-summary.ts` records at length: a marker entry inside an array
   * makes every downstream `.length` and `slice(0, N)` silently wrong. The honesty
   * signal must not be able to masquerade as content.
   */
  truncated: z.record(z.string(), z.number().int().positive()).optional(),

  /**
   * Where the model's own value is NOT what stands in this object, one entry
   * per place. Two forms, both naming the field first:
   *
   *     "pose"                                     a fallback replaced it
   *     "evidence.1: file: invalid_type (received number)"   the item was dropped
   *
   * Separate from `truncated` because the two are different events and one
   * number cannot carry both: `truncated` counts what was LOST off the end of a
   * value that survived, while an entry here means the model's value is gone
   * altogether. Collapsing them would let a reader who checks `truncated`
   * conclude the field is the model's own words.
   *
   * TYPES ONLY, NEVER VALUES. A value is model-written content, and this array
   * is an honesty signal; the same note on `truncated` above explains why the
   * two must not be able to masquerade as each other.
   *
   * Absent, never an empty array — so its presence always carries information,
   * the same contract `truncated` keeps.
   */
  repaired: z.array(z.string()).optional(),
});

export type BrainOutput = Omit<z.infer<typeof brainOutputSchema>, "findings"> & {
  /**
   * WIDENED AT THE TYPE LEVEL ONLY — the zod schema above is untouched, and
   * `z.toJSONSchema` therefore hands the provider exactly the keys it always
   * did.
   *
   * Without this, the fields the guard derives are invisible where they are
   * needed: `buildFindingsSection` takes a `BrainOutput` and reads
   * `out.findings`, so a tier computed in the guard would typecheck into the
   * object and then be unreachable at the only place that renders it. The two
   * shortcuts are both wrong — a cast is a type that lies, and declaring the
   * fields in zod lets the model author its own provenance.
   */
  findings: PersistedFinding[];
};

/**
 * Caps declared by `brainOutputSchema` above, kept beside the coercion so a cap
 * change and its arithmetic stay one edit apart.
 */
const STRING_CAPS = {
  bubble_short: 200,
  bubble_long: 2000,
  reasoning: 800,
  what_would_refute: 200,
} as const;
const EVIDENCE_CAP = 5;
/**
 * The findings ceiling. Five, not the three the prompt asks for: the prompt
 * number steers the model, this number is the wall, and they are deliberately
 * different so that a model returning four is trimmed at the prompt's intent
 * rather than cut at the wall. Overflow is reported in `truncated.findings`.
 */
const FINDINGS_CAP = 5;
const FINDING_TITLE_CAP = 120;
const FINDING_BODY_CAP = 600;
/**
 * Exported because the evidence guard has to recognise the shape this layer
 * leaves behind: a snippet cut to exactly this length, ending in `…`. The `…`
 * is siltpoke's, not the reviewer's, and the corpus never contains it.
 */
export const SNIPPET_CAP = 240;

function truncStr(v: string, max: number): string {
  return v.length <= max ? v : `${v.slice(0, max - 1)}\u2026`;
}

/**
 * Bring an over-cap response back inside its caps instead of letting the parse
 * throw the whole thing away.
 *
 * WHY THIS EXISTS, MEASURED NOT ASSUMED. A diff with seven planted defects fails
 * 3 of 3 with `evidence: too_big` — twice, four weeks apart (#481 on 2026-08-03,
 * again on 2026-08-31), with everything shipped in between leaving the wall
 * untouched. The findings live in `critique_for_claude`, a string that was never
 * over its cap; what overflowed was the CITATION COUNT. So the review was
 * discarded over five-versus-seven citations, and a critic that finds more
 * reports nothing — an outcome the reader cannot tell apart from finding nothing.
 * #481's own headline, "reported count saturates at 4-5", was this cap seen from
 * the outside without being named.
 *
 * EVERY LENGTH CAP, NOT ONLY THE TWO THAT WERE SEEN TO FIRE. `evidence` and
 * `reasoning` are the observed cases; the defect is the CLASS — any cap rejecting
 * the whole answer — and this repo's most productive audit move is to find a
 * defence that exists once and hunt the sibling paths that dropped it.
 *
 * FLOORS ARE NOT COERCED, DELIBERATELY. `.min()` violations still reject:
 * shortening an over-long value discards model output, while lengthening an
 * under-long one would invent content. A test pins this so the residual is
 * visible rather than discovered.
 */
export function coerceBrainOutputLengths(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const o = raw as Record<string, unknown>;
  const next: Record<string, unknown> = { ...o };
  const truncated: Record<string, number> = {};

  for (const [field, cap] of Object.entries(STRING_CAPS)) {
    const v = o[field];
    if (typeof v === "string" && v.length > cap) {
      next[field] = truncStr(v, cap);
      truncated[field] = v.length - cap;
    }
  }

  // NOTE: `evidence` is handled ENTIRELY in `coerceBrainOutputShape`, not here.
  // Trimming a snippet, dropping a malformed item and applying the 5-item cap
  // have to happen in that ORDER, and splitting them across two functions is
  // what produced the defect two independent reviews found on 2026-09-01: the
  // cap ran first, so a reply whose first two citations were malformed came
  // back with 3 of its 5 good ones — the cap had already thrown the other two
  // away before anything looked at shape.

  // Absent, never an empty object — so the field's presence always means something
  // was actually dropped.
  if (Object.keys(truncated).length > 0) next.truncated = truncated;
  return next;
}

/**
 * The same principle as `coerceBrainOutputLengths`, moved from LENGTH to SHAPE:
 * a malformed PART must drop the part, not the whole answer.
 *
 * WHY THIS EXISTS, MEASURED NOT ASSUMED. Of 36 brain failures recorded in
 * `~/.siltpoke/traces/` since 2026-08-25, 33 were schema rejections. The length
 * coercion above covers the two largest issue classes — `evidence[].snippet:
 * too_big` (19) and `reasoning: too_big` (12). The residue it does not reach is
 * `evidence.N.file: invalid_type` (4), `evidence.N.line: invalid_type` (1),
 * `bubble_short: too_small` (1), `pose: invalid_value` (1), and
 * `critique_for_claude: invalid_type` (2).
 *
 * EVERY REPAIR HERE IS VALUE-AGNOSTIC, DELIBERATELY. #699 installed the probe
 * that records a rejected reply, and it had captured nothing when this was
 * written — so no branch below is written against an observed value. An evidence
 * item is dropped because it fails its own schema, whatever it holds; a cosmetic
 * field falls back because it is out of range, whatever it held.
 *
 * WHAT IS DELIBERATELY NOT REPAIRED, and why each exclusion is a decision rather
 * than an oversight:
 *
 * - `critique_for_claude` — the payload. Whether the right move is to join an
 *   array, to stringify, or to give up depends on what actually arrives, and
 *   that is exactly the question the probe exists to answer. Guessing it here
 *   would be the mistake #699's commit message warns against by name.
 * - `severity`, `confidence`, `category`, `refutation_checked` — a fallback on
 *   any of these invents a JUDGEMENT, which is a different act from replacing a
 *   face. They keep rejecting, for the same reason the length pass refuses to
 *   lengthen an under-long value.
 * - A non-array `evidence` — dropping bad ITEMS is this function's job;
 *   fabricating the container would hide a different failure entirely.
 *
 * The `mood` fallback is derived from `severity` rather than fixed, because the
 * one direction that must never happen is a calm face on a serious review: that
 * understates the finding, and the reader has no way to tell it was a fallback.
 */
/**
 * The TYPE a rejected field arrived as — never the value.
 *
 * This exists because the repair below has a cost that has to be paid back
 * somewhere. #699 installed a probe that records a rejected reply, and the
 * classes it was installed to observe are exactly the ones this function now
 * repairs — so after this change those replies parse, the probe never fires on
 * them, and the open question ("would coercing a number to a string have SAVED
 * the citation instead of dropping it?") would lose its only source of data.
 * Recording the received type answers that question without waiting, and
 * without the value: a value is model-written content, and this array is an
 * honesty signal, so letting content in would be the very confusion the
 * `truncated` field's own note warns about.
 */
function describeFirstIssue(err: unknown, item: unknown): string {
  const issues = (err as { issues?: unknown } | null)?.issues;
  const first = Array.isArray(issues) ? issues[0] : undefined;
  const rec = (typeof first === "object" && first !== null ? first : {}) as {
    path?: unknown;
    code?: unknown;
  };
  const path = Array.isArray(rec.path) && rec.path.length > 0 ? rec.path.join(".") : "(item)";
  const code = typeof rec.code === "string" ? rec.code : "invalid";
  const at =
    Array.isArray(rec.path) && rec.path.length === 1 && typeof item === "object" && item !== null
      ? (item as Record<string, unknown>)[String(rec.path[0])]
      : item;
  return `${path}: ${code} (received ${typeName(at)})`;
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function coerceBrainOutputShape(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const o = raw as Record<string, unknown>;
  const next: Record<string, unknown> = { ...o };
  const repaired: string[] = [];
  // The length pass runs first and may already have written here, so this
  // merges rather than replaces — otherwise a shape repair would silently erase
  // the record of a truncation that happened on the same response.
  const truncated: Record<string, number> =
    o.truncated !== null && typeof o.truncated === "object"
      ? { ...(o.truncated as Record<string, number>) }
      : {};

  // Drop the citations that do not satisfy their own schema, keep the rest. An
  // all-bad list degrades to `evidence: []`, which is a state the pipeline
  // already handles — `evidence-guard.ts` labels it `no_evidence` and shows the
  // review anyway (2026-08-19) — rather than into silence.
  // THE ORDER IS THE POINT, and it is why all three steps live here rather than
  // half of them in the length pass above.
  //
  //   1. trim  — an over-long snippet is shortened, so length alone never
  //              disqualifies a citation;
  //   2. drop  — what still fails its own schema is thrown away, whatever it
  //              holds;
  //   3. cap   — the 5-item ceiling applies to what is LEFT.
  //
  // Capping before dropping loses good citations to bad ones: measured on this
  // file, seven citations whose first two were malformed came back with THREE
  // survivors, because items 5 and 6 had already been sliced off before
  // anything looked at shape. Two independent cross-family reviews found it.
  if (Array.isArray(o.evidence)) {
    const items: unknown[] = o.evidence;
    const trimmed = items.map((item) => {
      if (item === null || typeof item !== "object") return item;
      const it = item as Record<string, unknown>;
      return typeof it.snippet === "string" && it.snippet.length > SNIPPET_CAP
        ? { ...it, snippet: truncStr(it.snippet, SNIPPET_CAP) }
        : it;
    });

    const survivors: { item: unknown; index: number }[] = [];
    for (const [index, item] of trimmed.entries()) {
      const verdict = evidenceItemSchema.safeParse(item);
      if (verdict.success) {
        survivors.push({ item, index });
        continue;
      }
      repaired.push(`evidence.${index}: ${describeFirstIssue(verdict.error, item)}`);
    }
    const malformed = trimmed.length - survivors.length;

    const kept = survivors.slice(0, EVIDENCE_CAP);
    // Only a citation that survives BOTH the drop and the cap can be said to
    // have "lost characters off its end". One thrown away whole is reported by
    // `evidence_malformed` / `evidence`; counting it here too would leave
    // `truncated.evidence_snippets` describing a value that is gone — the exact
    // kind of lie this whole function exists to stop.
    const droppedSnippetChars = kept.reduce((sum: number, { index }) => {
      const original = (items[index] as Record<string, unknown> | null)?.snippet;
      return typeof original === "string" && original.length > SNIPPET_CAP
        ? sum + (original.length - SNIPPET_CAP)
        : sum;
    }, 0);

    next.evidence = kept.map((k) => k.item);
    if (malformed > 0) truncated.evidence_malformed = malformed;
    if (survivors.length > EVIDENCE_CAP) truncated.evidence = survivors.length - EVIDENCE_CAP;
    if (droppedSnippetChars > 0) truncated.evidence_snippets = droppedSnippetChars;
  }

  // Findings get the SAME three steps in the SAME order, for the same reason the
  // block above spells out. This is a sibling of that defence, not a new one —
  // the failure it guards (a cap that rejects instead of trimming) has fired in
  // this file twice, and the second time was four weeks after the first.
  //
  //   1. trim  — `title` / `body` / `quote` shortened, so length alone never
  //              disqualifies a finding;
  //   2. drop  — what still fails its own schema goes, one item at a time;
  //   3. cap   — the ceiling applies to what is LEFT.
  //
  // `quote` is trimmed through `truncStr` at `SNIPPET_CAP`, the same path and
  // the same cap the evidence snippets use, because the guard identifies a
  // trimmed citation by the `…` this leaves behind.
  if (Array.isArray(o.findings)) {
    const items: unknown[] = o.findings;
    let claimedMalformed = 0;
    const trimmed = items.map((item) => {
      if (item === null || typeof item !== "object") return item;
      const it = { ...(item as Record<string, unknown>) };
      if (typeof it.title === "string" && it.title.length > FINDING_TITLE_CAP) {
        it.title = truncStr(it.title, FINDING_TITLE_CAP);
      }
      if (typeof it.body === "string" && it.body.length > FINDING_BODY_CAP) {
        it.body = truncStr(it.body, FINDING_BODY_CAP);
      }
      if (typeof it.quote === "string" && it.quote.length > SNIPPET_CAP) {
        it.quote = truncStr(it.quote, SNIPPET_CAP);
      }
      // A BAD HINT MUST NOT COST THE FINDING.
      //
      // The loop below drops any item `modelFindingSchema` refuses, whole. So a
      // model answering `"42"`, `3.5`, `-1` or `0` for a line it was only ever
      // asked to GUESS at would take a real finding down with it — the
      // reviewer's most valuable output destroyed by its least valuable field.
      // Scrubbing here, before the parse, keeps the finding and loses only the
      // guess. `0` is the quiet one: it looks like a line number and is refused
      // by `.positive()`, because a file's first line is 1.
      for (const key of ["claimed_start_line", "claimed_end_line"] as const) {
        const v = it[key];
        if (v === undefined) continue;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
          // COUNTED, not silently dropped. The agreement tally downstream can
          // only see a missing hint, and would read a scrubbed `"41"` as the
          // reviewer declining to guess — which turns the one number this slice
          // measures into something that cannot be attributed. This counter is
          // what tells the two apart.
          claimedMalformed += 1;
          delete it[key];
        }
      }
      return it;
    });

    const survivors: unknown[] = [];
    for (const [index, item] of trimmed.entries()) {
      const verdict = modelFindingSchema.safeParse(item);
      if (verdict.success) {
        survivors.push(item);
        continue;
      }
      repaired.push(`findings.${index}: ${describeFirstIssue(verdict.error, item)}`);
    }
    const malformed = trimmed.length - survivors.length;

    next.findings = survivors.slice(0, FINDINGS_CAP);
    if (malformed > 0) truncated.findings_malformed = malformed;
    if (claimedMalformed > 0) truncated.claimed_line_malformed = claimedMalformed;
    if (survivors.length > FINDINGS_CAP) truncated.findings = survivors.length - FINDINGS_CAP;
  }

  if (!poseEnum.safeParse(o.pose).success) {
    next.pose = "base";
    repaired.push("pose");
  }

  if (!moodEnum.safeParse(o.mood).success) {
    next.mood = o.severity === "high" || o.severity === "medium" ? "concerned" : "watching";
    repaired.push("mood");
  }

  // The bubble is what the pet says; the findings live in `critique_for_claude`.
  // Losing a review because the speech balloon came back empty is the same
  // defect this file's other half exists to close.
  if (typeof o.bubble_short !== "string" || o.bubble_short.length === 0) {
    const source = [o.bubble_long, o.critique_for_claude].find(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    // No source means the response has nothing to say anywhere. Rejecting is
    // then the honest outcome; a bubble is not invented out of nothing.
    if (source !== undefined) {
      next.bubble_short = truncStr(source, STRING_CAPS.bubble_short);
      repaired.push("bubble_short");
    }
  }

  if (Object.keys(truncated).length > 0) next.truncated = truncated;
  if (repaired.length > 0) next.repaired = repaired;
  return next;
}

/**
 * `truncated` and `repaired` are written by this file and by nothing else.
 *
 * Both are declared on `brainOutputSchema`, which means a model can emit them —
 * and a model-emitted `truncated: { evidence: 9 }` would be indistinguishable
 * from the real thing on every surface that reads it. An honesty signal that
 * the subject can forge is worse than no signal, because it is believed.
 *
 * Stripping is safe because every caller of `parseBrainOutput` is parsing a
 * MODEL REPLY — the four providers, `parse-raw.ts` and `brain.ts`. Nothing reads
 * a persisted critique back through this path, so there is no stored record for
 * this to erase. It also closes the `truncated: {}` case, where an empty object
 * from the model would break the "absent, never empty" contract both fields
 * document.
 */
function stripSystemAuthoredFields(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { truncated: _t, repaired: _r, ...rest } = raw as Record<string, unknown>;
  return rest;
}

export function parseBrainOutput(raw: unknown): BrainOutput {
  return brainOutputSchema.parse(
    coerceBrainOutputShape(coerceBrainOutputLengths(stripSystemAuthoredFields(raw))),
  );
}

/**
 * Lives here, not beside either thrower, because there are TWO sites that can raise a schema failure, not one.
 * `brainOutputFromText` below appends this detail; `callBrain` in `brain.ts`
 * raised the same failure with none of it, so half the class stayed
 * undiagnosable after #647 was supposed to have closed it. The paid A/B on
 * 2026-08-25 hit that half three times and its log says only "Brain response
 * failed schema validation" — on a run that cost money.
 */
export function describeSchemaIssues(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const issues = (err as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return "";

  const MAX_NAMED = 8;
  const named = issues.slice(0, MAX_NAMED).map((issue) => {
    const rec = (typeof issue === "object" && issue !== null ? issue : {}) as {
      path?: unknown;
      code?: unknown;
    };
    const path =
      Array.isArray(rec.path) && rec.path.length > 0 ? rec.path.join(".") : "(root)";
    const code = typeof rec.code === "string" ? rec.code : "invalid";
    return `${path}: ${code}`;
  });
  const hidden = issues.length - named.length;
  return ` — ${named.join(", ")}${hidden > 0 ? ` (+${hidden} more)` : ""}`;
}

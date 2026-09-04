// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Diff summary pre-pass — calls Haiku to digest a raw git diff into a
 * structured summary that the main Brain critic can read instead of
 * the raw (often truncated) diff body.
 *
 * Why: Brain's prompt was being stuffed with `git log -p` output that
 * the model couldn't fully consume, leading to 
 * comments even when concrete changes existed. A Haiku pass turns the
 * diff into a digest Brain can reason about: intent / key changes /
 * risks / per-file purpose.
 *
 * Output JSON shape is also surfaced on /critic so the user sees the
 * digest alongside the colorized diff.
 */
import { z } from "zod";
import { BrainError, type BrainUsage, type CallBrainOptions, callBrainRaw, resolveBrainTimeoutMs } from "../../brain/brain";

export const diffSummarySchema = z.object({
  intent: z.string().max(600),
  key_changes: z.array(z.string().max(300)).max(8),
  risks: z.array(z.string().max(300)).max(6).default([]),
  /**
   * Total distinct files in the diff, including tests/docs/config.
   * Haiku is required to populate this. files_with_purpose.length should
   * match — when it doesn't, the dashboard surfaces a warning so the
   * user knows the summary is incomplete.
   */
  file_count: z.number().int().min(0).default(0),
  files_with_purpose: z
    .array(
      z.object({
        path: z.string().max(300),
        purpose: z.string().max(160),
      }),
    )
    .max(40)
    .default([]),
  /**
   * Provenance tag — "haiku" for the LLM-produced summary, "heuristic"
   * for the no-LLM TS fallback used when Haiku fails. Dashboard renders
   * a subtle tag so the user knows the digest is degraded.
   */
  source: z.enum(["haiku", "heuristic"]).default("haiku"),
  /**
   * How many entries each array lost to its own cap, keyed by field. Absent key
   * (or 0) means nothing was dropped.
   *
   * This lives in its OWN field, deliberately, instead of as a marker entry
   * inside the arrays. A marker inside the array makes every `.length` and every
   * `slice(0, N)` downstream silently wrong — an independent review of the first
   * version of this fix found three such readers in two files, including one that
   * rendered `${risks.length} risks flagged` into the pet bubble, so a truncated
   * summary told the user "6 risks" when 5 were real and the 6th was the marker.
   * That is the exact "signal decoupled from reality" shape (`docs/lessons.md` L3)
   * this truncation exists to avoid, so the honesty signal must not be able to
   * masquerade as content.
   *
   * Same conclusion, reached independently from prior art:
   * an internal design note — SARIF keeps "was
   * this evaluated" in `result.kind`, separate from the finding itself.
   *
   * `.optional()` rather than `.default({})` on purpose: a default would make the
   * field REQUIRED on the output type, forcing every hand-built `DiffSummary`
   * (the two `heuristicDiffSummary` constructors, every test fixture) to carry a
   * `truncated: {}` that says nothing. Absent reads as "nothing was dropped",
   * which is the same thing `{}` says, and summaries persisted before this field
   * existed keep parsing either way.
   */
  truncated: z
    .object({
      key_changes: z.number().int().positive().optional(),
      risks: z.number().int().positive().optional(),
      files_with_purpose: z.number().int().positive().optional(),
    })
    .optional(),
});

export type DiffSummary = z.infer<typeof diffSummarySchema>;

export const SYSTEM_PROMPT = `You are a code-diff summarizer. Read the unified diff or \`git log -p\` output below and emit ONE JSON object with this shape:

{
  "intent": "<= 600 chars — one or two sentences stating what this change set is doing, in the user's voice. Do NOT truncate or end with an ellipsis; keep it under the limit naturally.",
  "key_changes": [ "<= 8 strings, each <= 300 chars — the concrete edits, in priority order." ],
  "risks": [ "<= 6 strings, each <= 300 chars — regressions, edge cases, or things a reviewer should double-check. Empty array if you see none." ],
  "file_count": <number — total distinct files in the diff, INCLUDING test files, docs, and config>,
  "files_with_purpose": [ { "path": "...", "purpose": "<= 160 chars — what role this file plays in the change set" } ]
}

Rules:
- Output ONLY the JSON object. No prose around it, no markdown fences.
- "intent" describes WHY the change exists, not just what changed.
- "key_changes" should cite file:line or function names when visible.
- "risks" is empty-array when the diff is obviously safe (renames, comments, test-only changes).
- "file_count" MUST equal the number of distinct \`diff --git a/... b/...\` headers in the input. Count them before you write anything else.
- "files_with_purpose" MUST include EVERY file in the diff, in the order they appear, with no omissions. files_with_purpose.length MUST equal file_count.
- Do NOT skip files just because they look uninteresting (tests, docs, config) — they still count.
- If the diff is empty or shows only whitespace/formatting, return { "intent": "no meaningful changes", "key_changes": [], "risks": [], "file_count": 0, "files_with_purpose": [] }.`;

/**
 * No hardcoded model default here anymore (single-brain #10, S2): the
 * production caller (run-critic.ts) injects `callFn: makeRoleRawBrain(homeBase,
 * "extract")`, which forces its own resolved model internally regardless of
 * what (if anything) `opts.model` carries. The lazy `callBrainRaw` fallback
 * below (for a direct caller that supplies no `callFn`) applies ITS OWN
 * default (the undated alias, ../../brain/brain.ts DEFAULT_MODEL) when
 * `opts.model` is omitted — NOT the dated pinned snapshot this file used to
 * hardcode as SUMMARIZER_MODEL (that pin now lives only in the
 * role-brain/registry resolution path).
 */
// Was a second, byte-identical 90_000 literal. It now defers to
// `resolveBrainTimeoutMs` so the two paths cannot drift and so the env knob
// moves both — a knob that retunes the critic call while silently leaving the
// summariser at 90s would produce exactly the confused timing this whole
// investigation started from.
/**
 * Cap input passed to Haiku to bound cost + latency.
 * Raised from 100KB to 512KB (2026-05-20): 100KB truncated mid-file on real
 * diffs with 15+ changed files → Haiku only counted files it saw, causing
 * dashboard to show "15 files" when the actual diff had 21. 512KB matches
 * the writeSnapshot.ts cap and comfortably holds large multi-file refactors.
 */
const MAX_DIFF_BYTES = 512 * 1024;

export interface RunDiffSummaryOptions {
  diffText: string;
  /** Override the spawn-driven Brain call (test seam). */
  callFn?: typeof callBrainRaw;
  model?: string;
  timeoutMs?: number;
}

export interface DiffSummaryResult {
  summary: DiffSummary;
  usage: BrainUsage;
}

/**
 * Run the summarizer. Returns null when the diff is empty (no point
 * spending the Haiku call). Throws BrainError on transport / parse
 * failure — caller decides whether to swallow.
 */
export async function runDiffSummary(
  opts: RunDiffSummaryOptions,
): Promise<DiffSummaryResult | null> {
  const diff = opts.diffText ?? "";
  if (diff.trim().length === 0) return null;

  const callFn = opts.callFn ?? callBrainRaw;
  const trimmed =
    diff.length > MAX_DIFF_BYTES
      ? `${diff.slice(0, MAX_DIFF_BYTES)}\n--- truncated for summary pre-pass ---\n`
      : diff;

  const callOpts: CallBrainOptions = {
    systemPrompt: SYSTEM_PROMPT,
    contextBundle: trimmed,
    model: opts.model,
    timeoutMs: resolveBrainTimeoutMs(opts.timeoutMs),
  };

  const raw = await callFn(callOpts);
  // Defensively truncate string fields to schema caps so Haiku producing slightly
  // over-length text doesn't kill the whole summary (e.g. purpose >160 chars).
  // Z.string().max() rejects rather than truncates by default — this preserves
  // the digest at the cost of a few trailing chars.
  const coerced = coerceLengths(raw.output);
  const parsed = diffSummarySchema.safeParse(coerced);
  if (!parsed.success) {
    throw new BrainError(
      `diff summary failed schema validation: ${parsed.error.message}`,
      undefined,
      undefined,
      undefined,
      // The COERCED value, not `raw.output`: the coercion above is what the
      // schema actually rejected, so it is what a fix has to be read against.
      coerced,
    );
  }

  // Post-process: reconcile Haiku-reported file_count against the actual count
  // from diff --git headers. If the diff was large enough to be partially read
  // by Haiku (even after raising MAX_DIFF_BYTES), the actual diff body may have
  // more files than Haiku counted. Override with the ground-truth count and
  // append a truncation note so the user understands the summary is partial.
  const summary = parsed.data;
  const actualCount = countDiffFiles(opts.diffText);
  if (actualCount > 0 && summary.file_count < actualCount) {
    const missing = actualCount - summary.file_count;
    summary.file_count = actualCount;
    // Only append the note when there is room under the schema cap. Before
    // `coerceLengths` learned to truncate arrays, an over-cap `files_with_purpose`
    // always failed safeParse and never reached this line, so an unconditional
    // push could not overflow. It can now: 40 kept entries + this one = 41, past
    // the very `.max(40)` the truncation exists to satisfy, and carrying two
    // truncation notes computed from two different bases sitting next to each
    // other. When there is no room, the fact is not lost — `file_count` now holds
    // the ground truth and `src/web/screens/critic/diff/render.tsx` renders the
    // count-vs-enumerated mismatch banner off exactly that difference.
    if (missing > 0 && summary.files_with_purpose.length < ARRAY_CAPS.files_with_purpose) {
      summary.files_with_purpose = [
        ...summary.files_with_purpose,
        {
          path: `[${missing} additional file${missing === 1 ? "" : "s"} truncated — see DIFF SNAPSHOT below]`,
          purpose: "summary truncated; actual diff has more files than Haiku read",
        },
      ];
    }
  }

  return { summary, usage: raw.usage };
}

/**
 * Count distinct `diff --git` file headers in a unified diff.
 * This is the ground-truth file count — what the diff body actually contains,
 * regardless of what Haiku could read within MAX_DIFF_BYTES.
 * Returns 0 when the input contains no diff headers (e.g. empty or log-only text).
 */
function countDiffFiles(diff: string): number {
  const matches = diff.match(/^diff --git /gm);
  return matches ? matches.length : 0;
}

function truncStr(v: unknown, max: number): unknown {
  if (typeof v !== "string") return v;
  return v.length <= max ? v : `${v.slice(0, max - 1)}…`;
}

/**
 * Array caps declared by `diffSummarySchema` above. Kept beside the coercion so
 * a cap change in the schema and a cap change here stay one edit apart, and so
 * the arithmetic below has a single source.
 */
const ARRAY_CAPS = {
  key_changes: 8,
  risks: 6,
  files_with_purpose: 40,
} as const;

/**
 * Truncate an over-cap array to exactly `cap` and report how many were dropped.
 *
 * The count goes to the caller, which records it in the summary's `truncated`
 * field — NOT into the array as a marker entry. See `truncated`'s doc on the
 * schema for why: a marker inside the array corrupts every `.length` and every
 * `slice(0, N)` downstream, and a review found three such readers.
 *
 * The negative-cap guard is narrower than two earlier versions of this comment
 * claimed, and each narrowing came from a mutation run rather than from reading:
 *
 *  - It is NOT about `slice(0, -1)` meaning "all but the last". That was true of
 *    an earlier `cap - 1` implementation; this one slices to `cap`.
 *  - It is NOT needed at `cap === 0`. `slice(0, 0)` is already `[]`. Weakening
 *    the condition from `cap < 1` to `cap < 0` left the entire suite green, so
 *    the condition is written as `cap < 0` — the boundary the code can actually
 *    defend.
 *  - What it DOES stop is a wrong dropped COUNT: for `cap = -3` on a 2-element
 *    array, `arr.length - cap` is `5`, so the summary would report five entries
 *    dropped from an array that only ever held two. Mutating that expression is
 *    caught, which is this guard's firing evidence.
 *
 * **Exported solely so that branch has firing evidence.** A guard no test can
 * reach is this repo's most-repeated defect (`docs/lessons.md` L3, "dead" family:
 * written, configured, never actually invoked), and nothing in this module can
 * reach it — `ARRAY_CAPS` holds 8/6/40. Not part of the module's real API.
 */
export function truncArray<T>(arr: T[], cap: number): { kept: T[]; dropped: number } {
  if (arr.length <= cap) return { kept: arr, dropped: 0 };
  if (cap < 0) return { kept: [], dropped: arr.length };
  return { kept: arr.slice(0, cap), dropped: arr.length - cap };
}

function coerceLengths(out: unknown): unknown {
  if (out === null || typeof out !== "object") return out;
  const o = out as Record<string, unknown>;
  const next: Record<string, unknown> = { ...o };
  const truncated: Record<string, number> = {};
  if (typeof o.intent === "string") next.intent = truncStr(o.intent, 600);
  if (Array.isArray(o.key_changes)) {
    const r = truncArray((o.key_changes as unknown[]).map(s => truncStr(s, 300)), ARRAY_CAPS.key_changes);
    next.key_changes = r.kept;
    if (r.dropped > 0) truncated.key_changes = r.dropped;
  }
  if (Array.isArray(o.risks)) {
    const r = truncArray((o.risks as unknown[]).map(s => truncStr(s, 300)), ARRAY_CAPS.risks);
    next.risks = r.kept;
    if (r.dropped > 0) truncated.risks = r.dropped;
  }
  if (Array.isArray(o.files_with_purpose)) {
    const r = truncArray(
      (o.files_with_purpose as unknown[]).map(item => {
        if (item === null || typeof item !== "object") return item;
        const it = item as Record<string, unknown>;
        return {
          ...it,
          path: typeof it.path === "string" ? truncStr(it.path, 300) : it.path,
          purpose: typeof it.purpose === "string" ? truncStr(it.purpose, 160) : it.purpose,
        };
      }),
      ARRAY_CAPS.files_with_purpose,
    );
    next.files_with_purpose = r.kept;
    if (r.dropped > 0) truncated.files_with_purpose = r.dropped;
  }
  // Overwrite rather than merge: whatever Haiku may have emitted under this key
  // is not a measurement, and this is.
  next.truncated = truncated;
  return next;
}

/**
 * Heuristic (no-LLM) diff summary used as a fallback when the Haiku
 * pass fails / times out / returns malformed output. Pure string
 * parsing — never throws.
 *
 * Limitations:
 *   - "intent" is best-effort: pulls the first commit message subject
 *     line when the diff came from `git log -p`; otherwise composes a
 *     terse "N files changed (+A −D)" sentence.
 *   - "key_changes" enumerates per-file +/- counts.
 *   - "risks" is always empty — risk inference needs a model.
 *   - "files_with_purpose" lists every file with `purpose: "+A −D"`.
 *
 * Intentionally simple. Dashboard renders this with a "heuristic"
 * source tag so the user knows it's a degraded summary.
 */
export function heuristicDiffSummary(diff: string): DiffSummary {
  if (!diff || diff.trim().length === 0) {
    return {
      intent: "no meaningful changes",
      key_changes: [],
      risks: [],
      file_count: 0,
      files_with_purpose: [],
      source: "heuristic",
    };
  }
  // Per-file +/- count from `diff --git a/... b/...` boundaries.
  type FileStat = { path: string; add: number; del: number };
  const files: FileStat[] = [];
  let cur: FileStat | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (cur) files.push(cur);
      const m = line.match(/^diff --git a\/(\S+) b\/(\S+)/);
      const path = m ? (m[1] === m[2] ? m[1]! : `${m[1]} → ${m[2]}`) : "(unknown)";
      cur = { path, add: 0, del: 0 };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) cur.add++;
    else if (line.startsWith("-") && !line.startsWith("---")) cur.del++;
  }
  if (cur) files.push(cur);

  // Merge duplicates (file touched in multiple commits inside a `git log -p`
  // dump shows up multiple times).
  const merged = new Map<string, FileStat>();
  for (const f of files) {
    const e = merged.get(f.path);
    if (e) { e.add += f.add; e.del += f.del; }
    else merged.set(f.path, { ...f });
  }
  const fileList = Array.from(merged.values());

  // Best-effort intent: first commit message subject line (between
  // "commit XXX" and the next blank-line/diff boundary). Falls back
  // to a terse count sentence.
  let intent = "";
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.startsWith("commit ")) {
      // skip Author / Date lines + initial blank, then take the first
      // non-empty indented (or non-indented) line.
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const l = lines[j]!;
        if (l.startsWith("Author:") || l.startsWith("Date:") || l.startsWith("Merge:")) continue;
        const trimmed = l.trim();
        if (trimmed.length === 0) continue;
        if (trimmed.startsWith("diff --git")) break;
        intent = trimmed.slice(0, 600);
        break;
      }
      if (intent) break;
    }
  }
  if (!intent) {
    const totalAdd = fileList.reduce((s, f) => s + f.add, 0);
    const totalDel = fileList.reduce((s, f) => s + f.del, 0);
    intent = `${fileList.length} file${fileList.length === 1 ? "" : "s"} changed · +${totalAdd} −${totalDel} (heuristic summary — Haiku unavailable)`;
  }

  return {
    intent,
    key_changes: fileList
      .slice(0, 8)
      .map((f) => `${f.path} · +${f.add} −${f.del}`),
    risks: [],
    file_count: fileList.length,
    files_with_purpose: fileList.slice(0, 40).map((f) => ({
      path: f.path,
      purpose: `+${f.add} −${f.del}`,
    })),
    source: "heuristic",
  };
}

// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Diff summary pre-pass — calls Haiku to digest a raw git diff into a
 * structured summary that the main Brain critic can read instead of
 * the raw (often truncated) diff body.
 *
 * Why: Brain's prompt was being stuffed with `git log -p` output that
 * the model couldn't fully consume, leading to "缺差异. 审不了"
 * comments even when concrete changes existed. A Haiku pass turns the
 * diff into a digest Brain can reason about: intent / key changes /
 * risks / per-file purpose.
 *
 * Output JSON shape is also surfaced on /critic so the user sees the
 * digest alongside the colorized diff.
 */
import { z } from "zod";
import { callBrainRaw, BrainError, type BrainUsage, type CallBrainOptions } from "../../brain/brain";

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
 * The model the summarizer actually passes to `claude -p --model` — exported
 * so its span writer records the SAME string (single source of truth; the
 * critic Brain has its own DEFAULT_MODEL in brain/brain.ts).
 */
export const SUMMARIZER_MODEL = "claude-haiku-4-5";
const DEFAULT_MODEL = SUMMARIZER_MODEL;
const DEFAULT_TIMEOUT_MS = 90_000;
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
    model: opts.model ?? DEFAULT_MODEL,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
    if (missing > 0) {
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

function coerceLengths(out: unknown): unknown {
  if (out === null || typeof out !== "object") return out;
  const o = out as Record<string, unknown>;
  const next: Record<string, unknown> = { ...o };
  if (typeof o.intent === "string") next.intent = truncStr(o.intent, 600);
  if (Array.isArray(o.key_changes)) {
    next.key_changes = (o.key_changes as unknown[]).map(s => truncStr(s, 300));
  }
  if (Array.isArray(o.risks)) {
    next.risks = (o.risks as unknown[]).map(s => truncStr(s, 300));
  }
  if (Array.isArray(o.files_with_purpose)) {
    next.files_with_purpose = (o.files_with_purpose as unknown[]).map(item => {
      if (item === null || typeof item !== "object") return item;
      const it = item as Record<string, unknown>;
      return {
        ...it,
        path: typeof it.path === "string" ? truncStr(it.path, 300) : it.path,
        purpose: typeof it.purpose === "string" ? truncStr(it.purpose, 160) : it.purpose,
      };
    });
  }
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

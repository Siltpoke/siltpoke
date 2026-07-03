// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * chat-correction-eval — eval gate for the chat-memory-correction track.
 *
 * Runs the REAL `extractDurableFacts` (same prompt, same lenient parse) over a
 * labeled set (`tests/fixtures/chat-correction-eval.jsonl`), scores every
 * verdict AFTER the layer-2 re-derivation mirror (target must be in the
 * candidate list else add — same rule as chat-capture-runner.ts), then sweeps
 * (T_HIGH, T_MID) pairs to produce the precision/recall table.
 *
 * $0-by-default (deterministic-replay discipline): Brain responses are cached
 * per case id in `tests/fixtures/chat-correction-eval-responses.jsonl`. The ONE
 * paid calibration run (`--paid`, double-gated behind SILTPOKE_EVAL_PAID=1)
 * populates the cache; every later run replays it for free.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { type BrainUsage, callBrainRaw as realCallBrainRaw } from "../brain/brain";
import {
  type ExtractedFact,
  extractDurableFacts,
  type FactClassification,
} from "../memory/extract-facts";
import { numericallyEquivalent } from "../memory/numeric-equivalence";

export const DEFAULT_CASES_PATH = "tests/fixtures/chat-correction-eval.jsonl";
export const DEFAULT_CACHE_PATH = "tests/fixtures/chat-correction-eval-responses.jsonl";
export const DEFAULT_REPORT_PATH = "chat-correction-eval-report.md";

/** Generous per-case upper bound (spawn-dominated Haiku call). */
export const EST_COST_PER_CASE_USD = 0.05;

/** Mirrors EXTRACT_MODEL in extract-facts.ts (not exported there) — report metadata only. */
const EVAL_MODEL = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Labeled-set schema
// ---------------------------------------------------------------------------

export type ShouldWrite = "replace" | "propose" | "add" | "none";

const caseSchema = z.object({
  id: z.string().min(1),
  message: z.string().min(1),
  candidates: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })),
  expected: z.object({
    facts: z.array(
      z.object({
        classification: z.enum(["add", "restate", "contradict"]),
        target_id: z.string().nullable(),
      }),
    ),
    should_write: z.enum(["replace", "propose", "add", "none"]),
  }),
  category: z.string().min(1),
  lang: z.string().min(1),
});

export type ChatCorrectionCase = z.infer<typeof caseSchema>;

/** Load + validate the labeled set. Malformed lines are LOUD (labeled data must be valid). */
export async function loadCases(path: string): Promise<ChatCorrectionCase[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`labeled set not found at ${path}`);
  }
  const cases: ChatCorrectionCase[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`${path}:${i + 1}: not valid JSON`);
    }
    const checked = caseSchema.safeParse(parsed);
    if (!checked.success) {
      throw new Error(`${path}:${i + 1}: invalid case shape — ${checked.error.message}`);
    }
    cases.push(checked.data);
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Response cache (replay-over-regen)
// ---------------------------------------------------------------------------

export interface CachedResponse {
  id: string;
  output: unknown;
  usage: BrainUsage;
}

/** Absent file → empty cache; malformed lines skipped (cache is regenerable). */
export async function loadResponseCache(path: string): Promise<Map<string, CachedResponse>> {
  const cache = new Map<string, CachedResponse>();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return cache;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as CachedResponse;
      if (typeof entry.id === "string" && entry.id.length > 0) cache.set(entry.id, entry);
    } catch {
      // skip malformed cache lines — a re-run in --paid mode regenerates them
    }
  }
  return cache;
}

// ---------------------------------------------------------------------------
// Layer-2 mirror + ladder (pure) — MUST match chat-capture-runner.ts semantics
// ---------------------------------------------------------------------------

export interface NormalizedVerdict {
  text: string;
  classification: FactClassification;
  target_id: string | null;
  confidence?: number;
}

/**
 * Layer-2 re-derivation mirror (same rule as the runner's
 * `deriveClassifiedClaims`): a restate/contradict verdict must name a target in
 * the candidate list, else it downgrades to a plain add — never phantom-target.
 * A contradict whose text (or whose source MESSAGE — the extractor sometimes
 * rephrases/translates the claim) is `numericallyEquivalent` to its target
 * ALSO downgrades to add (numeric-specifics guard promoted to code —
 * same shared function as the runner, single source of truth; see
 * src/memory/numeric-equivalence.ts for the eval evidence).
 * The eval scores POST-guard verdicts, i.e. what actually routes writes.
 */
export function normalizeVerdict(
  fact: ExtractedFact,
  candidateTextById: ReadonlyMap<string, string>,
  message: string,
): NormalizedVerdict {
  const classification = fact.classification ?? "add";
  const target = fact.target_fact_id ?? null;
  const targetText = target === null ? undefined : candidateTextById.get(target);
  if (classification === "add" || target === null || targetText === undefined) {
    return { text: fact.text, classification: "add", target_id: null, confidence: fact.confidence };
  }
  if (
    classification === "contradict" &&
    (numericallyEquivalent(fact.text, targetText) || numericallyEquivalent(message, targetText))
  ) {
    return { text: fact.text, classification: "add", target_id: null, confidence: fact.confidence };
  }
  return { text: fact.text, classification, target_id: target, confidence: fact.confidence };
}

/**
 * Confidence ladder as a write verb, parameterized by thresholds for the sweep.
 * Mirrors the runner's `contradictTier`: `undefined` confidence → "propose"
 * (conservative belt — never auto-retire without an explicit high score, never
 * silently drop a named contradiction). Restate → no NEW fact written ("none").
 */
export function deriveWrite(v: NormalizedVerdict, tHigh: number, tMid: number): ShouldWrite {
  if (v.classification === "add") return "add";
  if (v.classification === "restate") return "none";
  if (v.confidence === undefined) return "propose";
  if (v.confidence >= tHigh) return "replace";
  if (v.confidence >= tMid) return "propose";
  return "none";
}

// ---------------------------------------------------------------------------
// Per-case scoring (pure)
// ---------------------------------------------------------------------------

export interface CaseResult {
  case_id: string;
  category: string;
  verdicts: NormalizedVerdict[];
  /** Sorted post-guard classification labels == sorted expected labels. */
  classification_match: boolean;
  /** Sorted (classification, target) pairs == expected pairs (subsumes phantom-target). */
  target_match: boolean;
}

export function scoreCase(c: ChatCorrectionCase, facts: ExtractedFact[]): CaseResult {
  const candidateTextById = new Map(c.candidates.map((x) => [x.id, x.text]));
  const verdicts = facts.map((f) => normalizeVerdict(f, candidateTextById, c.message));
  const actualLabels = verdicts.map((v) => v.classification).sort();
  const expectedLabels = c.expected.facts.map((f) => f.classification).sort();
  const actualPairs = verdicts.map((v) => `${v.classification}|${v.target_id ?? ""}`).sort();
  const expectedPairs = c.expected.facts.map((f) => `${f.classification}|${f.target_id ?? ""}`).sort();
  return {
    case_id: c.id,
    category: c.category,
    verdicts,
    classification_match: actualLabels.join(",") === expectedLabels.join(","),
    target_match: actualPairs.join(",") === expectedPairs.join(","),
  };
}

// ---------------------------------------------------------------------------
// Threshold sweep (pure)
// ---------------------------------------------------------------------------

export interface ScoredCase {
  evalCase: ChatCorrectionCase;
  result: CaseResult;
}

export interface SweepRow {
  t_high: number;
  t_mid: number;
  /** Cases with ≥1 verdict landing "replace" at this pair. */
  replace_fired: number;
  /** Fired cases whose expected.should_write === "replace" AND target matched. */
  replace_correct: number;
  /** replace_correct / replace_fired; null when nothing fired (undefined, not 1). */
  auto_precision: number | null;
  /** replace_correct / (# expected-replace cases) — coverage of true corrections. */
  auto_recall: number;
  /** Cases with ≥1 verdict landing "propose" (mid-band routing volume). */
  mid_band: number;
}

/** T_HIGH ∈ [0.5..0.95 step 0.05] × T_MID ∈ same grid, strictly below (45 pairs). */
export function thresholdGrid(): Array<{ t_high: number; t_mid: number }> {
  const grid: number[] = [];
  for (let i = 50; i <= 95; i += 5) grid.push(i / 100);
  const pairs: Array<{ t_high: number; t_mid: number }> = [];
  for (const t_high of grid) {
    for (const t_mid of grid) {
      if (t_mid < t_high) pairs.push({ t_high, t_mid });
    }
  }
  return pairs;
}

export function sweepThresholds(scored: ScoredCase[]): SweepRow[] {
  const expectedReplace = scored.filter(
    (s) => s.evalCase.expected.should_write === "replace",
  ).length;
  return thresholdGrid().map(({ t_high, t_mid }) => {
    let fired = 0;
    let correct = 0;
    let mid = 0;
    for (const s of scored) {
      const writes = s.result.verdicts.map((v) => deriveWrite(v, t_high, t_mid));
      if (writes.includes("replace")) {
        fired++;
        if (s.evalCase.expected.should_write === "replace" && s.result.target_match) correct++;
      }
      if (writes.includes("propose")) mid++;
    }
    return {
      t_high,
      t_mid,
      replace_fired: fired,
      replace_correct: correct,
      auto_precision: fired === 0 ? null : correct / fired,
      auto_recall: expectedReplace === 0 ? 1 : correct / expectedReplace,
      mid_band: mid,
    };
  });
}

/**
 * Positive control: plain adds must still come out as adds. Threshold-
 * independent by construction (adds bypass the ladder), so reported once.
 */
export function addOnlyRecall(scored: ScoredCase[]): number {
  const adds = scored.filter((s) => s.evalCase.category === "plain-add");
  if (adds.length === 0) return 1;
  const extracted = adds.filter((s) =>
    s.result.verdicts.some((v) => v.classification === "add"),
  ).length;
  return extracted / adds.length;
}

/**
 * Recommended pair = highest auto-precision among rows with acceptable coverage
 * (auto_recall ≥ minRecall; relaxed to > 0 if none qualify). Ties break to
 * higher recall, then the MOST conservative thresholds (higher T_HIGH/T_MID).
 * Returns null when no pair ever fires correctly — contradict never
 * auto-supersedes this release.
 */
export function recommendThresholds(rows: SweepRow[], minRecall = 0.5): SweepRow | null {
  const pick = (floor: (r: SweepRow) => boolean): SweepRow | null => {
    const eligible = rows.filter((r) => r.auto_precision !== null && floor(r));
    if (eligible.length === 0) return null;
    return eligible.reduce((best, r) => {
      if (r.auto_precision! !== best.auto_precision!) {
        return r.auto_precision! > best.auto_precision! ? r : best;
      }
      if (r.auto_recall !== best.auto_recall) return r.auto_recall > best.auto_recall ? r : best;
      if (r.t_high !== best.t_high) return r.t_high > best.t_high ? r : best;
      return r.t_mid > best.t_mid ? r : best;
    });
  };
  return pick((r) => r.auto_recall >= minRecall) ?? pick((r) => r.auto_recall > 0);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ReportMeta {
  date: string;
  mode: "paid" | "replay";
  totalCostUsd: number;
  /** Case ids the paid run failed to get a response for (call error) — 0 in a clean run. */
  failedIds: string[];
}

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(0)}%`;
}

export function formatEvalReport(
  scored: ScoredCase[],
  rows: SweepRow[],
  recommended: SweepRow | null,
  addRecall: number,
  meta: ReportMeta,
): string {
  const byCategory = new Map<string, ScoredCase[]>();
  for (const s of scored) {
    const list = byCategory.get(s.evalCase.category) ?? [];
    list.push(s);
    byCategory.set(s.evalCase.category, list);
  }
  const lines: string[] = [
    "# Chat-memory-correction eval — threshold calibration",
    "",
    `- **Date**: ${meta.date}`,
    `- **Model**: ${EVAL_MODEL} (the real \`extractDurableFacts\` prompt + lenient parse)`,
    `- **Mode**: ${meta.mode === "paid" ? "paid calibration (responses cached for $0 replays)" : "$0 replay from cached responses"}`,
    `- **Cases**: ${scored.length} labeled (synthetic-but-realistic, bilingual)`,
    `- **Spend (from cached usage)**: $${meta.totalCostUsd.toFixed(4)}`,
    "",
    "## Per-category exact match (post-guard classification + target)",
    "",
    "| category | n | exact match |",
    "|---|---|---|",
  ];
  for (const [category, list] of [...byCategory.entries()].sort()) {
    const ok = list.filter((s) => s.result.classification_match && s.result.target_match).length;
    lines.push(`| ${category} | ${list.length} | ${ok}/${list.length} |`);
  }
  const misses = scored.filter(
    (s) => !(s.result.classification_match && s.result.target_match),
  );
  lines.push("", `## Mismatched cases (${misses.length})`, "");
  if (misses.length === 0) lines.push("(none)");
  for (const s of misses) {
    const got = s.result.verdicts
      .map((v) => `${v.classification}→${v.target_id ?? "∅"}@${v.confidence ?? "?"}`)
      .join("; ");
    const want = s.evalCase.expected.facts
      .map((f) => `${f.classification}→${f.target_id ?? "∅"}`)
      .join("; ");
    lines.push(`- \`${s.evalCase.id}\` expected [${want || "no fact"}] got [${got || "no fact"}]`);
  }
  lines.push(
    "",
    `## Positive control — add-only recall: ${pct(addRecall)}`,
    "",
    "Plain adds still extracted as adds (threshold-independent: adds bypass the ladder).",
    "",
    "## Threshold sweep",
    "",
    "Note: auto-precision/recall depend ONLY on T_HIGH (the replace cut); T_MID moves",
    "the mid-band (pending) vs drop split below it.",
    "",
    "| T_HIGH | T_MID | replaces fired | correct | auto-precision | auto-recall | mid-band |",
    "|---|---|---|---|---|---|---|",
  );
  for (const r of rows) {
    lines.push(
      `| ${r.t_high.toFixed(2)} | ${r.t_mid.toFixed(2)} | ${r.replace_fired} | ${r.replace_correct} | ${pct(r.auto_precision)} | ${pct(r.auto_recall)} | ${r.mid_band} |`,
    );
  }
  lines.push("", "## Recommendation", "");
  if (recommended === null) {
    lines.push(
      "No threshold pair reaches usable auto-supersede precision — per design",
      "contingency, contradict must NOT auto-supersede this release (everything",
      "lands pending). Surface to the user as a spec-gap decision.",
    );
  } else {
    lines.push(
      `**T_HIGH = ${recommended.t_high.toFixed(2)}, T_MID = ${recommended.t_mid.toFixed(2)}** — ` +
        `auto-precision ${pct(recommended.auto_precision)} at auto-recall ${pct(recommended.auto_recall)}, ` +
        `mid-band ${recommended.mid_band} case(s).`,
      "",
      "Selection rule: highest auto-precision with coverage (auto-recall ≥ 0.5, relaxed",
      "to > 0 when nothing qualifies); ties break to higher recall, then the more",
      "conservative (higher) thresholds.",
    );
  }
  lines.push("", "## Honest caveats", "");
  lines.push(
    `- Synthetic-but-realistic labeled set, n=${scored.length} — small; treat precision digits as coarse.`,
    "- Cases were written by the implementing agent, not sampled from real user logs.",
    "- Haiku self-reported confidence is uncalibrated; this table IS the calibration evidence.",
    "- Scores are POST layer-2 guard (invalid targets AND numeric-equivalent contradicts already downgraded to add), i.e. system behavior, not raw LLM output.",
    "- `undefined` confidence routes to pending regardless of thresholds (runner's conservative belt).",
  );
  if (meta.failedIds.length > 0) {
    lines.push(
      `- ⚠️ ${meta.failedIds.length} case(s) got NO Brain response (call failure) and scored as empty: ${meta.failedIds.join(", ")} — re-run --paid to fill.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface ChatCorrectionEvalDeps {
  casesPath?: string;
  cachePath?: string;
  /** true → cache misses call the real Brain and append to the cache. */
  paid?: boolean;
  /** Injectable Brain (tests / paid mode); replayed cases never touch it. */
  callBrainRaw?: typeof realCallBrainRaw;
  now?: () => Date;
}

export interface ChatCorrectionEvalRun {
  scored: ScoredCase[];
  sweep: SweepRow[];
  recommended: SweepRow | null;
  addRecall: number;
  totalCostUsd: number;
  failedIds: string[];
  report: string;
}

export async function runChatCorrectionEval(
  deps: ChatCorrectionEvalDeps = {},
): Promise<ChatCorrectionEvalRun> {
  const casesPath = deps.casesPath ?? DEFAULT_CASES_PATH;
  const cachePath = deps.cachePath ?? DEFAULT_CACHE_PATH;
  const paid = deps.paid ?? false;
  const cases = await loadCases(casesPath);
  if (cases.length === 0) throw new Error(`labeled set at ${casesPath} is empty`);

  const cache = await loadResponseCache(cachePath);
  const missing = cases.filter((c) => !cache.has(c.id)).map((c) => c.id);
  if (missing.length > 0 && !paid) {
    throw new Error(
      `response cache ${cachePath} is missing ${missing.length}/${cases.length} case(s) ` +
        `(e.g. ${missing.slice(0, 3).join(", ")}). $0 replay needs a populated cache — run the ` +
        `ONE paid calibration first: SILTPOKE_EVAL_PAID=1 bun src/eval/chat-correction-eval.ts --paid`,
    );
  }

  const brain = deps.callBrainRaw ?? realCallBrainRaw;
  const scored: ScoredCase[] = [];
  let totalCostUsd = 0;

  for (const c of cases) {
    const cached = cache.get(c.id);
    // Replay when cached; in paid mode a miss calls the real Brain and TEES the
    // raw response into the cache (resume-safe: a crashed paid run keeps what it
    // already bought; the next run only pays for the remainder).
    const caseBrain: typeof realCallBrainRaw = cached
      ? async () => ({ output: cached.output, usage: cached.usage })
      : async (opts) => {
          const res = await brain(opts);
          const entry: CachedResponse = { id: c.id, output: res.output, usage: res.usage };
          await appendFile(cachePath, `${JSON.stringify(entry)}\n`, "utf8");
          cache.set(c.id, entry);
          return res;
        };
    const facts = await extractDurableFacts(
      c.message,
      { homeBase: "", sessionId: "chat-correction-eval" },
      c.candidates,
      // No-op ledger: eval spend is reported from cached usage below, and must
      // not pollute the live ~/.siltpoke usage ledger.
      { callBrainRaw: caseBrain, ledger: async () => {} },
    );
    totalCostUsd += cache.get(c.id)?.usage.total_cost_usd ?? 0;
    scored.push({ evalCase: c, result: scoreCase(c, facts) });
  }

  // extractDurableFacts never throws (degrades to []) — a paid-mode call failure
  // leaves the id uncached. Surface it instead of silently scoring an empty case.
  const failedIds = cases.filter((c) => !cache.has(c.id)).map((c) => c.id);

  const sweep = sweepThresholds(scored);
  const recommended = recommendThresholds(sweep);
  const addRecall = addOnlyRecall(scored);
  const date = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const report = formatEvalReport(scored, sweep, recommended, addRecall, {
    date,
    mode: paid ? "paid" : "replay",
    totalCostUsd,
    failedIds,
  });
  return { scored, sweep, recommended, addRecall, totalCostUsd, failedIds, report };
}

// ---------------------------------------------------------------------------
// CLI — bun src/eval/chat-correction-eval.ts [--paid]
// ---------------------------------------------------------------------------

/**
 * Belt against accidental spend: even with --paid, refuse unless
 * SILTPOKE_EVAL_PAID=1. Always prints the projected cost first.
 */
export function checkPaidGate(
  caseCount: number,
  env: Record<string, string | undefined>,
): { ok: boolean; reason: string } {
  const est = (caseCount * EST_COST_PER_CASE_USD).toFixed(2);
  const projection = `paid calibration: ${caseCount} cases × ~$${EST_COST_PER_CASE_USD} ≈ $${est} (upper bound)`;
  if (env.SILTPOKE_EVAL_PAID !== "1") {
    return {
      ok: false,
      reason: `${projection}\nrefusing paid run: set SILTPOKE_EVAL_PAID=1 to confirm the spend`,
    };
  }
  return { ok: true, reason: projection };
}

const out = (s: string) => process.stdout.write(`${s}\n`);

async function main(argv: string[]): Promise<number> {
  const paid = argv.includes("--paid");
  if (paid) {
    const cases = await loadCases(DEFAULT_CASES_PATH);
    const gate = checkPaidGate(cases.length, process.env);
    out(gate.reason);
    if (!gate.ok) return 1;
  }
  const run = await runChatCorrectionEval({ paid });
  out(run.report);
  await mkdir(dirname(DEFAULT_REPORT_PATH), { recursive: true });
  await writeFile(DEFAULT_REPORT_PATH, run.report, "utf8");
  out(`report written to ${DEFAULT_REPORT_PATH}`);
  if (run.failedIds.length > 0) {
    console.error(`WARNING: ${run.failedIds.length} case(s) failed to get a response — re-run --paid`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

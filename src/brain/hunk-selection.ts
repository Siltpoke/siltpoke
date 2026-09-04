// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Which changed hunks reach the critic prompt, and what the prompt says about
 * the ones that did not (defect ③).
 *
 * The budget has always existed; the RANKING did not. `formatGitDiffBlock` used
 * to cut with `parsed.slice(0, 20)` — a prefix cut over a list git emits in path
 * order, so `dist/`, `docs/` and `.claude/` all sorted ahead of `src/`. Measured
 * on 200 real critic snapshots
 * (an internal design note,
 * corpus fingerprint `ec93d1f15593`): of the 179 that contained changed source,
 * 56 (31.3%) showed the reviewer none of it, 40 of those because build output
 * held the slots. That corpus is a rolling window the measuring session writes
 * into, so a re-run moves the figures — the snapshot carries the fingerprint
 * that these particular numbers belong to.
 *
 * Kept in its own module so the SELECTION POLICY can be read, tested and
 * measured without reading prompt formatting.
 *
 * Pure functions — no IO, no side effects.
 */

/**
 * Hunks that reach the critic prompt. Deliberately NOT raised: a controlled
 * external ablation found a wider window scores worse than a narrow one
 * (`ref-2026-07-30-swe-agent-aci-ablation` — File Viewer 30 lines 14.3 · 100
 * lines 18.0 · whole file 12.7). The fix is the ranking, not a bigger budget.
 *
 * Exported with no production importer on purpose — `selectHunksForBudget`
 * defaults to it internally, and the export exists so the test that asserts it
 * is still 20, and the harness that measures against it, both read the real
 * constant instead of hardcoding the number a second time. `audit:dead` will
 * therefore list it as production-dead; that is the intended trade.
 */
export const GIT_DIFF_HUNK_BUDGET = 20;

/**
 * Reviewability tiers, most-reviewable first.
 *
 * These are about what a REVIEW is about, not about language. Generated output
 * is the compiler's opinion, not the author's; docs carry no code paths.
 *
 * The default is `source` on purpose. Siltpoke reviews the USER's repo, where
 * the `src/` convention does not hold, so an unrecognised path is treated as
 * reviewable rather than demoted. Only shapes that hold across repos get
 * demoted. Misjudging downward costs a reviewer its source; misjudging upward
 * costs it two hunks.
 */
const DIFF_TIERS = ["source", "tests", "docs", "generated"] as const;
type DiffTier = (typeof DIFF_TIERS)[number];

const GENERATED_DIR_RE =
  /(^|\/)(dist|build|out|coverage|node_modules|vendor|\.next|\.turbo|\.antigravity-plugin)\//;
const GENERATED_FILE_RE = /(\.min\.js|\.map|\.snap|-lock\.json|\.lock)$/;
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const DOC_PATH_RE = /(^|\/)docs?\/|\.(md|mdx|txt|rst)$/i;
/**
 * Agent configuration — the harness the review runs INSIDE, not the code under
 * review. `.claude/` was named as one of the three offenders that outsorted
 * `src/` (alongside `dist/` and `docs/`), and then was not actually demoted:
 * most of its content is markdown and got caught by DOC_PATH_RE, which hid the
 * gap. Measured on the shipped version — `[20x .claude/settings.json, 5x
 * src/foo.ts]` gave the reviewer twenty config hunks and ZERO source.
 *
 * Scoped to `.claude/` deliberately. `.claude-plugin/` is NOT here: in siltpoke
 * that directory is shipped product surface, and demoting it would hide real
 * changes — the failure this whole module exists to stop.
 */
const AGENT_CONFIG_RE = /(^|\/)\.claude\//;

function tierOf(file: string): DiffTier {
  if (GENERATED_DIR_RE.test(file) || GENERATED_FILE_RE.test(file)) return "generated";
  if (TEST_PATH_RE.test(file)) return "tests";
  if (DOC_PATH_RE.test(file) || AGENT_CONFIG_RE.test(file)) return "docs";
  return "source";
}

/**
 * Files a linter actually complained about, matched against diff paths.
 *
 * eslint reports ABSOLUTE paths (`run-eslint.ts` stores `fileResult.filePath`)
 * while git-diff paths are repo-relative, so an equality check would silently
 * never match — the exact shape of failure this whole track is made of.
 * Matching on a `/` boundary is what makes the two comparable; a bare basename
 * match is deliberately NOT used, since two `index.ts` in different directories
 * would promote each other.
 *
 * There are two directions, and only one of them is safe unconditionally:
 *
 * - `p.endsWith("/" + target)` — the linter path is LONGER (eslint's absolute
 *   path against a repo-relative diff path).
 * - `target.endsWith("/" + p)` — the linter path is SHORTER (tsc emits paths
 *   relative to the tsconfig directory, which can sit below the repo root).
 *
 * BOTH need the same guard, and the first shipped without it (#626, caught by
 * review): a suffix match is only anchored while the SHORTER side carries a
 * directory. Whichever side is bare turns its arm into the basename match the
 * paragraph above rules out. Measured on the unguarded version:
 *
 *     diff files [20x src/a-other.ts, 5x index.ts], linterFiles ["src/index.ts"]
 *     -> root index.ts promoted, taking 5 slots from src/a-other.ts
 *
 * Neither guard is defensive coding against a hypothetical. `linterFiles` is
 * caller-supplied on an exported function, and a repo-root file really does
 * produce a bare diff path.
 */
function buildLinterHitSet(
  diffFiles: readonly string[],
  linterFiles: readonly string[],
): Set<string> {
  const hits = new Set<string>();
  if (linterFiles.length === 0) return hits;
  const normalized = [...new Set(linterFiles.map((f) => f.replace(/^\.\//, "")))];
  for (const diffFile of diffFiles) {
    const target = diffFile.replace(/^\.\//, "");
    const hit = normalized.some(
      (p) =>
        p === target ||
        (target.includes("/") && p.endsWith(`/${target}`)) ||
        (p.includes("/") && target.endsWith(`/${p}`)),
    );
    if (hit) hits.add(diffFile);
  }
  return hits;
}

/**
 * Choose which hunks reach the prompt.
 *
 * Ordered by (1) reviewability tier, (2) whether a linter flagged the file,
 * (3) the order git emitted them. Tier outranks the linter hit on purpose: a
 * lint error inside `dist/` must never displace hand-written source. Keeping
 * git's order as the last key is what holds a file's hunks together, since the
 * two keys above it are file-derived.
 *
 * Exported so the measurement harness can rank with the SHIPPING function
 * rather than a copy of it — a harness that re-implements the mechanism is
 * measuring its own copy.
 *
 * Pure: the input array is not mutated.
 */
export function selectHunksForBudget<T extends { file: string }>(
  hunks: readonly T[],
  opts: { linterFiles?: readonly string[]; budget?: number } = {},
): { kept: T[]; omitted: T[] } {
  const budget = opts.budget ?? GIT_DIFF_HUNK_BUDGET;
  const linterHits = buildLinterHitSet(
    hunks.map((h) => h.file),
    opts.linterFiles ?? [],
  );

  const ranked = hunks
    .map((hunk, index) => ({ hunk, index }))
    .sort((a, b) => {
      const tierCmp =
        DIFF_TIERS.indexOf(tierOf(a.hunk.file)) - DIFF_TIERS.indexOf(tierOf(b.hunk.file));
      if (tierCmp !== 0) return tierCmp;
      const aHit = linterHits.has(a.hunk.file) ? 0 : 1;
      const bHit = linterHits.has(b.hunk.file) ? 0 : 1;
      if (aHit !== bHit) return aHit - bHit;
      return a.index - b.index;
    })
    .map((e) => e.hunk);

  return { kept: ranked.slice(0, budget), omitted: ranked.slice(budget) };
}

/**
 * The coverage declaration.
 *
 * A partial diff used to be a parenthetical the reviewer could read straight
 * past. Ranking fixes the reviews that had source available and lost it; it
 * cannot fix the 70 of 179 source-carrying diffs whose source ALONE overflows
 * the budget (39.1%, same corpus). For those,
 * this is the whole remedy: state what was cut, and ask for the admission in
 * `reasoning`.
 *
 * ⚠️ NOTHING VERIFIES THAT ADMISSION TODAY. #626 shipped with a comment (and
 * four documents) claiming `reasoning` is "a field the output schema already
 * requires to be non-empty, so it carries force without adding a contract".
 * That is FALSE on the path that runs: `brain.ts` parses with
 * `schema.ts`'s `brainOutputSchema`, where `reasoning` is
 * `z.string().max(800).optional()`. The `min(1)` version is `schema-v2.ts`,
 * which types the v2 pipeline, not this one. So a review written on 20 of 91
 * source hunks can still come back silent about it and be delivered reading as
 * complete — the exact failure this notice exists to close.
 *
 * The prompt asks (`system-prompt.md`); no code checks. Enforcement is a
 * product-behavior decision (reject / label / have siltpoke state the coverage
 * itself rather than trusting the model to) and is deliberately NOT decided
 * here. Until it is, this notice is a REQUEST, not a guarantee — and saying so
 * is the point.
 */
/**
 * What the budget cut, as counts — the deterministic half of the honesty.
 *
 * `formatCoverageNotice` writes the same facts as prose FOR THE MODEL, and the
 * model may ignore it. This returns them as data so siltpoke can state the
 * coverage on the review the USER reads, without depending on the model having
 * complied. Same inputs, same numbers, one source.
 */
export type DiffCoverage = {
  /** Hunks that reached the prompt. */
  shown: number;
  /** Hunks the diff actually had. */
  total: number;
  /** Per-tier counts of what was cut, most-reviewable first. */
  omitted: Array<{ tier: DiffTier; count: number }>;
};

export function describeCoverage(
  kept: number,
  omitted: readonly { file: string }[],
): DiffCoverage {
  const byTier = new Map<DiffTier, number>();
  for (const h of omitted) {
    const t = tierOf(h.file);
    byTier.set(t, (byTier.get(t) ?? 0) + 1);
  }
  return {
    shown: kept,
    total: kept + omitted.length,
    omitted: DIFF_TIERS.filter((t) => byTier.has(t)).map((t) => ({
      tier: t,
      count: byTier.get(t)!,
    })),
  };
}

export function formatCoverageNotice(
  kept: number,
  omitted: readonly { file: string }[],
): string[] {
  const total = kept + omitted.length;
  const byTier = new Map<DiffTier, number>();
  for (const h of omitted) {
    const t = tierOf(h.file);
    byTier.set(t, (byTier.get(t) ?? 0) + 1);
  }
  const breakdown = DIFF_TIERS.filter((t) => byTier.has(t))
    .map((t) => `${byTier.get(t)} ${t}`)
    .join(" · ");

  return [
    "",
    `(+${omitted.length} more hunks omitted)`,
    "",
    `⚠️ **Partial diff — ${kept} of ${total} hunks shown.** Hunks are ranked source-first;` +
      " everything past the budget was CUT, not summarised.",
    `Not shown: ${breakdown}.`,
    "You MUST say so in `reasoning`: state the coverage" +
      ` (${kept}/${total}) and name what you could not see. Do not assert a file is` +
      " correct, or raise severity over code, that was never shown to you.",
  ];
}

// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * repo-graph-popovers.ts — content builders for anchor-popover consumers.
 *
 * Exports:
 *   confidenceTierWord(tier)          — chip label (no suffix)
 *   confidencePopoverTitle(tier)      — accessible name for confidence popover
 *   buildConfidencePopoverHtml(cov)   — confidence "why" popover
 *   groundedPopoverTitle()            — accessible name for grounded popover
 *   deriveInferredClaims(doc)         — walk arch-ground claim surfaces for "inferred" claims
 *   buildGroundedPopoverHtml(payload) — grounded "why" popover
 *
 * Content strings live here as the single source — callers do NOT re-derive copy.
 *
 * All dynamic numeric values use toLocaleString("en-US") for thousands
 * separators (3192 → "3,192"). Tier words are enum-safe; no user input
 * is interpolated for confidence popover — XSS risk is nil.
 * The inferred claim text comes from LLM-generated ArchModelDoc and IS
 * HTML-escaped via _escHtml() before interpolation (anchor-popover.ts JSDoc
 * specifies caller responsibility; we fulfill it here).
 */

import type { CoverageTier } from "../../../repo-graph/types";
import type { ArchModelDoc } from "../../../explain/arch-model-schema";

// ── Chip tier label (suffixes deleted — meaning lives in popover) ────────

/**
 * Returns the display word for the confidence tier chip.
 * Deletes the old "· path shown / · partial / · file-level fallback" suffixes;
 * those phrases now appear as action phrases in the ladder section of the popover.
 */
export function confidenceTierWord(tier: CoverageTier): string {
  if (tier === "green") return "high";
  if (tier === "yellow") return "medium";
  return "low";
}

// ── Confidence popover content ────────────────────────────────────────────

export interface CoverageInput {
  pct: number;
  tier: CoverageTier;
  resolvedCallsites: number;
  totalCallsites: number;
  /** Optional: total file count from SSR stats element (#rg-st-files).
   * same-page single source, honest fallback to "every file in this repo" when absent. */
  fileCount?: number;
}

/**
 * Tier-variant popover title (no "· graph confidence" suffix).
 * Exported so the call site can pass it as the popover's accessible name
 * (anchor-popover ariaLabel) without duplicating the variant logic.
 * aria-label only — no longer rendered as a visible title row (since 2026-06-12).
 */
export function confidencePopoverTitle(tier: CoverageTier): string {
  if (tier === "green") return "WHY THIS PATH IS TRUSTWORTHY";
  if (tier === "yellow") return "WHY THIS PATH IS PARTLY TRUSTWORTHY";
  return "WHY THIS PATH IS NOT TRUSTWORTHY";
}

/**
 * Builds the innerHTML for the confidence "why" popover.
 * Layout:
 *   formula → narrative (label-free, capitalized) →
 *   ladder → tier-variant paragraph (label-free, capitalized).
 * Title row removed (2026-06-12: title → aria-label only).
 * No footer, no verdict sentence.
 *
 * Called by repo-graph.ts covBtn click handler.
 */
export function buildConfidencePopoverHtml(cov: CoverageInput): string {
  const { pct, tier, resolvedCallsites, totalCallsites, fileCount } = cov;

  // Formula headline — mono, thousands-separated (en-US)
  const resolvedStr = resolvedCallsites.toLocaleString("en-US");
  const totalStr = totalCallsites.toLocaleString("en-US");
  const formulaLine = `${resolvedStr} ÷ ${totalStr} = ${pct}%`;

  // Narrative (label stripped, capitalized opening)
  const filesPreamble =
    fileCount !== undefined
      ? `We read all ${fileCount.toLocaleString("en-US")} files and found`
      : "We read every file in this repo and found";
  const whatWeCounted =
    `${filesPreamble} ${totalStr} places where code calls a function ` +
    `defined in this repo — ${resolvedStr} of them could be traced to exactly one definition. ` +
    `(Calls into external packages / stdlib aren't counted — no static analysis can link them.)`;

  // Ladder — three bands; current highlighted with <b> + tier dot (UNCHANGED rendering)
  const ladderBands = _ladderBands(tier, pct);

  // Tier-variant paragraph (label stripped, capitalized opening)
  const gap = totalCallsites - resolvedCallsites;
  const gapStr = gap.toLocaleString("en-US");
  const soWhat =
    tier === "green"
      ? `Every arrow you see is one of the ${resolvedStr} traced calls — real, never guessed. The ${gapStr} we couldn't trace are simply not drawn: a missing arrow doesn't mean the call doesn't exist.`
      : tier === "yellow"
        ? `Only the ${resolvedStr} traced calls are drawn — real, never guessed; the rest is left blank. The ${gapStr} we couldn't trace are not drawn: a missing arrow doesn't mean the call doesn't exist.`
        : `Too few calls could be traced (${gapStr} of ${totalStr} unresolved) for a function-level path to be honest — the view falls back to the file-level dependency graph.`;

  return (
    _formulaSection(formulaLine) +
    _defSection(whatWeCounted) +
    _rowSection(ladderBands) +
    _defSection(soWhat)
  );
}

/**
 * Builds the ladder row for the confidence popover.
 * Format: `<40 low ▏ 40–60 medium ▏ ≥60 high`
 * Current band wrapped in <b> with a tier dot prepended.
 * The "<" is HTML-escaped to "&lt;" because this goes into innerHTML.
 */
function _ladderBands(tier: CoverageTier, pct: number): string {
  const dot = `<span class="cb-dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor;vertical-align:middle;margin-right:3px"></span>`;
  const bands = [
    {
      key: "red",
      label: "&lt;40 low",
    },
    {
      key: "yellow",
      label: "40–60 medium",
    },
    {
      key: "green",
      label: `≥60 high`,
    },
  ];
  const rendered = bands.map(({ key, label }) => {
    if (key === tier) {
      // Current band: bold + dot; keep the full band label so all 3 remain present.
      // The dot + pct value visually indicates "you are here" without removing the label.
      return `<b>${dot}${label} (${pct}%)</b>`;
    }
    return label;
  });
  return rendered.join(" ▏ ");
}

// ── Shared section helpers ───────────────────────────────────────
// Single home for the popover wrapper HTML. BOTH builders use these
// (buildConfidencePopoverHtml migrated to them later — output-identical,
// pinned by its 47 unit + 20 acceptance tests; buildGroundedPopoverHtml from birth).

/** Wrap content in .ap-row (generic block with margin). */
function _rowSection(inner: string): string {
  return `<div class="ap-row">${inner}</div>`;
}

/** Wrap content in .ap-formula (mono headline). */
function _formulaSection(inner: string): string {
  return `<div class="ap-formula">${inner}</div>`;
}

/** Wrap content in .ap-def (soft-ink definition or action text). */
function _defSection(inner: string): string {
  return `<div class="ap-def">${inner}</div>`;
}

/** Wrap content in .ap-epistemic (dashed-top epistemic footer). */
function _epistemicSection(inner: string): string {
  return `<div class="ap-epistemic">${inner}</div>`;
}

// ── HTML escape helper ────────────────────────────────────────────────────────
// LLM-generated ArchModelDoc claim text is untrusted and MUST be escaped before
// interpolation into innerHTML. This helper escapes the four HTML-unsafe chars.
// Test: a <script>-bearing claim string must appear escaped in the output (XSS handoff note).
function _escHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }) as Record<string, string>)[c]!,
  );
}

// ── Grounded popover ──────────────────────────────────────────────────────

/**
 * Exported so the call site can pass it as the popover's accessible name
 * (anchor-popover ariaLabel) without duplicating the string.
 * Symmetric with confidencePopoverTitle (same a11y pattern).
 * aria-label only — no longer rendered as a visible title row (since 2026-06-12).
 */
export function groundedPopoverTitle(): string {
  return "WHY THIS DIAGRAM IS TRUSTWORTHY";
}

/**
 * Walk the SAME claim surfaces arch-ground.ts annotates (see groundArchModel in
 * src/explain/arch-ground.ts) collecting claims whose `tier === "inferred"`.
 *
 * Mirrors arch-ground's claim enumeration exactly (band.label / node.title /
 * node.band / node.desc / edge.verb tiers — per-claim granularity, NOT TierMap
 * keys which are coarser and would skew counts). Matches the walk in:
 *   src/explain/arch-ground.ts → groundArchModel() (bands loop, nodes loop, edges loop)
 *
 * Returns Array<{text: string}> — text is the raw claim value (callers must escape
 * before interpolating into innerHTML; buildGroundedPopoverHtml uses _escHtml).
 * Note: edge verb.value may read "uses" where arch-ground degraded an
 * unsupported verb at grounding time — the popover shows the grounded doc's
 * value, not the Brain's original wording.
 */
export function deriveInferredClaims(doc: ArchModelDoc): Array<{ text: string }> {
  const claims: Array<{ text: string }> = [];

  // ── band layer labels (mirrors arch-ground bands loop) ──────────────────────
  // arch-ground: bands.map(b => { tier = ...; return { ...b, label: { ...b.label, tier: tally(tier) } } })
  for (const b of doc.bands) {
    if (b.label.tier === "inferred") {
      claims.push({ text: b.label.value });
    }
    // topology-blind is NOT inferred — honest abstention, skip
  }

  // ── nodes: title (fact), band pointer (fact), desc (judgment) ──────────────
  // arch-ground: for (const n of doc.nodes) { tally titleTier; tally band tier; tally desc tier }
  for (const n of doc.nodes) {
    if (n.title.tier === "inferred") claims.push({ text: n.title.value });
    if (n.band.tier === "inferred") claims.push({ text: n.band.value });
    if (n.desc && n.desc.tier === "inferred") claims.push({ text: n.desc.value });
  }

  // ── edges: verb judgment ────────────────────────────────────────────────────
  // arch-ground: for (const e of doc.edges) { tally "cited" or "inferred" verb }
  for (const e of doc.edges) {
    if (e.verb.tier === "inferred") claims.push({ text: e.verb.value });
  }

  return claims;
}

export interface GroundedPopoverPayload {
  doc: ArchModelDoc;
  groundedPct: number;
  /** Serialized grounding counts. Absent on legacy caches —
   * popover renders gracefully from groundedPct only (graceful-absent). */
  citedClaims?: number;
  totalClaims?: number;
  topologyBlindClaims?: number;
}

/**
 * Builds the innerHTML for the grounded "why" popover.
 * Layout:
 *   formula + definition (label-free) → topology-blind (K>0 only) →
 *   inferred list (top-3 + +N more) → so-what (label-free) → epistemic line.
 * Title row removed (2026-06-12: title → aria-label only).
 * No ladder — groundedPct has no defined tier bands (inventing thresholds
 * = metric change, out of scope).
 *
 * Called by repo-graph.ts archChip click handler.
 *
 * XSS: inferred claim text comes from LLM-generated ArchModelDoc — always
 * HTML-escaped via _escHtml() before interpolation.
 *
 * Parity assertion: derived.length === totalClaims − citedClaims checked
 * at render; mismatch → console.warn("[grounded-popover] …") + list header
 * gains " (sample)" suffix. Never blocks render, never recomputes headline pct.
 */
export function buildGroundedPopoverHtml(p: GroundedPopoverPayload): string {
  const { doc, groundedPct, citedClaims, totalClaims, topologyBlindClaims } = p;
  const hasCounts = citedClaims !== undefined && totalClaims !== undefined;

  // Formula + definition (title row removed; label stripped, capitalized opening)
  let formulaHtml: string;
  let defHtml: string;
  if (hasCounts) {
    const citedStr = citedClaims!.toLocaleString("en-US");
    const totalStr = totalClaims!.toLocaleString("en-US");
    formulaHtml = _formulaSection(`${citedStr} ÷ ${totalStr} = ${groundedPct}%`);
    // FULL path: "What we counted" label stripped; capitalized opening
    const totalMinusCited = (totalClaims! - citedClaims!).toLocaleString("en-US");
    const defLine =
      `This diagram was written by AI. It makes ${totalStr} checkable statements — ` +
      `which layer each box belongs to, every arrow, each box's purpose. Each was checked against the repo's ` +
      `real import graph: ${citedStr} are backed by actual imports; ${totalMinusCited} are the AI's inference ` +
      `with no import evidence.`;
    defHtml = _defSection(defLine);
  } else {
    // Graceful-absent: render from groundedPct only, no fabricated ÷ arithmetic
    formulaHtml = _formulaSection(`grounded = ${groundedPct}%`);
    // REDUCED legacy path: "What this measures" label stripped; capitalized opening
    const defLine =
      `This diagram was written by AI; grounded% is the share of its checkable ` +
      `statements — layer assignments, arrows, box purposes — backed by the repo's real import graph rather ` +
      `than the AI's own inference.`;
    defHtml = _defSection(defLine);
  }

  // Topology-blind line (only when K > 0)
  let blindHtml = "";
  if (topologyBlindClaims !== undefined && topologyBlindClaims > 0) {
    blindHtml =
      _rowSection(
        `${topologyBlindClaims.toLocaleString("en-US")} claims layer-not-confirmable — ` +
          `omnipresent-shaped domain cores the import gradient cannot adjudicate; excluded from the denominator.`,
      );
  }

  // Inferred list (top-3 + +N more truncation)
  let inferredHtml = "";
  if (hasCounts) {
    const derived = deriveInferredClaims(doc);
    const expectedInferred = totalClaims! - citedClaims!;

    // Parity assertion: mismatch → warn + label header "(sample)"
    let listHeaderSuffix = "";
    if (derived.length !== expectedInferred) {
      console.warn(
        "[grounded-popover] derived/serialized count mismatch",
        { derived: derived.length, expected: expectedInferred, citedClaims, totalClaims },
      );
      listHeaderSuffix = " (sample)";
    }

    if (derived.length > 0) {
      const top3 = derived.slice(0, 3);
      const rest = derived.length - top3.length;
      const items = top3
        .map((c) => `<div class="ap-inferred-item">· "${_escHtml(c.text)}"</div>`)
        .join("");
      const moreHtml = rest > 0 ? `<div class="ap-inferred-more">+${rest} more</div>` : "";
      const headerText = `${expectedInferred} claim${expectedInferred !== 1 ? "s" : ""} inferred — no import-graph evidence found${listHeaderSuffix}:`;
      inferredHtml = _rowSection(
        `<div class="ap-inferred-header">${headerText}</div>` + items + moreHtml,
      );
    }
  }

  // "So what" paragraph (FULL path only — label stripped, capitalized opening)
  //    REDUCED path gets a hint line instead (no So-what: no per-claim data to reference)
  let soWhatHtml = "";
  let hintHtml = "";
  if (hasCounts) {
    const totalMinusCitedNum = totalClaims! - citedClaims!;
    const totalMinusCitedStr = totalMinusCitedNum.toLocaleString("en-US");
    const soWhatLine =
      `Solid arrows and labels are evidence-backed; the ${totalMinusCitedStr} inferred ` +
      `ones render dashed / lighter — read those with healthy doubt.`;
    soWhatHtml = _defSection(soWhatLine);
  } else {
    // REDUCED (legacy, counts absent): hint line in its own .ap-def block
    hintHtml =
      _defSection(
        "Re-generate to see exactly which statements are inferred — this cached diagram predates the per-claim breakdown.",
      );
  }

  // Epistemic line (verbatim, unchanged)
  const epistemicLine =
    `Re-generating may produce a different claim set — ${groundedPct}% ` +
    `describes this output only.`;
  const epistemicHtml = _epistemicSection(epistemicLine);

  return formulaHtml + defHtml + blindHtml + inferredHtml + soWhatHtml + hintHtml + epistemicHtml;
}

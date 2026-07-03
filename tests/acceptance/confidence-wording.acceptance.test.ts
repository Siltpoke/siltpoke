/**
 * NOTE (v2 copy): Content spec evolved.
 * Pinned string values updated to match v2 copy.
 * Flipped pins: definition-line → "What we counted"; action-phrase → So-what tier variants;
 * gap-line → gap number inside So-what; "confidence measures in-repo call sites" → "What we counted".
 *
 * confidence-wording.acceptance.test.ts — ACCEPTANCE tests for the confidence-chip
 * explainability surface.
 *
 * SCOPE:
 *   wording: chip text is `confidence <pct>%` + colored tier dot + tier word
 *     high/medium/low.  No "Graph" prefix, no "· path shown" / "· partial" /
 *     "· file-level fallback" suffix on the chip.  (Chip position is covered
 *     elsewhere — not tested here.)
 *   popover: formula headline with visible ÷ and = and thousands
 *     separators; definition line; threshold ladder with current band + action
 *     phrase; gap line = total − resolved; title tier variants WITHOUT
 *     "· graph confidence" suffix; footer "Computed automatically…" absent;
 *     old checklist absent; opens on chip click, closes on Escape with focus
 *     back on chip.
 *
 * ACCEPTANCE BOUNDARY — outside-observable behavior only:
 *   • Uses the real exported builders from src/ (confidenceTierWord,
 *     buildConfidencePopoverHtml) and the real anchor-popover primitive
 *     (openAnchorPopover).  NEVER re-implements content.
 *   • DOM is driven via GlobalRegistrator (happy-dom) — same harness as
 *     anchor-popover.test.ts (single-file register/unregister pattern).
 *   • Assertions target document DOM state (element presence, textContent,
 *     aria-expanded, document.activeElement) — not internal variables.
 *   • The chip is wired exactly as repo-graph.ts wires it: a button with
 *     id="rg-ph-cov" whose onclick calls openAnchorPopover with
 *     buildConfidencePopoverHtml(cov).
 *
 * Anti-vacuous discipline:
 *   • Wording tests assert OLD strings are ABSENT and NEW strings are
 *     PRESENT in the same assertion block — absence alone is not sufficient.
 *   • Popover click tests verify aria-expanded="false" BEFORE clicking to confirm
 *     the chip is in the expected pre-state; then assert the full popover DOM
 *     after click; then assert removal + focus after Escape.
 *   • Each test names at least one string that would appear in the OLD code but
 *     must be absent (anti-vacuous pairing).
 *
 * Run: bun test tests/acceptance/confidence-wording.acceptance.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  confidenceTierWord,
  confidencePopoverTitle,
  buildConfidencePopoverHtml,
  type CoverageInput,
} from "../../src/web/client/islands/repo-graph-popovers";
import {
  openAnchorPopover,
} from "../../src/web/client/islands/anchor-popover";

// ── DOM lifecycle (self-contained, per anchor-popover.test.ts pattern) ────────

const realFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:9876/repo-graph" });
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
});

afterEach(async () => {
  // Clean DOM state: remove any open popover + stale nodes.
  document.querySelector("[data-anchor-popover]")?.remove();
  document.body.innerHTML = "";
  // Allow microtasks / event queue to settle.
  await new Promise<void>((r) => setTimeout(r, 0));
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** High-confidence coverage: green tier, resolvedCallsites=3192, total=4186, pct=76 */
const COV_HIGH: CoverageInput = {
  pct: 76,
  tier: "green",
  resolvedCallsites: 3192,
  totalCallsites: 4186,
};

/** Medium-confidence coverage: yellow tier */
const COV_MED: CoverageInput = {
  pct: 50,
  tier: "yellow",
  resolvedCallsites: 100,
  totalCallsites: 200,
};

/** Low-confidence coverage: red tier */
const COV_LOW: CoverageInput = {
  pct: 30,
  tier: "red",
  resolvedCallsites: 30,
  totalCallsites: 100,
};

/**
 * Build a chip button that mirrors the exact HTML repo-graph.ts produces for
 * the confidence chip (phSyncBar → covHtml template).  The button is appended
 * to document.body and its onclick is wired to openAnchorPopover exactly as
 * the island wires it.  Returns the chip element.
 */
function makeChip(cov: CoverageInput): HTMLButtonElement {
  const wrap = document.createElement("div");
  wrap.className = "ph-cwrap";
  wrap.style.position = "relative"; // mirrors .rg-host .ph-cwrap{position:relative}

  const btn = document.createElement("button");
  btn.className = "ph-covinfo";
  btn.id = "rg-ph-cov";
  btn.setAttribute("aria-expanded", "false");
  btn.title = "Click to see why";

  // Build chip inner HTML exactly as phSyncBar does (line 4312 in repo-graph.ts):
  //   <span class="cb-dot"></span>confidence <b>${cov.pct}%</b>
  //   <span class="cb-go">${confidenceTierWord(cov.tier)}</span><span class="cv">▾</span>
  const dot = document.createElement("span");
  dot.className = "cb-dot";

  const pctEl = document.createElement("b");
  pctEl.textContent = `${cov.pct}%`;

  const tierSpan = document.createElement("span");
  tierSpan.className = "cb-go";
  tierSpan.textContent = confidenceTierWord(cov.tier); // ← real exported builder

  const caret = document.createElement("span");
  caret.className = "cv";
  caret.textContent = "▾";

  btn.appendChild(dot);
  btn.appendChild(document.createTextNode("confidence "));
  btn.appendChild(pctEl);
  btn.appendChild(tierSpan);
  btn.appendChild(caret);

  // Wire onclick exactly as repo-graph.ts line 4337-4344:
  btn.onclick = (e) => {
    e.stopPropagation();
    openAnchorPopover({
      trigger: btn,
      contentHtml: buildConfidencePopoverHtml(cov), // ← real exported builder
      ariaLabel: confidencePopoverTitle(cov.tier), // ← accessible name (cycle-2: title → aria-label only)
      width: 320,
      align: "left",
    });
  };

  wrap.appendChild(btn);
  document.body.appendChild(wrap);
  return btn;
}

function getPopover(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-anchor-popover]");
}

function tick(): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, 0));
}

// ═════════════════════════════════════════════════════════════════════════════
// Chip wording
// ═════════════════════════════════════════════════════════════════════════════

describe("wording — confidenceTierWord returns correct word (no suffix)", () => {
  test("wording-green: tier 'green' → 'high' (no '· path shown' suffix)", () => {
    const word = confidenceTierWord("green");
    // NEW: correct word present
    expect(word).toBe("high");
    // ANTI-VACUOUS: old suffix strings must be absent from the returned value
    expect(word).not.toContain("path shown");
    expect(word).not.toContain("partial");
    expect(word).not.toContain("file-level fallback");
  });

  test("wording-yellow: tier 'yellow' → 'medium' (no '· partial' suffix)", () => {
    const word = confidenceTierWord("yellow");
    expect(word).toBe("medium");
    expect(word).not.toContain("partial");
    expect(word).not.toContain("path shown");
  });

  test("wording-red: tier 'red' → 'low' (no '· file-level fallback' suffix)", () => {
    const word = confidenceTierWord("red");
    expect(word).toBe("low");
    expect(word).not.toContain("file-level fallback");
    expect(word).not.toContain("path shown");
  });
});

describe("wording — chip DOM text: 'confidence <pct>%' + tier dot + tier word", () => {
  test("wording-chip-text-high: chip reads 'confidence 76% high' (no 'Graph' prefix)", () => {
    const btn = makeChip(COV_HIGH);

    // PRESENCE: chip is in document
    expect(document.getElementById("rg-ph-cov")).not.toBeNull();

    // NEW chip text: 'confidence' present (no 'Graph' prefix)
    expect(btn.textContent).toContain("confidence");
    expect(btn.textContent).toContain("76%");
    expect(btn.textContent).toContain("high");

    // ANTI-VACUOUS: old 'Graph' prefix and suffix strings must be absent
    expect(btn.textContent).not.toContain("Graph");
    expect(btn.textContent).not.toContain("path shown");
    expect(btn.textContent).not.toContain("· partial");
    expect(btn.textContent).not.toContain("file-level fallback");

    // Tier dot element present (visual signal, part of the wording spec)
    const dot = btn.querySelector(".cb-dot");
    expect(dot).not.toBeNull();

    // Tier word element present with correct text
    const tierSpan = btn.querySelector(".cb-go");
    expect(tierSpan).not.toBeNull();
    expect(tierSpan!.textContent).toBe("high");
  });

  test("wording-chip-text-medium: chip reads 'confidence 50% medium' (no suffix)", () => {
    const btn = makeChip(COV_MED);

    expect(btn.textContent).toContain("confidence");
    expect(btn.textContent).toContain("50%");
    expect(btn.textContent).toContain("medium");
    expect(btn.textContent).not.toContain("Graph");
    expect(btn.textContent).not.toContain("partial");

    const tierSpan = btn.querySelector(".cb-go");
    expect(tierSpan!.textContent).toBe("medium");
  });

  test("wording-chip-text-low: chip reads 'confidence 30% low' (no suffix)", () => {
    const btn = makeChip(COV_LOW);

    expect(btn.textContent).toContain("confidence");
    expect(btn.textContent).toContain("30%");
    expect(btn.textContent).toContain("low");
    expect(btn.textContent).not.toContain("Graph");
    expect(btn.textContent).not.toContain("file-level fallback");

    const tierSpan = btn.querySelector(".cb-go");
    expect(tierSpan!.textContent).toBe("low");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Confidence popover content
// ═════════════════════════════════════════════════════════════════════════════

describe("confidence popover: opens on chip click, content, closes on Escape", () => {

  // ── formula headline ────────────────────────────────────────────────
  test("formula-headline: shows 'resolved ÷ total = pct%' with thousands separators", () => {
    const btn = makeChip(COV_HIGH);

    // Pre-condition: popover is NOT in DOM before click
    expect(getPopover()).toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();

    // Formula with thousands separators, visible ÷ and =
    expect(pop!.textContent).toContain("3,192 ÷ 4,186 = 76%");

    // ANTI-VACUOUS: old hand-built popover strings must be absent
    expect(pop!.textContent).not.toContain("Computed automatically");
    expect(pop!.innerHTML).not.toContain("graph confidence");
  });

  // ── definition line (cycle-2: label stripped, opens with "We read") ────
  test("definition-line: label-free, opens 'We read every file' (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const btn = makeChip(COV_HIGH);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(pop!.textContent).not.toContain("What we counted"); // label stripped
    expect(pop!.textContent).toContain("We read every file in this repo"); // capitalized opening
    // Still explains external/stdlib exclusion (v2 kept that)
    expect(pop!.textContent).toContain("external packages");
  });

  // ── threshold ladder ────────────────────────────────────────────────
  test("ladder-all-bands: all three threshold bands present (<40 / 40–60 / ≥60)", () => {
    const btn = makeChip(COV_HIGH);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    // The '<' is HTML-escaped to '&lt;' in innerHTML; textContent sees '<40'
    expect(pop!.textContent).toContain("<40");
    expect(pop!.textContent).toContain("40–60");
    expect(pop!.textContent).toContain("≥60");
  });

  test("so-what-high: label stripped → 'Every arrow you see' (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const btn = makeChip(COV_HIGH);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(pop!.textContent).not.toContain("So what:"); // bold lead-in stripped
    expect(pop!.textContent).toContain("Every arrow you see"); // capitalized opening
    expect(pop!.textContent).toContain("never guessed"); // v2 so-what green intact
    expect(pop!.textContent).toContain("missing arrow doesn't mean"); // v2 so-what green intact
  });

  test("so-what-medium: label stripped → 'Only the' (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const btn = makeChip(COV_MED);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(pop!.textContent).not.toContain("So what:"); // bold lead-in stripped
    expect(pop!.textContent).toContain("Only the"); // capitalized opening
    expect(pop!.textContent).toContain("rest is left blank"); // v2 so-what yellow intact
  });

  test("so-what-low: label stripped → 'Too few calls could be traced' (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const btn = makeChip(COV_LOW);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(pop!.textContent).not.toContain("So what:"); // bold lead-in stripped
    expect(pop!.textContent).toContain("Too few calls could be traced"); // capitalized opening
    expect(pop!.textContent).toContain("falls back to the file-level dependency graph"); // v2 so-what red intact
  });

  // ── gap line (cycle-2: gap number in label-free paragraph, 'Every arrow') ──
  test("gap-line: gap = 994 in label-free 'Every arrow you see' paragraph (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const btn = makeChip(COV_HIGH);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();

    // Gap value: 4186 - 3192 = 994 — inside label-free paragraph
    expect(pop!.textContent).toContain("994");
    expect(pop!.textContent).toContain("Every arrow you see"); // label-free opening

    // ANTI-VACUOUS: per-reason breakdown is explicitly out of scope
    expect(pop!.textContent).not.toContain("dynamic import");
    // Old standalone gap line removed
    expect(pop!.textContent).not.toContain("in-repo call sites couldn't be pinned");
  });

  // ── title tier variants — cycle-2: title in aria-label, NOT in content ──
  test("title-high: title in aria-label attribute NOT in content (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const btn = makeChip(COV_HIGH);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    // Title must be in aria-label (accessible name)
    expect(pop!.getAttribute("aria-label")).toBe("WHY THIS PATH IS TRUSTWORTHY");
    // Title must NOT be visible in content
    expect(pop!.textContent).not.toContain("WHY THIS PATH IS TRUSTWORTHY");
    // Other negative checks still hold
    expect(pop!.innerHTML).not.toContain("graph confidence");
    expect(pop!.textContent).not.toContain("Overall:");
  });

  test("title-medium: 'PARTLY TRUSTWORTHY' in aria-label not content (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const btn = makeChip(COV_MED);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(pop!.getAttribute("aria-label")).toBe("WHY THIS PATH IS PARTLY TRUSTWORTHY");
    expect(pop!.textContent).not.toContain("PARTLY TRUSTWORTHY");
    expect(pop!.innerHTML).not.toContain("graph confidence");
  });

  test("title-low: 'NOT TRUSTWORTHY' in aria-label not content (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const btn = makeChip(COV_LOW);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(pop!.getAttribute("aria-label")).toBe("WHY THIS PATH IS NOT TRUSTWORTHY");
    expect(pop!.textContent).not.toContain("NOT TRUSTWORTHY");
    expect(pop!.innerHTML).not.toContain("graph confidence");
  });

  // ── footer absent ───────────────────────────────────────────────────
  test("footer-absent: 'Computed automatically…' footer line is REMOVED", () => {
    const btn = makeChip(COV_HIGH);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    // ANTI-VACUOUS: popover IS present (the absence assertion is meaningful)
    expect(pop!.textContent!.length).toBeGreaterThan(50);
    // Footer removed
    expect(pop!.textContent).not.toContain("Computed automatically");
  });

  // ── old checklist absent ────────────────────────────────────────────────
  test("old-checklist-absent: old checklist items absent from popover", () => {
    const btn = makeChip(COV_HIGH);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    // Old checklist phrases that were removed
    expect(pop!.textContent).not.toContain("Only confirmed edges drawn");
    expect(pop!.textContent).not.toContain("path shown");
    // Old phrasing "in-repo call-sites pinned" (with hyphen — old form)
    expect(pop!.textContent).not.toContain("in-repo call-sites pinned");
  });

  // ── opens on chip click ───────────────────────────────────────────────
  test("opens-on-click: chip click opens popover + sets aria-expanded=true", () => {
    const btn = makeChip(COV_HIGH);

    // Pre-state: aria-expanded is false, no popover
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(getPopover()).toBeNull();

    btn.click();

    // Post-state: popover present, aria-expanded true
    expect(getPopover()).not.toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  // ── closes on Escape + focus returns ──────────────────────────────────
  test("escape-closes-focus-returns: Escape closes popover and focuses chip", async () => {
    const btn = makeChip(COV_HIGH);
    btn.focus();

    // Confirm focus is on chip before opening
    expect(document.activeElement).toBe(btn);

    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("true");

    // Dispatch Escape — anchor-popover listens in capture phase
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();

    // Popover is GONE from DOM
    expect(getPopover()).toBeNull();

    // aria-expanded reset to false
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    // Focus returned to chip
    expect(document.activeElement).toBe(btn);
  });
});

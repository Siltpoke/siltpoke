/**
 * NOTE (v2 copy): Content spec evolved.
 * Pinned string values updated to match v2 copy.
 * Flipped pins: definition → "What we counted" / "What this measures";
 * ADD So-what pin; ADD reduced-version hint-line pin.
 *
 * grounded-popover-copy.acceptance.test.ts — ACCEPTANCE tests for the grounded
 * popover explainability surface (client half).
 *
 * SCOPE:
 *   formula headline `<cited> ÷ <total> = <pct>%` + definition line
 *   containing "not the LLM grading itself"
 *   topology-blind line shown when K>0 with "layer-not-confirmable";
 *   ABSENT when K=0
 *   inferred list from a fixture ArchModelDoc (≥5 inferred claims across
 *   different surfaces: band.label, node.title, node.desc, edge.verb) →
 *   top 3 rendered + "+2 more"; claim text with <script>alert(1)</script>
 *   renders ESCAPED (no raw <script> in innerHTML)
 *   epistemic line "describes this output only"
 *   title "WHY THIS DIAGRAM IS TRUSTWORTHY"
 *   parity — matching counts → no "(sample)"; mismatched counts →
 *   header contains "(sample)" + console.warn fired (spy); render
 *   never throws
 *   Legacy: counts undefined → popover still renders, headline from groundedPct,
 *           NO fabricated "0 ÷ 0"
 *   Interaction: clicking the real #rg-arch-chip button opens the popover
 *               (aria-expanded true), Escape closes + focus returns
 *
 * ACCEPTANCE BOUNDARY — outside-observable behavior only:
 *   • Uses the real exported builders:
 *       buildGroundedPopoverHtml, groundedPopoverTitle, deriveInferredClaims
 *     from src/web/client/islands/repo-graph-popovers.
 *   • DOM driven via GlobalRegistrator (happy-dom) — same harness as the
 *     confidence-chip acceptance tests.
 *   • Assertions target document DOM state — not internal variables.
 *   • The chip is wired exactly as repo-graph.ts wires the arch chip:
 *     a button with id="rg-arch-chip" whose onclick calls openAnchorPopover
 *     with buildGroundedPopoverHtml(payload).
 *
 * Anti-vacuous discipline:
 *   • Formula test asserts BOTH presence of new formula AND absence of fabricated
 *     "0 ÷ 0" (what old/absent code would have shown).
 *   • Topology-blind negative assertion (K=0) verifies that "layer-not-confirmable" is
 *     absent; old code always showed the line, this would catch a regression.
 *   • XSS assertion verifies innerHTML does NOT contain raw "<script";
 *     old code without _escHtml() would have left it raw.
 *   • Truncation asserts both "+2 more" present AND the 4th/5th claim
 *     text absent (would appear if top-N limit was missing).
 *   • Parity mismatch: asserts "(sample)" PRESENT + warn spy called;
 *     old code without parity check would never add "(sample)".
 *   • Parity match: asserts "(sample)" ABSENT — old code that always
 *     adds "(sample)" would fail.
 *   • Each click test verifies aria-expanded="false" BEFORE click (pre-state
 *     proves the assertion is meaningful post-click).
 *
 * Run: bun test tests/acceptance/grounded-popover-copy.acceptance.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  spyOn,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  buildGroundedPopoverHtml,
  groundedPopoverTitle,
  deriveInferredClaims,
  type GroundedPopoverPayload,
  // groundedPopoverTitle used for ariaLabel in makeArchChip (cycle-2: title → aria-label only)
} from "../../src/web/client/islands/repo-graph-popovers";
import { openAnchorPopover } from "../../src/web/client/islands/anchor-popover";
import type { ArchModelDoc } from "../../src/explain/arch-model-schema";

// ── DOM lifecycle (self-contained, matching the confidence-chip acceptance harness) ────────────────────────

const realFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:9876/repo-graph" });
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
});

afterEach(async () => {
  document.querySelector("[data-anchor-popover]")?.remove();
  document.body.innerHTML = "";
  await new Promise<void>((r) => setTimeout(r, 0));
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Minimal ArchModelDoc with exactly 5 inferred claims spread across different
 * claim surfaces:
 *   1. band.label — "Presentation Layer"  (tier: inferred)
 *   2. node.title — "Dashboard UI"        (tier: inferred)
 *   3. node.desc  — "Handles SSR routes"  (tier: inferred)
 *   4. edge.verb  — "calls"               (tier: inferred)
 *   5. edge.verb  — "invokes"             (tier: inferred)
 *
 * Also includes one node with a node.band claim as cited (to ensure it is NOT
 * counted as inferred) and one band.label as cited.
 *
 * Total: 5 inferred → top 3 rendered, "+2 more"
 */
const FIXTURE_DOC: ArchModelDoc = {
  boundary: "test-repo",
  bands: [
    {
      id: "band-1",
      label: { value: "Presentation Layer", evidence: [], tier: "inferred" },
      order: 0,
      members: ["node-1"],
    },
    {
      id: "band-2",
      label: { value: "Core Layer", evidence: [], tier: "cited" },
      order: 1,
      members: ["node-2"],
    },
  ],
  nodes: [
    {
      id: "node-1",
      kind: "cont",
      title: { value: "Dashboard UI", evidence: [], tier: "inferred" },
      band: { value: "band-1", evidence: [], tier: "cited" },
      desc: { value: "Handles SSR routes", evidence: [], tier: "inferred" },
    },
    {
      id: "node-2",
      kind: "cont",
      title: { value: "Memory Store", evidence: [], tier: "cited" },
      band: { value: "band-2", evidence: [], tier: "cited" },
    },
  ],
  edges: [
    {
      source: "node-1",
      target: "node-2",
      verb: { value: "calls", evidence: [], tier: "inferred" },
    },
    {
      source: "node-2",
      target: "node-1",
      verb: { value: "invokes", evidence: [], tier: "inferred" },
    },
  ],
};

/**
 * ArchModelDoc fixture with an XSS payload in one claim.
 * 5 inferred claims total: same structure as FIXTURE_DOC but band.label
 * contains the XSS string.
 */
const FIXTURE_DOC_XSS: ArchModelDoc = {
  boundary: "xss-repo",
  bands: [
    {
      id: "band-xss",
      label: {
        value: '<script>alert(1)</script>',
        evidence: [],
        tier: "inferred",
      },
      order: 0,
      members: ["node-xss-1"],
    },
    {
      id: "band-2",
      label: { value: "Core Layer", evidence: [], tier: "cited" },
      order: 1,
      members: ["node-xss-2"],
    },
  ],
  nodes: [
    {
      id: "node-xss-1",
      kind: "cont",
      title: { value: "XSS Node", evidence: [], tier: "inferred" },
      band: { value: "band-xss", evidence: [], tier: "cited" },
      desc: { value: "XSS desc claim", evidence: [], tier: "inferred" },
    },
    {
      id: "node-xss-2",
      kind: "cont",
      title: { value: "Safe Node", evidence: [], tier: "cited" },
      band: { value: "band-2", evidence: [], tier: "cited" },
    },
  ],
  edges: [
    {
      source: "node-xss-1",
      target: "node-xss-2",
      verb: { value: "edge-inferred-1", evidence: [], tier: "inferred" },
    },
    {
      source: "node-xss-2",
      target: "node-xss-1",
      verb: { value: "edge-inferred-2", evidence: [], tier: "inferred" },
    },
  ],
};

/** Standard grounded payload: counts parity-matched (5 inferred → totalClaims=8, cited=3). */
const PAYLOAD_MATCHED: GroundedPopoverPayload = {
  doc: FIXTURE_DOC,
  groundedPct: 62,
  citedClaims: 3,
  totalClaims: 8,   // totalClaims − citedClaims = 5 == derived.length ✓
  topologyBlindClaims: 0,
};

/** Payload with topology-blind K>0. */
const PAYLOAD_TOPOLOGY_BLIND: GroundedPopoverPayload = {
  doc: FIXTURE_DOC,
  groundedPct: 55,
  citedClaims: 3,
  totalClaims: 8,
  topologyBlindClaims: 4,
};

/** Payload with mismatched counts (parity mismatch path). */
const PAYLOAD_MISMATCHED: GroundedPopoverPayload = {
  doc: FIXTURE_DOC,
  groundedPct: 62,
  citedClaims: 3,
  totalClaims: 18,  // totalClaims − citedClaims = 15 ≠ 5 (derived.length)
  topologyBlindClaims: 0,
};

/** Legacy payload: no counts (graceful-absent). */
const PAYLOAD_LEGACY: GroundedPopoverPayload = {
  doc: FIXTURE_DOC,
  groundedPct: 78,
  // citedClaims and totalClaims intentionally absent
};

/** XSS payload: counts matched so inferred list renders. */
const PAYLOAD_XSS: GroundedPopoverPayload = {
  doc: FIXTURE_DOC_XSS,
  groundedPct: 37,
  citedClaims: 3,
  totalClaims: 8,
  topologyBlindClaims: 0,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build an arch chip button that mirrors the exact HTML repo-graph.ts would
 * produce for the grounded chip (id="rg-arch-chip"). Wire onclick exactly as the
 * island wires it: calls openAnchorPopover with buildGroundedPopoverHtml(payload).
 * Returns the chip element.
 */
function makeArchChip(payload: GroundedPopoverPayload): HTMLButtonElement {
  const wrap = document.createElement("div");
  wrap.className = "ph-cwrap";
  wrap.style.position = "relative";

  const btn = document.createElement("button");
  btn.className = "ph-archinfo";
  btn.id = "rg-arch-chip";
  btn.setAttribute("aria-expanded", "false");
  btn.title = "Click to see why";

  const pct = payload.groundedPct;
  btn.textContent = `grounded ${pct}%`;

  btn.onclick = (e) => {
    e.stopPropagation();
    openAnchorPopover({
      trigger: btn,
      contentHtml: buildGroundedPopoverHtml(payload),
      ariaLabel: groundedPopoverTitle(), // ← accessible name (cycle-2: title → aria-label only)
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
// Title
// ═════════════════════════════════════════════════════════════════════════════

describe("groundedPopoverTitle returns 'WHY THIS DIAGRAM IS TRUSTWORTHY'", () => {
  test("title-string: title function returns expected string (aria-label only; cycle-2)", () => {
    const title = groundedPopoverTitle();
    // PRESENCE: correct title (used as aria-label, invisible)
    expect(title).toBe("WHY THIS DIAGRAM IS TRUSTWORTHY");
    // ANTI-VACUOUS: wrong titles that old/stub code might return
    expect(title).not.toContain("PATH");
    expect(title).not.toContain("CONFIDENCE");
    expect(title).not.toContain("GROUNDED");  // must not use the word "GROUNDED" in the title
  });

  test("title-in-aria-label: title in aria-label attribute NOT in textContent (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const btn = makeArchChip(PAYLOAD_MATCHED);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    // Title in aria-label (accessible name, invisible)
    expect(pop!.getAttribute("aria-label")).toBe("WHY THIS DIAGRAM IS TRUSTWORTHY");
    // Title NOT in visible content
    expect(pop!.textContent).not.toContain("WHY THIS DIAGRAM IS TRUSTWORTHY");
    // ANTI-VACUOUS: confidence title should NOT appear (wrong popover)
    expect(pop!.textContent).not.toContain("WHY THIS PATH IS");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Formula headline + definition line
// ═════════════════════════════════════════════════════════════════════════════

describe("formula headline and definition line", () => {
  test("formula: '<cited> ÷ <total> = <pct>%' format with thousands separators", () => {
    const btn = makeArchChip(PAYLOAD_MATCHED);

    // Pre-state: no popover
    expect(getPopover()).toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();

    // PRESENCE: correct formula (3 ÷ 8 = 62%)
    expect(pop!.textContent).toContain("3 ÷ 8 = 62%");

    // ANTI-VACUOUS: fabricated "0 ÷ 0" must NEVER appear (what missing counts would produce)
    expect(pop!.textContent).not.toContain("0 ÷ 0");
    // Old confidence-popover formula format must not bleed in
    expect(pop!.textContent).not.toContain("3,192 ÷ 4,186");
  });

  test("definition: label stripped — opens 'This diagram was written by AI' (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const btn = makeArchChip(PAYLOAD_MATCHED);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();

    // PRESENCE: label-free FULL definition narrative
    expect(pop!.textContent).not.toContain("What we counted"); // label stripped
    expect(pop!.textContent).toContain("This diagram was written by AI");
    expect(pop!.textContent).toContain("checkable statements");

    // ANTI-VACUOUS: old definition phrase removed
    expect(pop!.textContent).not.toContain("not the LLM grading itself");
    expect(pop!.textContent).not.toContain("pinned to exactly one definition");
  });

  test("so-what: label stripped → 'Solid arrows and labels' (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const btn = makeArchChip(PAYLOAD_MATCHED);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(pop!.textContent).not.toContain("So what:"); // bold lead-in stripped
    expect(pop!.textContent).toContain("Solid arrows and labels are evidence-backed"); // capitalized opening
    expect(pop!.textContent).toContain("inferred ones render dashed"); // so-what phrasing intact
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Topology-blind line
// ═════════════════════════════════════════════════════════════════════════════

describe("topology-blind line: shown K>0, absent K=0", () => {
  test("shown-when-K-gt-0: 'layer-not-confirmable' present when K=4", () => {
    const btn = makeArchChip(PAYLOAD_TOPOLOGY_BLIND);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();

    // PRESENCE: topology-blind line shown
    expect(pop!.textContent).toContain("layer-not-confirmable");
    expect(pop!.textContent).toContain("4");

    // ANTI-VACUOUS: if K=0 branch was always taken, this would fail
  });

  test("absent-when-K-eq-0: 'layer-not-confirmable' absent when K=0", () => {
    const btn = makeArchChip(PAYLOAD_MATCHED); // topologyBlindClaims: 0
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    // ANTI-VACUOUS: old code that always showed this line would fail here
    expect(pop!.textContent).not.toContain("layer-not-confirmable");

    // Popover is still substantive — the absence is meaningful
    expect(pop!.textContent!.length).toBeGreaterThan(50);
  });

  test("absent-when-K-undefined: 'layer-not-confirmable' absent when topologyBlindClaims not set", () => {
    const payload: GroundedPopoverPayload = {
      doc: FIXTURE_DOC,
      groundedPct: 62,
      citedClaims: 3,
      totalClaims: 8,
      // topologyBlindClaims intentionally absent
    };
    const btn = makeArchChip(payload);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(pop!.textContent).not.toContain("layer-not-confirmable");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Inferred claims list: top-3 + +N more + XSS escape
// ═════════════════════════════════════════════════════════════════════════════

describe("inferred claims list and XSS escape", () => {
  test("derive-count: deriveInferredClaims on FIXTURE_DOC returns 5 items", () => {
    const claims = deriveInferredClaims(FIXTURE_DOC);
    // PRESENCE: exactly 5 inferred claims (anti-vacuous: 0 would mean derive is broken)
    expect(claims).toHaveLength(5);
    // Verify spread across surfaces (band.label, node.title, node.desc, edge.verb × 2)
    const texts = claims.map((c) => c.text);
    expect(texts).toContain("Presentation Layer"); // band.label
    expect(texts).toContain("Dashboard UI");       // node.title
    expect(texts).toContain("Handles SSR routes"); // node.desc
    expect(texts).toContain("calls");              // edge.verb
    expect(texts).toContain("invokes");            // edge.verb
  });

  test("top3-rendered: FIXTURE_DOC fixture shows top 3 claims + '+2 more'", () => {
    const btn = makeArchChip(PAYLOAD_MATCHED);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();

    // PRESENCE: "+2 more" truncation line
    expect(pop!.textContent).toContain("+2 more");

    // PRESENCE: first 3 claims appear (band.label, node.title, node.desc — order from walk)
    expect(pop!.textContent).toContain("Presentation Layer");
    expect(pop!.textContent).toContain("Dashboard UI");
    expect(pop!.textContent).toContain("Handles SSR routes");

    // ANTI-VACUOUS: 4th + 5th claims (edge verbs) must NOT appear as list items
    // — if top-N limit was missing, they would appear verbatim
    // They appear truncated via "+2 more" — their raw text should NOT be in a list item
    const items = pop!.querySelectorAll(".ap-inferred-item");
    const itemTexts = Array.from(items).map((el) => el.textContent ?? "");
    expect(itemTexts.some((t) => t.includes("calls"))).toBe(false);
    expect(itemTexts.some((t) => t.includes("invokes"))).toBe(false);
  });

  test("xss-escaped: XSS claim text renders escaped in innerHTML (no raw <script)", () => {
    const btn = makeArchChip(PAYLOAD_XSS);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();

    // ANTI-VACUOUS: raw <script tag must NOT appear in innerHTML
    // (old code without _escHtml() would leave it raw)
    expect(pop!.innerHTML).not.toContain("<script");

    // PRESENCE: the escaped form IS present (proves content rendered, not silently dropped)
    expect(pop!.innerHTML).toContain("&lt;script");
  });

  test("xss-dom-safe: <script>alert(1)</script> claim does NOT execute or inject", () => {
    const btn = makeArchChip(PAYLOAD_XSS);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();

    // Extra safety: no <script> element was injected into the popover
    const scriptEls = pop!.querySelectorAll("script");
    expect(scriptEls.length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Epistemic line
// ═════════════════════════════════════════════════════════════════════════════

describe("epistemic line: 'describes this output only'", () => {
  test("epistemic-present: epistemic line contains 'describes this output only'", () => {
    const btn = makeArchChip(PAYLOAD_MATCHED);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();

    // PRESENCE: verbatim phrase from spec
    expect(pop!.textContent).toContain("describes this output only");
    // Also contains the groundedPct value in the epistemic line
    expect(pop!.textContent).toContain("62%");

    // ANTI-VACUOUS: confidence footer "Computed automatically" must be absent
    // (would appear if confidence popover content bled into grounded popover)
    expect(pop!.textContent).not.toContain("Computed automatically");
  });

  test("epistemic-mentions-regenerate: epistemic line mentions re-generating", () => {
    const btn = makeArchChip(PAYLOAD_MATCHED);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(pop!.textContent).toContain("Re-generating");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Parity assertion (client)
// ═════════════════════════════════════════════════════════════════════════════

describe("parity: matching counts no '(sample)', mismatch warns + '(sample)'", () => {
  test("matched-no-sample: counts match → header has no '(sample)' suffix", () => {
    const btn = makeArchChip(PAYLOAD_MATCHED);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();

    // ANTI-VACUOUS: old code that always adds "(sample)" would fail here
    expect(pop!.textContent).not.toContain("(sample)");

    // Popover has substantive content (renders, doesn't throw)
    expect(pop!.textContent!.length).toBeGreaterThan(50);
  });

  test("mismatch-sample: counts mismatch → header contains '(sample)'", () => {
    // PAYLOAD_MISMATCHED: totalClaims=18, citedClaims=3 → expected=15, derived=5 → mismatch
    const btn = makeArchChip(PAYLOAD_MISMATCHED);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();

    // PRESENCE: "(sample)" label on mismatch
    // ANTI-VACUOUS: code without parity check would never add "(sample)"
    expect(pop!.textContent).toContain("(sample)");
  });

  test("mismatch-warn: mismatch fires console.warn with '[grounded-popover]' prefix", () => {
    const warnSpy = spyOn(console, "warn");

    const btn = makeArchChip(PAYLOAD_MISMATCHED);
    btn.click();

    // PRESENCE: warn was called
    expect(warnSpy).toHaveBeenCalled();

    // The warn message starts with the expected prefix
    const calls = warnSpy.mock.calls;
    const relevant = calls.find(
      (args) => typeof args[0] === "string" && (args[0] as string).includes("[grounded-popover]"),
    );
    expect(relevant).not.toBeUndefined();

    // ANTI-VACUOUS: without the parity check, warn would never fire
    warnSpy.mockRestore();
  });

  test("mismatch-never-throws: mismatched counts never block render", () => {
    const btn = makeArchChip(PAYLOAD_MISMATCHED);

    // Rendering must not throw — wrap in try/catch and assert no throw
    let caught: unknown = null;
    try {
      btn.click();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeNull();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(pop!.textContent!.length).toBeGreaterThan(50);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Legacy — counts undefined → graceful render, no "0 ÷ 0"
// ═════════════════════════════════════════════════════════════════════════════

describe("Legacy — counts absent → popover renders from groundedPct, no fabricated 0 ÷ 0", () => {
  test("legacy-renders: popover renders without citedClaims/totalClaims", () => {
    const btn = makeArchChip(PAYLOAD_LEGACY); // no counts
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    // Popover has substantive content
    expect(pop!.textContent!.length).toBeGreaterThan(50);
  });

  test("legacy-no-fabricated-formula: 'grounded = 78%' shown, NOT '0 ÷ 0'", () => {
    const btn = makeArchChip(PAYLOAD_LEGACY);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();

    // PRESENCE: graceful-absent formula using groundedPct
    expect(pop!.textContent).toContain("grounded = 78%");

    // ANTI-VACUOUS: fabricated "0 ÷ 0" must NEVER appear
    // (old code that hardcoded counts when absent would show this)
    expect(pop!.textContent).not.toContain("0 ÷ 0");
    expect(pop!.textContent).not.toContain("÷ 0");
  });

  test("legacy-what-this-measures: label stripped → 'This diagram was written by AI; grounded%' (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const btn = makeArchChip(PAYLOAD_LEGACY);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(pop!.textContent).not.toContain("What this measures"); // label stripped
    expect(pop!.textContent).toContain("This diagram was written by AI"); // capitalized opening
    expect(pop!.textContent).toContain("grounded%"); // reduced narrative phrasing intact
  });

  test("legacy-hint-line: v2 REDUCED re-generate hint line present (v2 copy)", () => {
    // flipped per 2026-06-12 v2 copy (v2 copy)
    const btn = makeArchChip(PAYLOAD_LEGACY);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(pop!.textContent).toContain("Re-generate to see exactly which statements are inferred");
    expect(pop!.textContent).toContain("predates the per-claim breakdown"); // hint line phrasing
  });

  test("legacy-title-in-aria-label: title in aria-label NOT in content on legacy payload (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const btn = makeArchChip(PAYLOAD_LEGACY);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(pop!.getAttribute("aria-label")).toBe("WHY THIS DIAGRAM IS TRUSTWORTHY"); // accessible name
    expect(pop!.textContent).not.toContain("WHY THIS DIAGRAM IS TRUSTWORTHY"); // not in content
  });

  test("legacy-epistemic-present: epistemic line still renders on legacy payload", () => {
    const btn = makeArchChip(PAYLOAD_LEGACY);
    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(pop!.textContent).toContain("describes this output only");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Interaction — chip opens popover (aria-expanded), Escape closes + focus returns
// ═════════════════════════════════════════════════════════════════════════════

describe("Interaction — arch chip click opens popover, Escape closes with focus return", () => {
  test("interaction-opens-on-click: chip click opens popover + sets aria-expanded=true", () => {
    const btn = makeArchChip(PAYLOAD_MATCHED);

    // Pre-state: aria-expanded is false, no popover
    // ANTI-VACUOUS: if already expanded, the post-state assertion would be trivial
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(getPopover()).toBeNull();

    btn.click();

    // Post-state: popover present, aria-expanded true
    expect(getPopover()).not.toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  test("interaction-escape-closes-focus-returns: Escape closes popover + focus returns to chip", async () => {
    const btn = makeArchChip(PAYLOAD_MATCHED);
    btn.focus();

    // Confirm focus is on chip before opening
    expect(document.activeElement).toBe(btn);

    btn.click();

    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("true");

    // Dispatch Escape — anchor-popover listens in capture phase
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await tick();

    // Popover is GONE from DOM
    // ANTI-VACUOUS: if Escape handler was missing, popover would still be present
    expect(getPopover()).toBeNull();

    // aria-expanded reset to false
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    // Focus returned to chip (via anchor-popover)
    expect(document.activeElement).toBe(btn);
  });

  // NOTE: The arch chip's full island wiring in repo-graph.ts requires substantial
  // SSR state setup (Alpine.js + server-rendered payload hydration + rg-host
  // initialization). Driving the REAL SSR markup end-to-end at acceptance level
  // (equivalent to the confidence-chip test which drives repo-graph.ts directly) would
  // require reproducing the full repo-graph island bootstrap — out of scope for a
  // non-E2E acceptance boundary.
  //
  // UNTESTABLE-at-acceptance-level: full island wiring via SSR markup
  // Reason: repo-graph.ts's archChip onclick is wired after parseInitialPayload() +
  // Alpine.js store hydration; reproducing that init chain here would be re-
  // implementing the island, violating the "never re-implement content" boundary.
  // Coverage: E2E (Playwright arch-toggle-regenerate-screenshots.spec.ts) covers
  // the real live wiring.
});

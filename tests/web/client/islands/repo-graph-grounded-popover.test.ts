/**
 * Unit tests: grounded popover content builder + inferred-claims deriver.
 *
 * Pins the exact content spec for the grounded popover (content) and the
 * client-half parity assertion (mismatch detection).
 *
 * No DOM harness needed — these are pure string functions.
 *
 * // copy notes:
 * //   definition pins → "What we counted" / "What this measures" narratives
 * //   ADD reduced-version hint-line pin
 * //   ADD So-what pin
 */
import { describe, expect, mock, test } from "bun:test";
import type { ArchModelDoc } from "../../../../src/explain/arch-model-schema";
import {
  buildGroundedPopoverHtml,
  deriveInferredClaims,
  groundedPopoverTitle,
} from "../../../../src/web/client/islands/repo-graph-popovers";

// ── Fixture helpers ─────────────────────────────────────────────────────────

/** Minimal ArchModelDoc fixture: 2 cited claims, 1 inferred claim, 1 topology-blind */
function makeDoc(overrides: Partial<ArchModelDoc> = {}): ArchModelDoc {
  return {
    boundary: "test-repo",
    bands: [
      {
        id: "b1",
        label: { value: "presentation", evidence: [{ file: "src/web/index.ts", line: 1 }], tier: "cited" },
        order: 0,
        members: ["node1"],
      },
      {
        id: "b2",
        // topology-blind band — should NOT appear in inferred list
        label: { value: "domain core", evidence: [], tier: "topology-blind" },
        order: 1,
        members: ["node2"],
      },
    ],
    nodes: [
      {
        id: "node1",
        kind: "cont",
        title: { value: "Web UI", evidence: [{ file: "src/web/index.ts", line: 5 }], tier: "cited" },
        band: { value: "b1", evidence: [{ file: "src/web/index.ts", line: 5 }], tier: "cited" },
        desc: { value: "Handles user interface rendering", evidence: [], tier: "inferred" },
      },
      {
        id: "node2",
        kind: "cont",
        title: { value: "Domain Core", evidence: [], tier: "inferred" },
        band: { value: "b2", evidence: [], tier: "inferred" },
      },
    ],
    edges: [
      {
        source: "node2",
        target: "node1",
        verb: { value: "calls", evidence: [], tier: "inferred" },
      },
    ],
    groundedPct: 67,
    ...overrides,
  };
}

/** Fixture with 5 inferred claims for truncation tests */
function makeDocWith5Inferred(): ArchModelDoc {
  return {
    boundary: "test-repo",
    bands: [],
    nodes: [
      {
        id: "n1",
        kind: "cont",
        title: { value: "Alpha Service", evidence: [], tier: "inferred" },
        band: { value: "b1", evidence: [], tier: "inferred" },
        desc: { value: "Handles alpha workflows", evidence: [], tier: "inferred" },
      },
      {
        id: "n2",
        kind: "cont",
        title: { value: "Beta Service", evidence: [], tier: "inferred" },
        band: { value: "b1", evidence: [], tier: "inferred" },
      },
      {
        id: "n3",
        kind: "ext",
        title: { value: "External DB", evidence: [], tier: "inferred" },
        band: { value: "b1", evidence: [], tier: "inferred" },
      },
    ],
    edges: [
      {
        source: "n1",
        target: "n2",
        verb: { value: "invokes", evidence: [], tier: "inferred" },
      },
      {
        source: "n2",
        target: "n3",
        verb: { value: "persists", evidence: [], tier: "inferred" },
      },
    ],
    groundedPct: 0,
  };
}

// ── deriveInferredClaims ────────────────────────────────────────────────────

describe("deriveInferredClaims", () => {
  test("collects inferred band labels", () => {
    // band.label with tier "inferred" should be collected
    const doc: ArchModelDoc = {
      boundary: "test",
      bands: [
        {
          id: "b1",
          label: { value: "presentation layer", evidence: [], tier: "inferred" },
          order: 0,
          members: [],
        },
      ],
      nodes: [],
      edges: [],
    };
    const claims = deriveInferredClaims(doc);
    expect(claims.some((c) => c.text === "presentation layer")).toBe(true);
  });

  test("skips topology-blind band labels (not 'inferred')", () => {
    const doc: ArchModelDoc = {
      boundary: "test",
      bands: [
        {
          id: "b1",
          label: { value: "domain core", evidence: [], tier: "topology-blind" },
          order: 0,
          members: [],
        },
      ],
      nodes: [],
      edges: [],
    };
    const claims = deriveInferredClaims(doc);
    expect(claims.length).toBe(0);
  });

  test("collects inferred node title, band pointer, desc", () => {
    const doc: ArchModelDoc = {
      boundary: "test",
      bands: [],
      nodes: [
        {
          id: "n1",
          kind: "cont",
          title: { value: "My Service", evidence: [], tier: "inferred" },
          band: { value: "b1", evidence: [], tier: "inferred" },
          desc: { value: "Does important things", evidence: [], tier: "inferred" },
        },
      ],
      edges: [],
    };
    const claims = deriveInferredClaims(doc);
    const texts = claims.map((c) => c.text);
    expect(texts).toContain("My Service");
    expect(texts).toContain("b1");
    expect(texts).toContain("Does important things");
  });

  test("skips cited claims", () => {
    const doc: ArchModelDoc = {
      boundary: "test",
      bands: [],
      nodes: [
        {
          id: "n1",
          kind: "cont",
          title: { value: "Cited Service", evidence: [{ file: "src/foo.ts", line: 1 }], tier: "cited" },
          band: { value: "b1", evidence: [{ file: "src/foo.ts", line: 1 }], tier: "cited" },
        },
      ],
      edges: [],
    };
    const claims = deriveInferredClaims(doc);
    expect(claims.length).toBe(0);
  });

  test("collects inferred edge verb", () => {
    const doc: ArchModelDoc = {
      boundary: "test",
      bands: [],
      nodes: [],
      edges: [
        {
          source: "n1",
          target: "n2",
          verb: { value: "delegates", evidence: [], tier: "inferred" },
        },
      ],
    };
    const claims = deriveInferredClaims(doc);
    expect(claims.some((c) => c.text === "delegates")).toBe(true);
  });

  test("handles missing tiers (undefined) — skips gracefully", () => {
    const doc: ArchModelDoc = {
      boundary: "test",
      bands: [],
      nodes: [
        {
          id: "n1",
          kind: "cont",
          // tier absent (not yet grounded)
          title: { value: "Ungrounded", evidence: [] },
          band: { value: "b1", evidence: [] },
        },
      ],
      edges: [],
    };
    // Should not throw; ungrounded = not inferred
    expect(() => deriveInferredClaims(doc)).not.toThrow();
  });
});

// ── groundedPopoverTitle ────────────────────────────────────────────────────

describe("groundedPopoverTitle", () => {
  test("returns correct title", () => {
    expect(groundedPopoverTitle()).toBe("WHY THIS DIAGRAM IS TRUSTWORTHY");
  });
});

// ── buildGroundedPopoverHtml — with counts ──────────────────────────────────

describe("buildGroundedPopoverHtml — with serialized counts", () => {
  const doc = makeDoc();

  test("title: WHY THIS DIAGRAM IS TRUSTWORTHY in aria-label only, NOT in content", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 67, citedClaims: 2, totalClaims: 3, topologyBlindClaims: 1 });
    expect(html).not.toContain("WHY THIS DIAGRAM IS TRUSTWORTHY"); // title must NOT be in content anymore
  });

  test("formula headline: cited ÷ total = pct%", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 67, citedClaims: 2, totalClaims: 3 });
    expect(html).toContain("2 ÷ 3 = 67%");
  });

  test("What we counted: label stripped — opens 'This diagram was written by AI'", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 67, citedClaims: 2, totalClaims: 3 });
    expect(html).not.toContain("What we counted"); // label stripped
    expect(html).toContain("This diagram was written by AI"); // capitalized opening (FULL path)
    expect(html).toContain("checkable statements"); // narrative phrasing intact
    expect(html).toContain("backed by actual imports"); // narrative phrasing intact
    // old definition lines still removed
    expect(html).not.toContain("not the LLM grading itself");
    expect(html).not.toContain("an independent check");
  });

  test("So-what FULL path: label stripped — opens 'Solid arrows and labels'", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 67, citedClaims: 2, totalClaims: 3 });
    expect(html).not.toContain("So what:"); // bold lead-in stripped
    expect(html).toContain("Solid arrows and labels are evidence-backed"); // capitalized opening
    expect(html).toContain("inferred ones render dashed"); // so-what phrasing intact
  });

  test("topology-blind line present when K>0", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 67, citedClaims: 2, totalClaims: 3, topologyBlindClaims: 2 });
    expect(html).toContain("layer-not-confirmable");
    expect(html).toContain("2 claims layer-not-confirmable"); // count present
  });

  test("topology-blind line ABSENT when K=0", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 67, citedClaims: 2, totalClaims: 3, topologyBlindClaims: 0 });
    expect(html).not.toContain("layer-not-confirmable"); // absent when 0
  });

  test("topology-blind line ABSENT when topologyBlindClaims undefined", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 67, citedClaims: 2, totalClaims: 3 });
    expect(html).not.toContain("layer-not-confirmable"); // absent when absent
  });

  test("inferred list with top-3 + '+N more' truncation", () => {
    const bigDoc = makeDocWith5Inferred();
    const html = buildGroundedPopoverHtml({ doc: bigDoc, groundedPct: 0, citedClaims: 0, totalClaims: 5 });
    // Must show at most 3 items then a "+N more" line
    const itemMatches = [...html.matchAll(/class="ap-inferred-item"/g)];
    expect(itemMatches.length).toBeLessThanOrEqual(3);
    expect(html).toContain("+"); // "+N more" truncation present
    expect(html).toContain("more"); // "+N more" text
  });

  test("epistemic line present", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 67, citedClaims: 2, totalClaims: 3 });
    expect(html).toContain("describes this output only"); // epistemic line
    expect(html).toContain("Re-generating may produce a different claim set");
  });

  test("epistemic line uses pct value from payload", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 42, citedClaims: 2, totalClaims: 3 });
    expect(html).toContain("42%"); // pct in epistemic section
  });

  test("large counts use toLocaleString (thousands sep)", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 75, citedClaims: 1500, totalClaims: 2000 });
    expect(html).toContain("1,500 ÷ 2,000"); // toLocaleString applied
  });
});

// ── buildGroundedPopoverHtml — legacy absent counts (graceful-absent) ───────

describe("buildGroundedPopoverHtml — legacy payload (counts absent)", () => {
  const doc = makeDoc();

  test("formula from groundedPct only — no ÷ arithmetic", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 55 });
    // Graceful: show "grounded = 55%" style without cited÷total arithmetic
    expect(html).toContain("55%");
    // Must NOT fabricate counts
    expect(html).not.toMatch(/\d+ ÷ \d+ =/); // no division formula
  });

  test("What this measures: label stripped — opens 'This diagram was written by AI' (REDUCED)", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 55 });
    expect(html).not.toContain("What this measures"); // label stripped
    expect(html).toContain("This diagram was written by AI; grounded%"); // capitalized opening (REDUCED path)
    expect(html).toContain("grounded%"); // reduced narrative phrasing intact
  });

  test("Re-generate hint line present in legacy/REDUCED path", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 55 });
    expect(html).toContain("Re-generate to see exactly which statements are inferred"); // hint line
    expect(html).toContain("predates the per-claim breakdown"); // hint line phrasing
  });

  test("title NOT in content in legacy mode", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 55 });
    expect(html).not.toContain("WHY THIS DIAGRAM IS TRUSTWORTHY"); // title moved to aria-label only
  });

  test("epistemic line still present in legacy mode", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 55 });
    expect(html).toContain("describes this output only");
  });

  test("topology-blind absent in legacy mode (topologyBlindClaims undefined)", () => {
    const html = buildGroundedPopoverHtml({ doc, groundedPct: 55 });
    expect(html).not.toContain("layer-not-confirmable");
  });
});

// ── XSS escape (inferred claim text from LLM) ───────────────────────────────

describe("buildGroundedPopoverHtml — XSS escape", () => {
  test("claim text with <script> is HTML-escaped", () => {
    const xssDoc: ArchModelDoc = {
      boundary: "test",
      bands: [],
      nodes: [
        {
          id: "n1",
          kind: "cont",
          title: { value: '<script>alert("xss")</script>', evidence: [], tier: "inferred" },
          band: { value: "b1", evidence: [], tier: "inferred" },
        },
      ],
      edges: [],
    };
    // totalClaims=1, citedClaims=0 → 1 inferred claim expected
    const html = buildGroundedPopoverHtml({ doc: xssDoc, groundedPct: 0, citedClaims: 0, totalClaims: 1 });
    // Raw <script> must not appear
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("</script>");
    // Escaped form must appear
    expect(html).toContain("&lt;script&gt;");
  });
});

// ── Parity assertion (client half) ──────────────────────────────────────────

describe("buildGroundedPopoverHtml — parity assertion", () => {
  test("matching fixture → no '(sample)' suffix, no warn", () => {
    // doc has exactly these inferred claims:
    // band b2 label "domain core" is topology-blind → skip
    // node1.desc "Handles user interface rendering" → inferred
    // node2.title "Domain Core" → inferred
    // node2.band "b2" → inferred
    // edge verb "calls" → inferred
    // So: 4 inferred claims. totalClaims=6, citedClaims=2 → expected 4 inferred
    const doc = makeDoc();
    const warnSpy = mock(() => {});
    const origWarn = console.warn;
    console.warn = warnSpy;
    try {
      const html = buildGroundedPopoverHtml({ doc, groundedPct: 67, citedClaims: 2, totalClaims: 6 });
      expect(html).not.toContain("(sample)"); // no mismatch label
      expect(warnSpy).not.toHaveBeenCalled(); // no warn
    } finally {
      console.warn = origWarn;
    }
  });

  test("mismatched fixture → list header gains '(sample)' + console.warn", () => {
    // claim: only 1 inferred in a tiny doc, but counts say 4
    const doc: ArchModelDoc = {
      boundary: "test",
      bands: [],
      nodes: [
        {
          id: "n1",
          kind: "cont",
          title: { value: "Single Inferred", evidence: [], tier: "inferred" },
          band: { value: "b1", evidence: [], tier: "inferred" },
        },
      ],
      edges: [],
      groundedPct: 20,
    };
    // totalClaims=5, citedClaims=1 → expected 4 inferred; doc has 2 → mismatch
    const warnSpy = mock(() => {});
    const origWarn = console.warn;
    console.warn = warnSpy;
    try {
      const html = buildGroundedPopoverHtml({ doc, groundedPct: 20, citedClaims: 1, totalClaims: 5 });
      expect(html).toContain("(sample)"); // mismatch label present
      expect(warnSpy).toHaveBeenCalled(); // warn fired
      const warnArgs = warnSpy.mock.calls[0]?.join(" ") ?? "";
      expect(warnArgs).toContain("[grounded-popover]"); // correct prefix
    } finally {
      console.warn = origWarn;
    }
  });

  test("parity assertion anti-vacuous: matching case PASSES (green path not vacuous)", () => {
    // A doc with exactly 2 inferred claims, totalClaims=4, citedClaims=2 → 2 expected inferred
    const doc: ArchModelDoc = {
      boundary: "test",
      bands: [],
      nodes: [
        {
          id: "n1",
          kind: "cont",
          title: { value: "Service A", evidence: [], tier: "inferred" },
          band: { value: "b1", evidence: [{ file: "src/a.ts", line: 1 }], tier: "cited" },
        },
        {
          id: "n2",
          kind: "cont",
          title: { value: "Service B", evidence: [{ file: "src/b.ts", line: 1 }], tier: "cited" },
          band: { value: "b1", evidence: [], tier: "inferred" },
        },
      ],
      edges: [],
    };
    const warnSpy = mock(() => {});
    const origWarn = console.warn;
    console.warn = warnSpy;
    try {
      const html = buildGroundedPopoverHtml({ doc, groundedPct: 50, citedClaims: 2, totalClaims: 4 });
      // Exactly 2 inferred derived, 4-2=2 expected → match → no sample, no warn
      expect(html).not.toContain("(sample)");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      console.warn = origWarn;
    }
  });

  test("render never throws even on parity mismatch (anti-blocking)", () => {
    const doc = makeDoc();
    // Give wildly wrong counts
    expect(() =>
      buildGroundedPopoverHtml({ doc, groundedPct: 67, citedClaims: 0, totalClaims: 100 })
    ).not.toThrow();
  });
});

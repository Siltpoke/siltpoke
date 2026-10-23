/** Numbered edges and the key (spec §7.2, amended 2026-09-29, second pass): every drawn edge
 * carries a number badge on its curve, the key under the diagram says what each number is,
 * and the appendix uses the same numbers. Nothing is left out any more. */
import { describe, expect, test } from "bun:test";
import { buildAppendixMd } from "../../../src/web/client/export/appendix";
import { placeBadge } from "../../../src/web/client/export/edge-labels";
import { buildExportSvg } from "../../../src/web/client/export/build-svg";
import type { C4Model } from "../../../src/web/client/islands/repo-graph-c4-model";
import { attrs, model, STAMP, spans, tags, texts, trust } from "./fixtures";

const build = (m: C4Model = model(), t = trust()) => buildExportSvg(m, t, { theme: "light", fontCss: "", stampLine: STAMP });

interface Box {
  n: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
/** The badges as drawn (the pill rects the implementation placed and checked). */
const badges = (svg: string): Box[] =>
  tags(svg, "rect")
    .filter((r) => r.includes("data-badge="))
    .map((r) => {
      const a = attrs(r);
      return { n: Number(a["data-badge"]), x: Number(a.x), y: Number(a.y), w: Number(a.width), h: Number(a.height) };
    });
const keyRows = (svg: string): Array<[number, string]> =>
  [...svg.matchAll(/<text\b[^>]*data-key-row="(\d+)"[^>]*>([\s\S]*?)<\/text>/g)].map((m) => [Number(m[1]), spans(m[2])[0]]);
const hit = (a: Omit<Box, "n">, b: Omit<Box, "n">) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** A card's words sit inside its 12px / 8px padding. */
const textArea = (n: C4Model["N"][string]) => ({ x: n.x + 12, y: n.y + 8, w: n.w - 24, h: n.h - 16 });

/** Room between the boxes for every badge (ext moved off b's row). */
function roomy(): C4Model {
  const m = model();
  m.N.ext.y = 220;
  m.N.ext.x = 700;
  m.E = [
    ["a", "b", "uses"],
    ["b", "a", "reads"],
    ["a", "b", "manages the daemon lifecycle and status"],
    ["b", "c", "writes"],
    ["a", "ext", "calls"],
  ];
  return m;
}

describe("every drawn edge has a number", () => {
  test("one badge per drawn edge, numbered 1..N, and one key row per number", () => {
    const m = roomy();
    m.E.push(["a", "ghost", "haunts"]); // not drawn: no number, no row
    const { svg } = build(m);
    expect(badges(svg).map((b) => b.n).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);
    expect(keyRows(svg).map(([n]) => n)).toEqual([1, 2, 3, 4, 5]);
    expect(svg).not.toContain("haunts");
    expect(tags(svg, "path").filter((p) => p.includes("data-edge=")).map((p) => Number(attrs(p)["data-n"])).sort()).toEqual([1, 2, 3, 4, 5]);
  });
  test("numbers follow the layout (source top→bottom, left→right), not the file order", () => {
    const m = model();
    m.E = [["c", "a", "last"], ["b", "c", "middle"], ["a", "b", "first"]];
    const rows = keyRows(build(m).svg);
    expect(rows).toEqual([
      [1, "Alpha core → Beta store — first"],
      [2, "Beta store → Gamma &lt;b&gt;&amp;&quot;x&quot; — middle"],
      [3, "Gamma &lt;b&gt;&amp;&quot;x&quot; → Alpha core — last"],
    ]);
  });
  test("the legend no longer says anything was left out", () => {
    expect(texts(build(roomy()).svg).join("\n")).not.toContain("left out");
  });
  test("an empty verb still gets its number; its key row is just `From → To`", () => {
    const m = roomy();
    m.E = [["a", "b", "  "]];
    const { svg } = build(m);
    expect(badges(svg).map((b) => b.n)).toEqual([1]);
    expect(keyRows(svg)).toEqual([[1, "Alpha core → Beta store"]]);
  });
});

describe("where a badge goes", () => {
  test("with room, no badge touches a box's text, a band name, the boundary name or another badge", () => {
    const m = roomy();
    const { svg } = build(m);
    const bs = badges(svg);
    expect(bs.length).toBe(5);
    const names = [
      { x: 32, y: 48, w: 40, h: 14 }, // CORE band name (band 20,40 → name from 34,48)
      { x: 32, y: 208, w: 44, h: 14 }, // STATE band name
      { x: 28, y: 22, w: 80, h: 16 }, // the boundary name on its border
    ];
    for (const [i, b] of bs.entries()) {
      for (const n of Object.values(m.N)) expect(hit(b, textArea(n))).toBe(false);
      for (const r of names) expect(hit(b, r)).toBe(false);
      for (const o of bs.slice(i + 1)) expect(hit(b, o)).toBe(false);
    }
  });
  test("badges keep a gap between them, not just a non-overlap (review round 4, item 7)", () => {
    // a → b and b → a bow to opposite sides by ~7px each: their middles are ~13px apart, so
    // the two pills would sit edge to edge and read as one number.
    const m = roomy();
    m.E = [["a", "b", "one"], ["b", "a", "two"]];
    const bs = badges(build(m).svg);
    expect(bs.length).toBe(2);
    const grow = (b: Box) => ({ x: b.x - 2.5, y: b.y - 2.5, w: b.w + 5, h: b.h + 5 }); // drawn pills are 1px inset
    for (const [i, b] of bs.entries()) for (const o of bs.slice(i + 1)) expect(hit(grow(b), o)).toBe(false);
  });
  test("a badge moves along its curve off a band name it would cover (review M2)", () => {
    const m = model();
    m.N = {
      top: { kind: "cont", title: "Top", accent: "sky", x: 20, y: -80, w: 60, h: 40 },
      low: { kind: "cont", title: "Low", accent: "sky", x: 20, y: 150, w: 60, h: 40 },
    };
    m.E = [["top", "low", "passes"]];
    const [b] = badges(build(m).svg);
    expect(hit(b, { x: 32, y: 48, w: 40, h: 14 })).toBe(false); // CORE's name
    expect(hit(b, { x: 28, y: 22, w: 80, h: 16 })).toBe(false); // the boundary's name
  });
  test("with no free spot on the curve it is still drawn, where it overlaps least — never dropped", () => {
    const m = model();
    // A wall-to-wall box between a and b: every point of the a → b curve is inside its text area.
    m.N = {
      a: { kind: "cont", title: "A", accent: "sky", x: 0, y: 100, w: 40, h: 40 },
      wall: { kind: "cont", title: "Wall", accent: "sky", x: 40, y: 0, w: 400, h: 300 },
      b: { kind: "cont", title: "B", accent: "sky", x: 440, y: 100, w: 40, h: 40 },
    };
    m.E = [["a", "b", "crosses"]];
    const { svg } = build(m);
    expect(badges(svg).map((b) => b.n)).toEqual([1]);
    expect(keyRows(svg)).toEqual([[1, "A → B — crosses"]]);
  });
});

describe("the key", () => {
  test("each row's sample stroke is drawn like its edge: dashed exactly for the unbacked ones", () => {
    const { svg } = build();
    const strokes = tags(svg, "path").filter((p) => p.includes("data-key-stroke="));
    const dashedKey = strokes.filter((p) => p.includes("stroke-dasharray")).map((p) => Number(attrs(p)["data-key-stroke"]));
    const dashedEdges = tags(svg, "path")
      .filter((p) => p.includes("data-edge=") && p.includes("stroke-dasharray"))
      .map((p) => Number(attrs(p)["data-n"]));
    expect(strokes.length).toBe(3);
    expect(dashedKey).toEqual(dashedEdges);
    expect(dashedKey).toEqual([3]); // b → c, the edge without evidence
  });
  test("many rows spread over columns that stay inside the export's width", () => {
    const m = model();
    m.N.far = { kind: "ext", title: "Far away", x: 1400, y: 60, w: 140, h: 60 }; // a wide export
    const ids = Object.keys(m.N);
    m.E = [];
    for (let i = 0; i < 60; i++) m.E.push([ids[i % ids.length], ids[(i + 1) % ids.length], `verb number ${i}`]);
    const { svg, width } = build(m);
    const xs = [...svg.matchAll(/<text\b[^>]*data-key-row="\d+"[^>]*>/g)].map((t) => Number(attrs(t[0]).x));
    expect(new Set(xs).size).toBeGreaterThan(1); // more than one column
    expect(Math.max(...xs)).toBeLessThan(width - 24);
    expect(keyRows(svg).length).toBe(60);
  });
  test("the appendix lists the same numbers", () => {
    const m = model();
    const md = buildAppendixMd(m, trust(), STAMP);
    const rows = keyRows(build(m).svg);
    expect(rows.map(([n]) => n)).toEqual([1, 2, 3]);
    expect(md).toContain("| 1 | a → b | uses | import ×3 |");
    expect(md).toContain("| 2 | a → ext | calls | cited web/api.ts:40 |");
    expect(md).toContain("| 3 | b → c | writes | none (citation-stale) |");
  });
});

describe("placeBadge on a straight line", () => {
  // A straight curve along y = 0 (control point on the line), so "on the line" is exact.
  const line: [[number, number], [number, number], [number, number]] = [[0, 0], [50, 0], [100, 0]];
  test("with nothing in the way it sits on the line, at the middle (on-line spots come before nudged ones)", () => {
    const b = placeBadge("7", line, [], []);
    expect(b.clear).toBe(true);
    expect(b.centre).toEqual([50, 0]);
  });
  test("with the line itself blocked, it is nudged to the free side and still touches its edge", () => {
    // Covers every on-line spot (y −8 … −0.5) but not the band just below the line.
    const b = placeBadge("7", line, [{ x: -10, y: -8, w: 120, h: 7.5 }], []);
    expect(b.clear).toBe(true);
    expect(b.centre[1]).toBeGreaterThan(0); // moved off the line, downwards
    expect(b.box.y).toBeLessThanOrEqual(0); // …but its pill still reaches y = 0
    expect(b.box.y + b.box.h).toBeGreaterThanOrEqual(0);
  });
});

/** The key under the diagram: a row is never cut, it wraps; columns balance by height
 * (spec §7.2, amended 2026-09-29; review rounds 4 and 5). */
import { describe, expect, test } from "bun:test";
import { buildExportSvg } from "../../../src/web/client/export/build-svg";
import { textWidth } from "../../../src/web/client/export/layout-text";
import type { C4Model } from "../../../src/web/client/islands/repo-graph-c4-model";
import { attrs, model, STAMP, spans, trust } from "./fixtures";

const build = (m: C4Model = model(), t = trust()) => buildExportSvg(m, t, { theme: "light", fontCss: "", stampLine: STAMP });

const rowOf = (verb: string) => {
  const m = model();
  m.E[0] = ["a", "b", verb];
  const svg = build(m).svg;
  const row = /<text\b([^>]*data-key-row="1"[^>]*)>([\s\S]*?)<\/text>/.exec(svg);
  return { svg, attrs: attrs(`<text ${row?.[1]}>`), lines: spans(row?.[2] ?? "") };
};
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// The fixture exports 808px wide. The key gets 808 − 2·24 = 760px, which holds 2 columns of
// (760 − 20) / 2 = 370px; a row's text starts after the 18px stroke, the 30px number and a
// 10px gap, so each line has 370 − 58 = 312px (svg-key.ts renderKey).
const TEXT_W = 312;

describe("edge verb in the key — never cut, wrapped (review round 4, item 6)", () => {
  test("a long verb appears in full, over as many lines as it needs, each inside the column", () => {
    const verb = "runs explain for graph nodes and the arch model, then caches the answer per repository and per model version";
    const { lines, attrs: a } = rowOf(verb.repeat(2));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe(`Alpha core → Beta store — ${verb.repeat(2)}`);
    expect(lines.join("")).not.toContain("…");
    for (const l of lines) expect(textWidth(l, "body")).toBeLessThanOrEqual(TEXT_W);
    // Every line hangs under the text, not under the number.
    const xs = [...(/<text\b[^>]*data-key-row="1"[^>]*>([\s\S]*?)<\/text>/.exec(build(model()).svg)?.[1] ?? "").matchAll(/<tspan x="([\d.]+)"/g)];
    expect(new Set(xs.map((x) => x[1])).size).toBe(1);
    expect(Number(a.x)).toBeGreaterThan(24 + 18 + 20);
  });
  test("a wrapped row pushes the next row down by its real height", () => {
    const m = model();
    m.N.ext.x = 400; // a narrow export: one key column, so rows 1 and 2 stack
    m.N.ext.y = 220;
    m.E[0] = ["a", "b", "word ".repeat(60)];
    const svg = build(m).svg;
    const ys = new Map([...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)" data-key-row="(\d+)"/g)].map((t) => [Number(t[2]), Number(t[1])]));
    const y = (n: number) => ys.get(n) ?? Number.NaN;
    const first = spans(/<text\b[^>]*data-key-row="1"[^>]*>([\s\S]*?)<\/text>/.exec(svg)?.[1] ?? "").length;
    expect(first).toBeGreaterThan(1);
    expect(y(2) - y(1)).toBeGreaterThanOrEqual(16 + (first - 1) * 14);
  });
  test("emoji and CJK verbs wrap without a lone surrogate or a line past the column", () => {
    for (const verb of ["\u{1F600}".repeat(60), "读取并写入持久化存储的所有数据".repeat(6)]) {
      const { svg, lines } = rowOf(verb);
      expect(LONE.test(svg)).toBe(false);
      expect(lines.join("")).not.toContain("…");
      for (const l of lines) expect(textWidth(l, "body")).toBeLessThanOrEqual(TEXT_W);
    }
  });
});

describe("key columns", () => {
  test("columns are balanced by row height, not row count", () => {
    const m = model();
    m.E[0] = ["a", "b", "word ".repeat(120)]; // row 1 alone is taller than rows 2 and 3 together
    const svg = build(m).svg;
    const x = new Map([...svg.matchAll(/<text x="([\d.]+)" y="[\d.]+" data-key-row="(\d+)"/g)].map((t) => [Number(t[2]), Number(t[1])]));
    expect(x.get(2)).not.toBe(x.get(1)); // row 2 starts the second column…
    expect(x.get(3)).toBe(x.get(2)); // …and row 3 joins it, instead of a 2 + 1 split by count
  });
  test("a short verb is one line: `From → To — verb`", () => {
    expect(rowOf("uses").lines).toEqual(["Alpha core → Beta store — uses"]);
  });
});


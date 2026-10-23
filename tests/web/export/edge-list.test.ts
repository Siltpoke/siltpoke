/** Review M1: the legend says every edge is listed in the HTML file (and the appendix, when on).
 * Checked against the data: every edge the image draws must be a row in both. */
import { describe, expect, test } from "bun:test";
import { buildAppendixMd } from "../../../src/web/client/export/appendix";
import { buildExportHtml } from "../../../src/web/client/export/build-html";
import { buildExportSvg } from "../../../src/web/client/export/build-svg";
import type { C4Model } from "../../../src/web/client/islands/repo-graph-c4-model";
import { model, STAMP, trust } from "./fixtures";

/** The shared fixture plus the edges the trust map has no record of. */
function wide(): C4Model {
  const m = model();
  m.N.ext2 = { kind: "ext", title: "Other API", x: 640, y: 220, w: 140, h: 60 };
  m.N.who = { kind: "person", title: "Developer", x: 640, y: 320, w: 140, h: 60 };
  m.E.push(
    ["c", "a", "reports to"], // group → group, no trust record
    ["ext", "ext2", "proxies"], // outside ↔ outside: never in the trust map
    ["who", "a", "runs"], // person → group
    ["a", "b", "also reads"], // a second verb on a recorded pair
    ["a", "ghost", "haunts"], // not drawn: its endpoint is missing
  );
  return m;
}

const drawn = (m: C4Model) => m.E.filter(([s, t]) => m.N[s] && m.N[t]);

describe("every drawn edge is listed", () => {
  const m = wide();
  const t = trust();
  test("in the appendix table, with 'no-record' where the trust map has none", () => {
    const md = buildAppendixMd(m, t, STAMP);
    for (const [s, d, verb] of drawn(m)) expect(md).toContain(`| ${s} → ${d} | ${verb} |`);
    expect(md).toContain("| ext → ext2 | proxies | none (no-record) |");
    expect(md).toContain("| a → b | also reads | import ×3 |"); // shares the pair's evidence
    expect(md).not.toContain("haunts");
  });
  test("in the HTML file's island, and every endpoint has a panel entry", () => {
    const { svg, width, height } = buildExportSvg(m, t, { theme: "light", fontCss: "", stampLine: STAMP });
    const html = buildExportHtml({ svg, width, height, model: m, trust: t, standaloneJs: "", appendix: false });
    const island = JSON.parse(/<script type="application\/json" id="trust">([\s\S]*?)<\/script>/.exec(html)![1]) as {
      edges: Array<{ source: string; target: string; verb: string }>;
      containers: Array<{ id: string }>;
      nodes: Array<{ id: string }>;
    };
    const rows = new Set(island.edges.map((e) => `${e.source}>${e.target}>${e.verb}`));
    for (const [s, d, verb] of drawn(m)) expect(rows.has(`${s}>${d}>${verb}`)).toBe(true);
    const panels = new Set([...island.containers.map((c) => c.id), ...island.nodes.map((n) => n.id)]);
    for (const [s, d] of drawn(m)) expect([panels.has(s), panels.has(d)]).toEqual([true, true]);
    expect(island.nodes.map((n) => n.id).sort()).toEqual(["ext", "ext2", "who"]);
  });
});

describe("the listed verb is the drawn verb", () => {
  test("a record whose verb differs lends its evidence, not its verb", () => {
    const m = model();
    m.E[0] = ["a", "b", "imports from"]; // the trust record for a → b says "uses"
    const md = buildAppendixMd(m, trust(), STAMP);
    expect(md).toContain("| a → b | imports from | import ×3 |");
    expect(md).not.toContain("| a → b | uses |");
  });
});

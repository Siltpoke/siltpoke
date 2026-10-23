import { describe, expect, test } from "bun:test";
import { buildExportSvg } from "../../../src/web/client/export/build-svg";
import { textWidth } from "../../../src/web/client/export/layout-text";
import { assertNoAbsolutePaths } from "../../../src/web/client/export/privacy";
import type { C4Model } from "../../../src/web/client/islands/repo-graph-c4-model";
import { attrs, model, STAMP, spans, tags, texts, trust } from "./fixtures";

const build = (m: C4Model = model(), t = trust(), theme: "light" | "dark" = "light") =>
  buildExportSvg(m, t, { theme, fontCss: "", stampLine: STAMP });

describe("buildExportSvg geometry", () => {
  test("one data-id rect per container, numbers equal to the model (parity)", () => {
    const m = model();
    const { svg } = build(m);
    const rects = tags(svg, "rect").filter((r) => r.includes("data-id="));
    expect(rects.length).toBe(3);
    for (const r of rects) {
      const a = attrs(r);
      const n = m.N[a["data-id"]];
      expect(n).toBeDefined();
      expect([Number(a.x), Number(a.y), Number(a.width), Number(a.height)]).toEqual([n.x, n.y, n.w, n.h]);
    }
  });
  test("returns a size that contains every node, and matches the svg root", () => {
    const { svg, width, height } = build();
    expect(width).toBeGreaterThanOrEqual(640 + 140);
    expect(height).toBeGreaterThan(310);
    const root = attrs(tags(svg, "svg")[0]);
    expect([Number(root.width), Number(root.height)]).toEqual([width, height]);
    expect(root.viewBox).toBe(`0 0 ${width} ${height}`);
  });
});

describe("edges", () => {
  test("dashed iff the trust edge is not solid", () => {
    const t = trust();
    const paths = tags(build(model(), t).svg, "path").filter((p) => p.includes("data-edge="));
    expect(paths.length).toBe(3);
    for (const e of t.edges) {
      const p = paths.find((x) => attrs(x)["data-edge"] === e.source && attrs(x)["data-to"] === e.target);
      expect(p).toBeDefined();
      expect(p?.includes("stroke-dasharray")).toBe(!e.solid);
    }
  });
  test("an edge with no trust record is dashed (not backed by evidence)", () => {
    const t = trust({ edges: [] });
    const paths = tags(build(model(), t).svg, "path").filter((p) => p.includes("data-edge="));
    expect(paths.length).toBe(3);
    for (const p of paths) expect(p).toContain("stroke-dasharray");
  });
  test("dashed means: an unbacked edge, the system boundary, or an outside-system box (as on the page) — nothing else", () => {
    const { svg } = build();
    const dashed = [...tags(svg, "path"), ...tags(svg, "rect")].filter((x) => x.includes("stroke-dasharray"));
    const edges = dashed.filter((x) => x.includes("data-edge="));
    expect(edges.length).toBe(1); // b → c, the one edge without evidence
    expect(dashed.filter((x) => x.includes('data-role="boundary"')).length).toBe(1);
    expect(dashed.filter((x) => x.includes('data-kind="ext"')).length).toBe(1);
    // …and the key's sample stroke for that same edge, drawn the way the edge is.
    expect(dashed.filter((x) => x.includes("data-key-stroke=")).map((x) => attrs(x)["data-key-stroke"])).toEqual(["3"]);
    expect(dashed.length).toBe(4);
    expect(dashed.some((x) => x.includes("data-arrow=") || x.includes("data-id="))).toBe(false);
  });
});

describe("edge strokes", () => {
  test("a dashed edge keeps a real gap: the page's 4/3 dash with butt caps, so the gap is not eaten by caps", () => {
    const { svg } = build();
    const edges = tags(svg, "path").filter((x) => x.includes("data-edge="));
    const dashed = edges.filter((x) => x.includes("stroke-dasharray"));
    expect(dashed.length).toBe(1);
    for (const p of edges) {
      const a = attrs(p);
      // A round or square cap adds width/2 to both ends of every dash; only butt leaves the drawn gap equal to the dasharray gap.
      expect(a["stroke-linecap"]).toBe("butt");
    }
    const [on, off] = attrs(dashed[0])["stroke-dasharray"].split(/[ ,]+/).map(Number);
    expect(on).toBeGreaterThanOrEqual(4);
    expect(off).toBeGreaterThanOrEqual(3);
    expect(off / Number(attrs(dashed[0])["stroke-width"])).toBeGreaterThanOrEqual(2); // the gap stays ≥ 2 line widths
  });
  test("edges are thin faint ink3 like the page, and the arrowhead is an open chevron in the same stroke", () => {
    const { svg } = build();
    for (const p of tags(svg, "path").filter((x) => x.includes("data-edge=") || x.includes("data-arrow="))) {
      const a = attrs(p);
      expect(a.stroke).toBe("#8a7c64"); // palette.light.ink3
      expect(Number(a["stroke-width"])).toBeLessThanOrEqual(1.4);
      expect(Number(a["stroke-opacity"])).toBeLessThan(1);
      expect(a.fill).toBe("none");
    }
  });
  test("explicit arrowhead path per edge, no context-stroke", () => {
    const { svg } = build();
    expect(tags(svg, "path").filter((p) => p.includes("data-arrow=")).length).toBe(3);
    expect(svg).not.toContain("context-stroke");
    expect(svg).not.toContain("<marker");
  });
});

describe("box lines", () => {
  const folderLines = (svg: string, id: string) =>
    spans(svg.match(new RegExp(`<text\\b[^>]*data-for="${id}" data-role="folders"[^>]*>([\\s\\S]*?)</text>`))?.[1] ?? "");
  test("generated: one folder is one short line, `folder · N of M files` — no emoji, no \"AI listed\" in the box", () => {
    const { svg } = build();
    expect(folderLines(svg, "a")).toEqual(["src/a · 2 of 4 files"]);
    const boxText = [...svg.matchAll(/data-role="folders"[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1]).join("");
    expect(boxText).not.toContain("AI listed");
    expect(boxText).not.toContain("📁");
  });
  test("generated: two folders are two lines in the same short form", () => {
    expect(folderLines(build().svg, "b")).toEqual(["src/b · 1 of 2 files", "src/b2 · 3 of 9 files"]);
  });
  test("a long folder keeps its count: the path is cut with an ellipsis, the line never wraps", () => {
    const t = trust();
    t.containers[0].folders[0].folder = `src/${"deeply-nested-".repeat(6)}module`;
    const lines = folderLines(build(model(), t).svg, "a");
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^src\/deeply-nested-.*… · 2 of 4 files$/);
  });
  test("more folders than the box has room for end in a `+N more folders` line", () => {
    const t = trust();
    t.containers[0].folders = Array.from({ length: 9 }, (_, i) => ({ folder: `src/f${i}`, listed: 1, total: 2 }));
    const lines = folderLines(build(model(), t).svg, "a");
    expect(lines.length).toBeLessThan(9);
    expect(lines[lines.length - 1]).toBe(`+${9 - lines.length + 1} more folders`);
  });
  test("authored / subset boxes never say AI listed", () => {
    for (const source of ["authored", "subset"] as const) {
      const t = trust({
        source,
        totals: null,
        containers: trust().containers.map((c) => ({ ...c, folders: c.folders.map((f) => ({ ...f, listed: null })), listedFiles: [] })),
      });
      const svg = build(model(), t).svg;
      expect(svg).not.toContain("AI listed");
      expect(folderLines(svg, "a")).toEqual(["src/a"]);
      expect(folderLines(svg, "b")).toEqual(["src/b", "src/b2"]);
    }
  });
});

describe("band names", () => {
  const bandText = (svg: string, label: string) =>
    [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].find((m) => m[2].startsWith(label));
  test("drawn upper-case by style, with the model's own text left as written (the scans read that text)", () => {
    const m = model();
    m.BANDS[0].label = "Hook & LLM";
    const hit = bandText(build(m).svg, "Hook &amp; LLM");
    expect(hit).toBeDefined();
    expect(attrs(`<text ${hit?.[1]}>`).style).toBe("text-transform:uppercase");
    expect(build(m).svg).not.toContain("HOOK &amp; LLM");
  });
  test("the \"by name\" tag is exempt from the upper-casing", () => {
    const m = model();
    m.BANDS[1].label = "State";
    const hit = bandText(build(m).svg, "State");
    const tag = /<tspan\b([^>]*)> by name<\/tspan>/.exec(hit?.[2] ?? "");
    expect(tag).not.toBeNull();
    expect(attrs(`<tspan ${tag?.[1]}>`).style).toBe("text-transform:none");
  });
});

describe("header, footer, legend", () => {
  test("header carries the server stamp verbatim and the generated total", () => {
    const tx = texts(build().svg).join("\n");
    expect(tx).toContain(STAMP);
    expect(tx).toContain("AI listed 6 of 16 files");
  });
  test("no total line without totals", () => {
    expect(texts(build(model(), trust({ totals: null })).svg).join("\n")).not.toContain("of 16 files");
  });
  test("Not shown list, truncated past 6 with +N more", () => {
    expect(texts(build().svg).join("\n")).toContain("Not shown: src/zz");
    const many = ["a", "b", "c", "d", "e", "f", "g"].map((x) => `src/${x}`);
    const tx = texts(build(model(), trust({ notShown: many })).svg).join("\n");
    expect(tx).toContain("+1 more");
    expect(tx).not.toContain("src/g");
    expect(texts(build(model(), trust({ notShown: [] })).svg).join("\n")).not.toContain("Not shown");
  });
  test("legend strings are exact", () => {
    const tx = texts(build().svg);
    expect(tx).toContain("── solid: an import, or a source citation checked at export");
    expect(tx).toContain("- - dashed: neither");
    expect(tx).toContain("Group titles and descriptions are AI-written and unverified.");
  });
  test("the folder-count legend line is exact, and Generated only", () => {
    const line = "In each box, &quot;5 of 39 files&quot; = files the AI listed / files in that folder."; // as escaped in the markup
    expect(texts(build().svg)).toContain(line);
    for (const source of ["authored", "subset"] as const) {
      expect(texts(build(model(), trust({ source, totals: null })).svg)).not.toContain(line);
    }
  });
});

describe("the subset line", () => {
  test("the subset line is derived from the drawn edges: said only when every one is solid", () => {
    const line = "Every edge in this view is a real import.";
    type Edges = ReturnType<typeof trust>["edges"];
    const allSolid = (): Edges => trust().edges.map((e) => ({ ...e, solid: true, evidence: { kind: "import" as const, count: 1 } }));
    const subset = (edges = allSolid()) => texts(build(model(), trust({ source: "subset", totals: null, edges })).svg);
    expect(subset()).toContain(line);
    // One drawn edge not solid (here b → c): the line would be false, so only the solid/dashed legend remains.
    const oneDashed = allSolid().map((e) => (e.source === "b" ? { ...e, solid: false, evidence: { kind: "none" as const, reason: "no-import-no-citation" as const } } : e));
    expect(subset(oneDashed)).not.toContain(line);
    expect(subset(oneDashed)).toContain("- - dashed: neither");
    // A drawn edge with no trust record at all is dashed too.
    expect(subset(allSolid().filter((e) => e.source !== "b"))).not.toContain(line);
    // Never outside the subset view, even when every edge is solid.
    expect(texts(build(model(), trust({ source: "authored", totals: null, edges: allSolid() })).svg)).not.toContain(line);
    expect(texts(build(model(), trust({ edges: allSolid() })).svg)).not.toContain(line);
  });
});

describe("content rules", () => {
  test("Key pieces (comp) never appear", () => {
    const { svg } = build();
    expect(svg).not.toContain("SECRET-COMP-FILE");
    expect(svg).not.toContain("key piece desc");
  });
  test("AI prose is escaped in text nodes", () => {
    const { svg } = build();
    expect(svg).toContain("Gamma &lt;b&gt;&amp;&quot;x&quot;");
    expect(svg).not.toContain("<b>");
  });
  test("an attribute-breaking id cannot escape its attribute", () => {
    const m = model();
    m.N['x"y'] = { kind: "cont", title: "t", accent: "sky", x: 0, y: 0, w: 10, h: 10 };
    const svg = build(m).svg;
    expect(svg).toContain('data-id="x&quot;y"');
  });
  test("no CSS variables in the output, both themes", () => {
    for (const th of ["light", "dark"] as const) expect(build(model(), trust(), th).svg).not.toContain("var(--");
  });
  test("dark theme changes the background fill", () => {
    const bg = (s: string) => attrs(tags(s, "rect")[0]).fill;
    const light = bg(build().svg);
    const dark = bg(build(model(), trust(), "dark").svg);
    expect(light).toMatch(/^#[0-9a-f]{6}$/i);
    expect(dark).toMatch(/^#[0-9a-f]{6}$/i);
    expect(light).not.toBe(dark);
  });
  test("fonts go in a style block; a stray </style> in font css cannot close it", () => {
    const { svg } = buildExportSvg(model(), trust(), { theme: "light", fontCss: "@font-face{}</style><script>", stampLine: STAMP });
    expect(svg).toContain("<defs><style>@font-face{}");
    expect(svg.match(/<\/style>/g)?.length).toBe(1);
  });
  test("output has no absolute path", () => {
    expect(() => assertNoAbsolutePaths(build().svg)).not.toThrow();
  });
});

describe("degenerate maps", () => {
  test("empty model: valid svg with legend and stamp", () => {
    const empty: C4Model = { N: {}, E: [], BANDS: [], BOUNDARY: { x: 0, y: 0, w: 0, h: 0, label: "" }, GROUP_ACCENT: model().GROUP_ACCENT };
    const { svg, width, height } = build(empty, trust({ containers: [], edges: [], totals: { listed: 0, total: 0 }, notShown: [] }));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    const tx = texts(svg).join("\n");
    expect(tx).toContain(STAMP);
    expect(tx).toContain("── solid");
  });
  test("a CJK title stays inside its box", () => {
    const m = model();
    m.N.a.title = "这是一个很长的中文标题用来测试换行是否不会溢出框这是一个很长的中文标题";
    const svg = build(m).svg;
    const a = m.N.a;
    const node = svg.match(/<text\b[^>]*data-for="a" data-role="title"[^>]*>([\s\S]*?)<\/text>/);
    const lines = spans(node?.[1] ?? "");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(textWidth(l, "title")).toBeLessThanOrEqual(a.w - 16 - 12); // measured, "…" included
  });
  test("titles that would overflow the box height are truncated with an ellipsis", () => {
    const m = model();
    m.N.a.title = "word ".repeat(80);
    const svg = build(m).svg;
    expect(svg).toContain("…");
  });
  test("a node referenced by an edge but missing from N is skipped, not a crash", () => {
    const m = model();
    m.E.push(["a", "ghost", "haunts"]);
    expect(tags(build(m).svg, "path").filter((p) => p.includes("data-edge=")).length).toBe(3);
  });
});

const descLines = (svg: string, id: string) => {
  const node = svg.match(new RegExp(`<text\\b[^>]*data-for="${id}" data-role="desc"[^>]*>([\\s\\S]*?)</text>`));
  return { node, lines: spans(node?.[1] ?? "") };
};

describe("outside-system and person boxes describe themselves", () => {
  const LONG = "Talks to the outside world over a long winding protocol that needs many many words to explain";
  test("an ext box draws its wrapped description inside its box, clamped with an ellipsis", () => {
    const m = model();
    m.N.ext.desc = LONG;
    m.N.ext.h = 90; // room for a title and three description lines
    const { node, lines } = descLines(build(m).svg, "ext");
    const e = m.N.ext;
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(textWidth(l, "body", 10.5)).toBeLessThanOrEqual(e.w - 13 - 12);
    expect(lines[lines.length - 1].endsWith("…")).toBe(true);
    const a = attrs(`<text ${node?.[0].slice(5)}`);
    expect(Number(a.y) + (lines.length - 1) * 14).toBeLessThanOrEqual(e.y + e.h - 8);
  });
  test("a short description is drawn whole, without an ellipsis", () => {
    const m = model();
    m.N.ext.desc = "Hosted model API";
    expect(descLines(build(m).svg, "ext").lines).toEqual(["Hosted model API"]);
  });
  test("a person box gets one too", () => {
    const m = model();
    m.N.who = { kind: "person", title: "Developer", desc: "Uses the tool", x: 640, y: 200, w: 140, h: 60 };
    expect(descLines(build(m).svg, "who").lines).toEqual(["Uses the tool"]);
  });
});

describe("group boxes describe themselves (2026-09-29, second pass)", () => {
  test("a group box shows its description too, at most 2 lines, above its folder line", () => {
    const m = model();
    m.N.b.desc = "does beta";
    m.N.a.desc = "Coordinates every other group through a long chain of words that cannot fit in two lines of this box";
    const { svg } = build(m);
    expect(descLines(svg, "b").lines).toEqual(["does beta"]);
    const a = descLines(svg, "a").lines;
    expect(a.length).toBe(2);
    expect(a[1].endsWith("…")).toBe(true);
    for (const l of a) expect(textWidth(l, "body", 10.5)).toBeLessThanOrEqual(m.N.a.w - 16 - 12);
    // The folder line stays, and comes last.
    const order = [...svg.matchAll(/data-for="a" data-role="(title|desc|folders)"/g)].map((x) => x[1]);
    expect(order).toEqual(["title", "desc", "folders"]);
  });
  test("a short box keeps its folder line and gives the description what is left, never overflowing", () => {
    const m = model();
    m.N.a.h = 60; // title + 1 row
    m.N.a.desc = "does alpha and a great deal more besides";
    const { svg } = build(m);
    const desc = descLines(svg, "a");
    const folders = svg.match(/<text\b[^>]*data-for="a" data-role="folders"[^>]*>([\s\S]*?)<\/text>/);
    expect(spans(folders?.[1] ?? "")).toEqual(["src/a · 2 of 4 files"]);
    expect(desc.node).toBeNull();
  });
  test("an ext box without a description draws none", () => {
    expect(descLines(build().svg, "ext").node).toBeNull();
  });
});

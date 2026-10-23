import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildExportHtml } from "../../../src/web/client/export/build-html";
import { buildExportSvg } from "../../../src/web/client/export/build-svg";
import { buildHtmlOutcome } from "../../../src/web/client/islands/repo-graph-export-html";
import { model, STAMP, trust } from "./fixtures";

const JS_PATH = join(import.meta.dir, "..", "..", "..", "public", "static", "export-standalone.js");
const BUNDLE = readFileSync(JS_PATH, "utf8");
const FONT = "@font-face { font-family: X; src: url(data:font/woff2;base64,AAAA); }";

const svgFor = (t = trust()) => buildExportSvg(model(), t, { theme: "light", fontCss: FONT, stampLine: STAMP });
type TrustT = ReturnType<typeof trust>;

function html(t: TrustT = trust(), appendix = false, standaloneJs = BUNDLE): string {
  const { svg, width, height } = svgFor();
  return buildExportHtml({ svg, width, height, model: model(), trust: t, standaloneJs, appendix });
}
const island = (h: string): string => /<script type="application\/json" id="trust">([\s\S]*?)<\/script>/.exec(h)![1];

describe("buildExportHtml — offline and closed (AC24)", () => {
  test("CSP meta is exactly the specified policy", () => {
    expect(html()).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:">`,
    );
  });

  test("no http(s) URL anywhere but the licence comment and the SVG namespace name", () => {
    const stripped = html()
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace('xmlns="http://www.w3.org/2000/svg"', "");
    expect(stripped).not.toMatch(/https?:\/\//i);
    // Positive control: the strip did remove something.
    expect(html()).toMatch(/https?:\/\//i);
  });

  test("the SVG is inlined byte for byte (AC27 by construction)", () => {
    const { svg } = svgFor();
    const h = html();
    expect(/<main id="map"[^>]*>([\s\S]*?)<\/main>/.exec(h)![1]).toBe(svg);
    expect(h).toContain(STAMP);
  });

  test("a save button, a hidden panel, and no dashboard text", () => {
    const h = html();
    expect(h).toContain('id="save-img"');
    expect(h).toContain('<aside id="panel" hidden');
    expect(h).not.toContain("SECRET-COMP-FILE"); // the on-screen "Key pieces" list is never exported
  });
});

describe("the JSON island (AC26, spec §8)", () => {
  test("listedFiles is empty for every container unless the appendix was on", () => {
    const t = trust();
    expect(t.containers.some((c) => c.listedFiles.length > 0)).toBe(true); // control: the input has files
    const off = JSON.parse(island(html(t, false)));
    expect(off.containers).toHaveLength(3);
    for (const c of off.containers) expect(c.listedFiles).toEqual([]);
    expect(island(html(t, false))).not.toContain("src/a/x.ts");
    const on = JSON.parse(island(html(t, true)));
    expect(on.containers[0].listedFiles).toEqual(["src/a/x.ts", "src/a/y.ts"]);
  });

  test("carries the evidence and source the panel and the file name need", () => {
    const d = JSON.parse(island(html()));
    expect(d.source).toBe("generated");
    const toExt = d.edges.find((e: { target: string }) => e.target === "ext");
    expect(toExt.evidence).toEqual({ kind: "cited", file: "web/api.ts", line: 40 });
    expect(toExt.n).toBe(2); // the number drawn on the edge and in the key
  });

  test("markup and </script> in a description stay inside the island as an escaped string", () => {
    const t = trust();
    const evil = `<img src=x onerror=alert(1)> </script><script>alert(2)</script> \u2028 \u2029`;
    t.containers[0].desc = evil;
    const h = html(t);
    const text = island(h);
    expect(text).not.toContain("<");
    expect(text).not.toContain("\u2028");
    expect(text).not.toContain("\u2029");
    expect(text).toContain("\\u003cimg src=x onerror=alert(1)>");
    expect(JSON.parse(text).containers[0].desc).toBe(evil);
    // The two scripts (island, panel) are the only ones: nothing in the text closed either.
    expect(h.match(/<\/script>/g)).toHaveLength(2);
    expect(h.match(/<script\b/g)).toHaveLength(2);
  });
});

describe("the standalone script (the built public/static/export-standalone.js)", () => {
  test("is inlined byte for byte — no drifting third copy", () => {
    const h = html();
    expect(h).toContain(`<script>${readFileSync(JS_PATH, "utf8")}</script>`);
  });

  test("is self-contained: no import/export, and it parses as a classic script", () => {
    expect(BUNDLE.length).toBeGreaterThan(1000); // positive control
    expect(BUNDLE).not.toMatch(/^\s*(import|export)\b/m);
    expect(BUNDLE).not.toContain("import(");
    expect(BUNDLE).not.toMatch(/\bimport\s*\{|\bimport\s+\w+\s+from\b|\bexport\s*\{|\bexport\s+(default|const|function)\b/);
    expect(() => new Function(BUNDLE)).not.toThrow();
  });

  test("writes with textContent, never innerHTML, and leaves out the dashboard and privacy modules", () => {
    expect(BUNDLE).toContain("textContent");
    expect(BUNDLE).not.toContain("innerHTML");
    expect(BUNDLE).not.toContain("outerHTML");
    expect(BUNDLE).not.toContain("AKIA"); // privacy.ts's secret shapes
    expect(BUNDLE).not.toContain("Alpine");
    expect(BUNDLE.length).toBeLessThan(12_000);
  });

  test("a script that could close itself is refused", () => {
    expect(() => html(trust(), false, "alert(1)</script><script>")).toThrow("cannot be inlined");
    expect(() => html(trust(), false, "<!--")).toThrow("cannot be inlined");
  });
});

describe("buildHtmlOutcome — the finished-output nets run over the WHOLE file, JSON island included", () => {
  const run = (poisoned: TrustT, over: { appendix?: boolean; script?: string; fontCss?: string } = {}) => {
    // The SVG is built from a CLEAN map, the island from the poisoned one: a description
    // is drawn nowhere in the SVG, so only a scan of the island can see it. The pre-render
    // check (privacyBlock) is bypassed on purpose.
    const { svg, width, height } = svgFor();
    return buildHtmlOutcome({
      svg, width, height, model: model(), trust: poisoned, fontCss: over.fontCss ?? FONT, appendix: over.appendix ?? false,
      script: async () => over.script ?? BUNDLE,
    });
  };

  test("a clean file passes", async () => {
    const out = await run(trust());
    expect(out.ok).toBe(true);
    expect(out.ok && out.html.startsWith("<!doctype html>")).toBe(true);
  });

  test("a personal path in a description that only the island carries is caught", async () => {
    const t = trust();
    t.containers[0].desc = "reads the config at /Users/alice/proj/.env";
    const out = await run(t);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.message).toContain("absolute path in export: /Users/alice/proj/.env");
  });

  test("a secret in a description that only the island carries is caught, named 'the HTML file'", async () => {
    const t = trust();
    t.containers[1].desc = "key AKIAABCDEFGHIJKLMNOP";
    const out = await run(t);
    expect(out).toEqual({
      ok: false,
      message: "A group description looks like it contains a secret (the HTML file) — regenerate the map before sharing",
    });
  });

  test("a path in edge evidence, and a path in a listed file (appendix on), are caught", async () => {
    const t = trust();
    t.edges[2].evidence = { kind: "cited", file: "/home/bob/x.ts", line: 1 };
    expect((await run(t)).ok).toBe(false);
    const u = trust();
    u.containers[0].listedFiles = ["/Users/bob/x.ts"];
    expect((await run(u, { appendix: true })).ok).toBe(false);
    expect((await run(u, { appendix: false })).ok).toBe(true); // control: emptied, so not in the file
  });

  test("the strings the file embeds verbatim are removed before scanning, not the rest", async () => {
    const font = `${FONT} /* /Users/bob/f */`;
    const { svg, width, height } = buildExportSvg(model(), trust(), { theme: "light", fontCss: font, stampLine: STAMP });
    const script = "/* /Users/bob/s AKIAABCDEFGHIJKLMNOP */";
    const args = { svg, width, height, model: model(), trust: trust(), appendix: false, script: async () => script };
    expect((await buildHtmlOutcome({ ...args, fontCss: font })).ok).toBe(true);
    expect((await buildHtmlOutcome({ ...args, fontCss: "" })).ok).toBe(false); // control: not removed → hit
  });

});

describe("buildHtmlOutcome — sources of the embedded strings", () => {
  test("a failing script fetch is a message, never a throw", async () => {
    const { svg, width, height } = svgFor();
    const out = await buildHtmlOutcome({
      svg, width, height, model: model(), trust: trust(), fontCss: FONT, appendix: false,
      script: async () => { throw new Error("export script: HTTP 503"); },
    });
    expect(out).toEqual({ ok: false, message: "HTML export failed — export script: HTTP 503" });
  });
});

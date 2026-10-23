import { describe, expect, test } from "bun:test";
import { exportButtonState } from "../../../src/web/client/islands/repo-graph-export";
import {
  copyAndReport,
  runExport,
} from "../../../src/web/client/islands/repo-graph-export-state";
import { model, STAMP, trust } from "../export/fixtures";

const COPY_REFUSED = "Copy not allowed by the browser — use Download";
const png = new Blob(["png"], { type: "image/png" });
const FONT = "@font-face { font-family: X; src: url(data:font/woff2;base64,AAAA); }";

type Deps = Parameters<typeof runExport>[0];
type Trust = ReturnType<typeof trust> & { stampLine: string; farBehind: boolean };

function reply(data: Partial<Trust> = {}, status = 200): Response {
  const body = status === 200 ? { success: true, data: { ...trust(), stampLine: STAMP, farBehind: false, ...data }, error: null } : { success: false, error: "no_map" };
  return new Response(JSON.stringify(body), { status });
}

function deps(over: Partial<Deps> & { data?: Partial<Trust>; status?: number; urls?: string[] } = {}): Deps {
  const urls = over.urls ?? [];
  return {
    source: "generated",
    model: model(),
    withRepo: (u) => `${u}&repo=h`,
    appendix: false,
    dark: false,
    fetchImpl: (async (u: string) => {
      urls.push(String(u));
      return reply(over.data, over.status);
    }) as unknown as typeof fetch,
    fontCss: async () => FONT,
    raster: async () => png,
    ...over,
  };
}

describe("exportButtonState", () => {
  test.each(["generated", "authored", "subset"] as const)("visible for %s (AC1)", (s) => {
    expect(exportButtonState(s, true).visible).toBe(true);
    expect(exportButtonState(s, true).disabled).toBe(false);
  });
  test("hidden for codemap", () => {
    expect(exportButtonState("codemap", true).visible).toBe(false);
  });
  test("no map: disabled with title No map yet (AC3)", () => {
    expect(exportButtonState("generated", false)).toMatchObject({ visible: true, disabled: true, title: "No map yet" });
  });
});

describe("runExport", () => {
  test("ok: uses the server's stamp line and farBehind, scale label, no md by default", async () => {
    const urls: string[] = [];
    const out = await runExport(deps({ urls, data: { farBehind: true } }));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.stampLine).toBe(STAMP);
    expect(out.farBehind).toBe(true);
    expect(out.label).toBe("Rendered at 2×");
    expect(out.md).toBeNull();
    expect(urls[0]).toBe("/api/repo-graph/arch/trust?source=generated&repo=h");
  });

  test("appendix=1 only when the toggle is on, and md is produced", async () => {
    const urls: string[] = [];
    const out = await runExport(deps({ urls, appendix: true }));
    expect(urls[0]).toContain("&appendix=1");
    expect(out.kind === "ok" && out.md?.startsWith("# Code Map appendix")).toBe(true);
  });

  test("404 is no-map", async () => {
    expect((await runExport(deps({ status: 404 }))).kind).toBe("no-map");
  });

});

describe("runExport — blocked and failed", () => {
  test("a secret blocks before anything is built or rasterized", async () => {
    let called = false;
    const out = await runExport(
      deps({ data: { containers: [{ ...trust().containers[0], desc: "AKIAABCDEFGHIJKLMNOP" }] }, raster: async () => { called = true; return png; } }),
    );
    expect(out).toEqual({
      kind: "blocked",
      message: "A group description looks like it contains a secret (a) — regenerate the map before sharing",
    });
    expect(called).toBe(false);
  });

  test("a path in a folder name (not AI prose) aborts on the finished SVG", async () => {
    const c = trust().containers[0];
    const out = await runExport(deps({ data: { containers: [{ ...c, folders: [{ folder: "/Users/bob/proj", listed: 1, total: 2 }] }] } }));
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("absolute path in export");
  });

  test("a path in a listed file aborts the appendix even though the SVG is clean", async () => {
    const c = trust().containers[0];
    const out = await runExport(deps({ appendix: true, data: { containers: [{ ...c, listedFiles: ["/Users/bob/x.ts"] }] } }));
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("absolute path in export");
  });

  test("a rasterize failure becomes a readable message", async () => {
    const out = await runExport(deps({ raster: async () => { throw new Error("canvas produced a blank image (over the size limit?)"); } }));
    expect(out).toEqual({ kind: "error", message: "Export failed — canvas produced a blank image (over the size limit?)" });
  });

  test("a failed fetch is an error, not a throw", async () => {
    const out = await runExport(deps({ fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch }));
    expect(out).toEqual({ kind: "error", message: "Export failed — offline" });
  });
});

describe("runExport — secrets in the finished output, and the font CSS", () => {
  test("a secret in a folder name is caught before rendering, naming its position (appendix off and on)", async () => {
    const c = trust().containers[0];
    const key = "AKIAABCDEFGHIJKLMNOP";
    let called = false;
    const raster = async () => { called = true; return png; };
    const data = { containers: [{ ...c, folders: [{ folder: `src/${key}`, listed: 1, total: 2 }] }] };
    const msg = "A group description looks like it contains a secret (container 1 folder 1) — regenerate the map before sharing";
    expect(await runExport(deps({ data, raster }))).toEqual({ kind: "blocked", message: msg });
    expect(await runExport(deps({ data, raster, appendix: true }))).toEqual({ kind: "blocked", message: msg });
    expect(called).toBe(false);
  });

  test("a secret in a `Not shown` folder or in the stamp line blocks, naming its position", async () => {
    const shown = await runExport(deps({ data: { notShown: ["src/AKIAABCDEFGHIJKLMNOP"] } }));
    expect(shown.kind === "blocked" && shown.message).toContain("(not-shown folder 1)");
    const stamp = await runExport(deps({ data: { stampLine: "Map from 2026-09-20 · AKIAABCDEFGHIJKLMNOP" } }));
    expect(stamp.kind === "blocked" && stamp.message).toContain("(stamp line)");
  });

  test("a listed-file secret is caught pre-render and never rasterized", async () => {
    let called = false;
    const c = trust().containers[0];
    const out = await runExport(deps({ appendix: true, raster: async () => { called = true; return png; }, data: { containers: [{ ...c, listedFiles: ["AKIAABCDEFGHIJKLMNOP"] }] } }));
    expect(out.kind).toBe("blocked");
    expect(called).toBe(false);
  });

  test("fontCss containing `<`: the embedded removal matches what the SVG carries", async () => {
    const font = `${FONT} /* </style> /Users/bob/f */`;
    const out = await runExport(deps({ fontCss: async () => font }));
    expect(out.kind).toBe("ok");
    const sanitized = font.replaceAll("<", "");
    let svg = "";
    await runExport(deps({ fontCss: async () => font, raster: async (s) => { svg = s; return png; } }));
    expect(svg.includes(sanitized)).toBe(true);
  });
});

describe("runExport — the HTML file rides on the same build", () => {
  const script = async () => "/* standalone */";
  const island = (html: string) => JSON.parse(/id="trust">([\s\S]*?)<\/script>/.exec(html)![1]);

  test("ok carries the file built from THIS fetch; member lists only when the appendix is on (AC26)", async () => {
    const off = await runExport(deps({ script }));
    expect(off.kind === "ok" && off.html.ok).toBe(true);
    if (off.kind !== "ok" || !off.html.ok) return;
    expect(off.html.html).toContain("/* standalone */");
    expect(off.html.html).toContain(STAMP);
    expect(island(off.html.html).containers.every((c: { listedFiles: string[] }) => c.listedFiles.length === 0)).toBe(true);
    const on = await runExport(deps({ script, appendix: true }));
    expect(on.kind === "ok" && on.html.ok && island(on.html.html).containers[0].listedFiles).toEqual(["src/a/x.ts", "src/a/y.ts"]);
  });

  test("a path only the island carries blocks the HTML, not the PNG", async () => {
    const t = trust();
    t.edges[2].evidence = { kind: "cited", file: "/home/bob/x.ts", line: 1 };
    const out = await runExport(deps({ script, data: { edges: t.edges } }));
    expect(out.kind).toBe("ok");
    expect(out.kind === "ok" && !out.html.ok && out.html.message).toContain("absolute path in export: /home/bob/x.ts");
  });

  test("an unreachable standalone script blocks the HTML only", async () => {
    const out = await runExport(deps({ script: async () => { throw new Error("export script: HTTP 503"); } }));
    expect(out.kind).toBe("ok");
    expect(out.kind === "ok" && !out.html.ok && out.html.message).toBe("HTML export failed — export script: HTTP 503");
  });
});

describe("scale ladder (through runExport)", () => {
  const big = (w: number, h: number): Deps["model"] => {
    const m = model();
    m.N.ext = { ...m.N.ext, x: w - 200, y: h - 200 };
    return m;
  };
  const scales = async (m: Deps["model"], fail?: (sc: number) => boolean) => {
    const seen: number[] = [];
    const out = await runExport(
      deps({
        model: m,
        raster: async (_s, _w, _h, sc) => {
          seen.push(sc);
          if (fail?.(sc)) throw new Error("blank");
          return png;
        },
      }),
    );
    return { seen, out };
  };
  test("small map: 2×", async () => {
    const { seen, out } = await scales(model());
    expect(seen).toEqual([2]);
    expect(out.kind === "ok" && out.label).toBe("Rendered at 2×");
  });
  test("huge map: chooseScale's reduced scale, and the label says so", async () => {
    const { seen, out } = await scales(big(30000, 30000));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeLessThan(1);
    expect(out.kind === "ok" && out.label).toContain("map too large");
  });
  test("a blank canvas at 2× retries at 1×; a failure at 1× surfaces as a message", async () => {
    const one = await scales(model(), (sc) => sc === 2);
    expect(one.seen).toEqual([2, 1]);
    expect(one.out.kind === "ok" && one.out.label).toBe("Rendered at 1×");
    const both = await scales(model(), () => true);
    expect(both.seen).toEqual([2, 1]);
    expect(both.out).toEqual({ kind: "error", message: "Export failed — blank" });
  });
});

describe("copyAndReport", () => {
  const Item = class { constructor(public d: unknown) {} } as unknown as typeof ClipboardItem;
  /** Run a copy and return what it said (null = said nothing). */
  const copy = async (clip: Parameters<typeof copyAndReport>[3], I: typeof ClipboardItem | undefined = Item, current = () => true) => {
    const said: string[] = [];
    await copyAndReport(png, current, (t) => said.push(t), clip, I);
    return said[0] ?? null;
  };
  test("refused write → exact message", async () => {
    expect(await copy({ write: async () => { throw new Error("denied"); } })).toBe(`${COPY_REFUSED} (Error)`);
  });
  test("no clipboard (insecure context) → same message", async () => {
    expect(await copy({})).toBe(`${COPY_REFUSED} (clipboard unavailable)`);
    // null, not undefined: undefined would fall back to the global ClipboardItem.
    expect(await copy({ write: async () => {} }, null as unknown as typeof ClipboardItem)).toBe(`${COPY_REFUSED} (ClipboardItem unavailable)`);
  });
  test("success", async () => {
    let got: unknown[] = [];
    expect(await copy({ write: async (i) => { got = i as unknown[]; } })).toBe("Copied — paste it anywhere");
    expect(got).toHaveLength(1);
  });
  test("the item's image/png value is a Promise of the blob — the form WebKit needs (review L4)", async () => {
    const items: Array<{ d: Record<string, unknown> }> = [];
    await copy({ write: async (i) => { items.push(...(i as unknown as Array<{ d: Record<string, unknown> }>)); } });
    const value = items[0]?.d["image/png"];
    expect(value).toBeInstanceOf(Promise);
    expect(await value).toBe(png);
  });
  test("the write is issued before any await, so the click's activation is still live", () => {
    let called = false;
    void copyAndReport(png, () => true, () => {}, { write: async () => { called = true; } }, Item);
    expect(called).toBe(true); // synchronously, in the same turn as the click
  });
  test("a late answer does not overwrite a newer status (review L3)", async () => {
    let answer!: () => void;
    let current = true;
    const said: string[] = [];
    const pending = copyAndReport(png, () => current, (t) => said.push(t), { write: () => new Promise<void>((r) => { answer = r; }) }, Item);
    current = false; // a rebuild / close / another action happened meanwhile
    answer();
    await pending;
    expect(said).toEqual([]);
    // Control: the same answer while still current is reported.
    current = true;
    const again = copyAndReport(png, () => current, (t) => said.push(t), { write: () => new Promise<void>((r) => { answer = r; }) }, Item);
    answer();
    await again;
    expect(said).toEqual(["Copied — paste it anywhere"]);
  });
});


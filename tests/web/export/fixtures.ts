import type { TrustMap } from "../../../src/repo-graph/trust-map";
import type { C4Model } from "../../../src/web/client/islands/repo-graph-c4-model";
import { tokens } from "../../../src/web/tokens/tokens";

export const STAMP = "Map from 2026-09-20 · commit a1b2c3d · 12 commits behind HEAD";

export function model(): C4Model {
  return {
    N: {
      a: {
        kind: "cont", title: "Alpha core", desc: "does alpha", accent: "sky", x: 40, y: 60, w: 200, h: 90,
        comp: [["SECRET-COMP-FILE.ts", "key piece desc"]],
      },
      b: { kind: "cont", title: "Beta store", accent: "moss", x: 340, y: 60, w: 200, h: 90 },
      c: { kind: "cont", title: "Gamma <b>&\"x\"", accent: "amber", x: 40, y: 220, w: 200, h: 90 },
      ext: { kind: "ext", title: "Some API", x: 640, y: 60, w: 140, h: 60 },
    },
    E: [
      ["a", "b", "uses"],
      ["b", "c", "writes"],
      ["a", "ext", "calls"],
    ],
    BANDS: [
      {
        x: 20, y: 40, w: 540, h: 130, label: "CORE", color: `color-mix(in srgb, ${tokens.color.terra} 9%, transparent)`,
        lc: tokens.color.bandLabelInkTerra, note: "n",
      },
      { x: 20, y: 200, w: 300, h: 130, label: "STATE", color: tokens.color.moss, lc: tokens.color.ink2, note: "", heuristic: true },
    ],
    BOUNDARY: { x: 10, y: 30, w: 560, h: 320, label: "siltpoke" },
    GROUP_ACCENT: { sky: tokens.color.sky, terra: tokens.color.terra, moss: tokens.color.moss, amber: tokens.color.amber },
  };
}

export function trust(over: Partial<TrustMap> = {}): TrustMap {
  return {
    schema: 1,
    source: "generated",
    stamp: { mapDate: "2026-09-20T00:00:00Z", commit: "a1b2c3d", commitsAhead: 12, headRelation: "ahead" },
    containers: [
      { id: "a", title: "Alpha core", desc: "does alpha", folders: [{ folder: "src/a", listed: 2, total: 4 }], listedFiles: ["src/a/x.ts", "src/a/y.ts"] },
      {
        id: "b", title: "Beta store", desc: "does beta",
        folders: [{ folder: "src/b", listed: 1, total: 2 }, { folder: "src/b2", listed: 3, total: 9 }],
        listedFiles: ["src/b/z.ts"],
      },
      { id: "c", title: "Gamma", desc: "d", folders: [{ folder: "src/c", listed: 1, total: 1 }], listedFiles: [] },
    ],
    edges: [
      { source: "a", target: "b", verb: "uses", solid: true, evidence: { kind: "import", count: 3 } },
      { source: "b", target: "c", verb: "writes", solid: false, evidence: { kind: "none", reason: "citation-stale" } },
      { source: "a", target: "ext", verb: "calls", solid: true, evidence: { kind: "cited", file: "web/api.ts", line: 40 } },
    ],
    totals: { listed: 6, total: 16 },
    notShown: ["src/zz"],
    ...over,
  };
}

/** Tiny regex helpers: bun has no DOMParser. */
export function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}
export function tags(svg: string, name: string): string[] {
  return svg.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];
}
export function texts(svg: string): string[] {
  return [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => spans(m[1]).join(" "));
}
/** The (still escaped) contents of each <tspan> line in a text node's inner markup. */
export function spans(inner: string): string[] {
  return [...inner.matchAll(/<tspan\b[^>]*>([\s\S]*?)<\/tspan>/g)].map((m) => m[1]);
}

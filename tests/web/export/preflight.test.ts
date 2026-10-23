import { describe, expect, test } from "bun:test";
import { outputSecretBlock, privacyBlock } from "../../../src/web/client/export/preflight";
import { buildExportSvg } from "../../../src/web/client/export/build-svg";
import { findSecretShaped } from "../../../src/web/client/export/privacy";
import { model, STAMP, trust } from "./fixtures";

const KEY = "AKIAABCDEFGHIJKLMNOP";
const PATH = "see /Users/alice/proj";

type Kind = "title" | "desc" | "verb" | "model-verb" | "band" | "boundary" | "node-title" | "ext-desc";
// Each kind: where the hit is named. Container fields name the container id (never the
// text, which may be the secret itself); the rest name their field.
const KINDS: Array<[Kind, string]> = [
  ["title", "b"],
  ["desc", "b"],
  ["verb", "edge a → b"],
  ["model-verb", "edge a → b"],
  ["band", "band 1"],
  ["boundary", "boundary label"],
  ["node-title", "ext"],
  ["ext-desc", "node 4 description"],
];

/** Plant `value` in exactly one field kind; return the block message. */
function plant(kind: Kind, value: string): string | null {
  const m = model();
  const t = trust();
  if (kind === "title") t.containers[1].title = value;
  if (kind === "desc") t.containers[1].desc = value;
  if (kind === "verb") t.edges[0].verb = value;
  if (kind === "model-verb") m.E[0][2] = value;
  if (kind === "band") m.BANDS[0].label = value;
  if (kind === "boundary") m.BOUNDARY.label = value;
  if (kind === "node-title") m.N.ext.title = value;
  if (kind === "ext-desc") m.N.ext.desc = value;
  return privacyBlock(m, t);
}

type Data = "container-id" | "node-id" | "edge-end" | "evidence-reason" | "evidence-file" | "listed-file";
const DATA: Array<[Data, string]> = [
  ["container-id", "container 2 id"],
  ["node-id", "node 5 id"],
  ["edge-end", "edge 1 ends"],
  ["evidence-reason", "edge 2 evidence"],
  ["evidence-file", "edge 3 evidence"],
  ["listed-file", "b"],
];

function plantData(kind: Data, value: string): string | null {
  const m = model();
  const t = trust();
  if (kind === "container-id") t.containers[1].id = value;
  if (kind === "node-id") m.N[value] = m.N.ext;
  if (kind === "edge-end") t.edges[0].source = value;
  if (kind === "evidence-reason") t.edges[1].evidence = { kind: "none", reason: value as never };
  if (kind === "evidence-file") t.edges[2].evidence = { kind: "cited", file: value, line: 1 };
  if (kind === "listed-file") t.containers[1].listedFiles = [value];
  return privacyBlock(m, t);
}

describe("privacyBlock — ids, evidence and listed files (round 2)", () => {
  test.each(DATA)("a secret in %s blocks, naming %s and never the value", (kind, where) => {
    const msg = plantData(kind, `id-${KEY}`);
    expect(msg).toContain(`secret (${where})`);
    expect(msg).not.toContain(KEY);
  });
  test("a path in a listed file is left to the finished-output check", () => {
    expect(plantData("listed-file", "/Users/bob/x.ts")).toBeNull();
  });
});

describe("privacyBlock", () => {
  test("clean fixture is not blocked", () => {
    expect(privacyBlock(model(), trust())).toBeNull();
  });

  test.each(KINDS)("a secret planted in %s blocks and names %s", (kind, where) => {
    expect(plant(kind, `token ${KEY}`)).toBe(
      `A group description looks like it contains a secret (${where}) — regenerate the map before sharing`,
    );
  });

  test.each(KINDS)("a path planted in %s blocks and names %s", (kind, where) => {
    expect(plant(kind, PATH)).toBe(
      `An AI-written label looks like it contains a local file path (${where}) — regenerate the map before sharing`,
    );
  });

  test("the message never echoes the offending text", () => {
    for (const [kind] of KINDS) expect(plant(kind, `token ${KEY}`)).not.toContain(KEY);
  });

  test("a secret wins over a path when both are present", () => {
    const t = trust();
    t.containers[0].desc = `${KEY} /Users/alice/proj`;
    expect(privacyBlock(model(), t)).toContain("secret");
  });
});

describe("outputSecretBlock (second net)", () => {
  test("names the image, then the appendix; clean is null; embedded text is removed verbatim", () => {
    const msg = (w: string) => `A group description looks like it contains a secret (${w}) — regenerate the map before sharing`;
    expect(outputSecretBlock(`<svg>id-${KEY}</svg>`, [], null)).toBe(msg("the image"));
    expect(outputSecretBlock("<svg/>", [], `- \`id-${KEY}\``)).toBe(msg("the appendix"));
    expect(outputSecretBlock("<svg/>", [], "clean")).toBeNull();
    expect(outputSecretBlock(`<style>id-${KEY}</style>`, [`id-${KEY}`], null)).toBeNull();
  });
});

// A key long enough that wrapText must break it across <tspan> lines: the shape
// (`ghp_` + 36) is then in no single line of the finished markup.
const LONG = { ghp: `ghp_${"A".repeat(60)}`, sk: `sk-${"b".repeat(60)}` };

describe("privacyBlock — what the SVG draws that no earlier list covered", () => {
  test.each(Object.entries(LONG))("a %s key in a folder name blocks, naming the position", (_n, key) => {
    const t = trust();
    t.containers[1].folders[1].folder = `src/${key}`;
    expect(privacyBlock(model(), t, STAMP)).toBe(
      "A group description looks like it contains a secret (container 2 folder 2) — regenerate the map before sharing",
    );
  });
  test("a key in a `Not shown` folder blocks", () => {
    const t = trust({ notShown: ["src/zz", `src/${LONG.ghp}`] });
    expect(privacyBlock(model(), t, STAMP)).toContain("(not-shown folder 2)");
  });
  test("a key in the stamp line blocks, and no stamp line means no stamp check", () => {
    expect(privacyBlock(model(), trust(), `${STAMP} ${KEY}`)).toContain("(stamp line)");
    expect(privacyBlock(model(), trust())).toBeNull();
  });
});

describe("outputSecretBlock — a key the line-wrap split across <tspan>s", () => {
  const built = (t = trust()) => buildExportSvg(model(), t, { theme: "light", fontCss: "", stampLine: STAMP }).svg;
  const wrapped = (svg: string, key: string): boolean => {
    // Positive control: the raw markup matches no secret shape (the key is cut into
    // pieces too short for one), yet it reads whole once the <tspan> seams are closed.
    const lines = [...svg.matchAll(/<tspan\b[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]);
    const rejoined = svg.replace(/<\/tspan>\s*<tspan\b[^>]*>/g, "");
    return findSecretShaped([{ where: "svg", text: svg }]) === null && !lines.some((l) => l.includes(key)) && rejoined.includes(key);
  };
  const leak = (w: string) => `A group description looks like it contains a secret (${w}) — regenerate the map before sharing`;

  // A folder line no longer wraps (2026-09-29 restyle: one short line per folder, the path
  // cut with "…" when it does not fit), so the wrapping surface left is a group title.
  test.each(Object.entries(LONG))("a %s key in a group title, appendix off", (_n, key) => {
    const m = model();
    m.N.a.title = `src/${key}`;
    m.N.a.h = 240; // room for every wrapped line, so no piece is clamped away
    m.N.a.desc = undefined; // a title with nothing under it is not held to 2 lines
    // The key under the diagram prints a box's title whole on one line (where the plain scan
    // already sees it); keep this box out of the key so only the wrapped title is tested.
    m.E = m.E.filter(([x, y]) => x !== "a" && y !== "a");
    const t = trust();
    t.containers[0].folders = [];
    const svg = buildExportSvg(m, t, { theme: "light", fontCss: "", stampLine: STAMP }).svg;
    expect(wrapped(svg, key)).toBe(true);
    expect(outputSecretBlock(svg, [], null)).toBe(leak("the image"));
    expect(outputSecretBlock(svg, [], null, "the HTML file")).toBe(leak("the HTML file"));
  });

  test("a key in a `Not shown` folder", () => {
    // The footer line holds 126 characters, "Not shown: " takes 11: 98 more put ghp_ and 12
    // of the 40 key characters on line 1 and the other 28 on line 2 — no piece holds a shape.
    const key = `ghp_${"A".repeat(40)}`;
    const svg = built(trust({ notShown: [`${"x".repeat(98)}/${key}`] }));
    expect(wrapped(svg, key)).toBe(true);
    expect(outputSecretBlock(svg, [], null)).toBe(leak("the image"));
  });

  test("control: the clean built SVG, and words in separate elements, do not fuse into a key", () => {
    expect(outputSecretBlock(built(), [], null)).toBeNull();
    expect(outputSecretBlock(`<text>sk-</text><text>${"b".repeat(40)}</text>`, [], null)).toBeNull();
  });
});

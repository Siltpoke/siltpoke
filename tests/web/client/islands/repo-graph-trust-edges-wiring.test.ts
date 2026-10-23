/** AC32 wiring — drives the REAL island (boot / toggle / generate / drill-back)
 * and asserts what lands in the DOM, so deleting any production wiring line
 * (a refreshTrustState() call site, the draw-loop edgeDashed, the restyle call,
 * the grounded-chip notice, the stale-response guard) turns a test red.
 * Fetch responses come from payload FACTORIES: a shared Response reads once. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { deferred, installFetchMock, jsonResponse, mountRepoGraph, registerDom, unregisterDom } from "./_dom-harness";

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});
afterEach(() => {
  window.history.replaceState(null, "", "/repo-graph");
});

const ev = (file: string) => [{ file, line: 1 }];
const node = (id: string, title: string, file: string) => ({
  id,
  kind: "cont",
  title: { value: title, evidence: ev(file) },
  band: { value: "core", evidence: ev(file) },
  drillTo: "alpha",
  members: [file],
});
// a>b: AI tier "inferred"; b>c: AI tier "cited". The trust map will DISAGREE with both.
const DOC = {
  boundary: "fixture-trust",
  bands: [{ id: "core", label: { value: "Core", evidence: ev("src/alpha/a.ts") }, order: 0, members: ["a", "b", "c"] }],
  nodes: [node("a", "AlphaBox", "src/alpha/a.ts"), node("b", "BetaBox", "src/alpha/b.ts"), node("c", "GammaBox", "src/alpha/c.ts")],
  edges: [
    { source: "a", target: "b", verb: { value: "feeds", evidence: [], tier: "inferred" } },
    { source: "b", target: "c", verb: { value: "reads", evidence: [], tier: "cited" } },
  ],
};
const AUTHORED = {
  N: { x: { kind: "cont", title: "AuthoredBox", accent: "sky", drillTo: "alpha", x: 70, y: 320, w: 170, h: 90 } },
  E: [],
  BANDS: [{ x: 54, y: 288, w: 700, h: 160, label: "AUTHBAND", color: "rgba(127,176,200,.10)", lc: "#5f8499", note: "authored" }],
  BOUNDARY: { x: 40, y: 248, w: 800, h: 300, label: "fixture-repo · authored" },
  GROUP_ACCENT: { sky: "#7fb0c8", terra: "#d96b6b", moss: "#7a9a5e", amber: "#e8a85c" },
};
const FILES = ["a.ts", "b.ts", "c.ts"].map((name) => ({
  name, path: `src/alpha/${name}`, loc: 10, symbols: 1, functions: 1, desc: "", explainState: "none" as const,
}));
const NOTE = "Edge check unavailable — dashed here means the citation was not corroborated";

/** Trust payload factory. abSolid / bcSolid = the trust map's own verdicts. */
const trustBody = (abSolid: boolean, bcSolid: boolean) => ({
  success: true,
  error: null,
  data: {
    schema: 1,
    source: "generated",
    edges: [
      { source: "a", target: "b", verb: "feeds", solid: abSolid, evidence: { kind: "none", reason: "no-import-no-citation" } },
      { source: "b", target: "c", verb: "reads", solid: bcSolid, evidence: { kind: "none", reason: "no-import-no-citation" } },
    ],
  },
});

const base = (): Array<[string, (u: string) => Promise<Response>]> => [
  ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
  ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.1 } }))],
  ["/files", () => Promise.resolve(jsonResponse({ data: { files: FILES, intraEdges: [] } }))],
];
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 4; i++) await tick();
};
const gen = { doc: DOC, groundedPct: 90, stale: false, fileFunctions: {} } as never;

/** [path, label] per edge, by verb. */
function edge(root: HTMLElement, verb: string): { path: Element; lab: Element } {
  const labs = Array.from(root.querySelectorAll(".c4-elab"));
  const paths = Array.from(root.querySelectorAll("path[marker-end]")).filter((p) => p.getAttribute("marker-end") === "url(#c4-arr)" || p.getAttribute("marker-end") === "url(#c4-arrT)");
  const i = labs.findIndex((l) => l.textContent === verb);
  if (i < 0 || !paths[i]) throw new Error(`edge not found: ${verb} (${labs.length} labels, ${paths.length} paths)`);
  return { path: paths[i]!, lab: labs[i]! };
}
const dashed = (e: { path: Element }) => e.path.hasAttribute("stroke-dasharray");
const italic = (e: { lab: Element }) => e.lab.classList.contains("inferred");

describe("AC32 wiring — Generated edges follow the trust map on screen", () => {
  test("boot: trust solid beats an AI 'inferred' tier; trust dashed beats a 'cited' tier; labels follow", async () => {
    installFetchMock([["/arch/trust", () => Promise.resolve(jsonResponse(trustBody(true, false)))], ...base()]);
    const root = await mountRepoGraph({ generatedModel: gen });
    // first paint (loading) = legacy tier: a>b dashed, b>c solid.
    expect(dashed(edge(root, "feeds"))).toBe(true);
    expect(dashed(edge(root, "reads"))).toBe(false);
    await settle();
    const ab = edge(root, "feeds");
    const bc = edge(root, "reads");
    expect(dashed(ab)).toBe(false); // trust solid, tier inferred
    expect(italic(ab)).toBe(false); // label follows the path
    expect(dashed(bc)).toBe(true); // trust dashed, tier cited
    expect(italic(bc)).toBe(true);
  });

  test("a redraw after the fetch landed still uses the trust map (draw-loop edgeDashed)", async () => {
    installFetchMock([["/arch/trust", () => Promise.resolve(jsonResponse(trustBody(true, false)))], ...base()]);
    const root = await mountRepoGraph({ generatedModel: gen });
    await settle();
    // drill into a container and come back: arch is fully re-drawn with trust ready.
    const alpha = Array.from(root.querySelectorAll<HTMLElement>(".c4-node")).find((n) => n.querySelector(".c4-ntitle")?.textContent === "AlphaBox")!;
    alpha.click();
    await tick();
    alpha.click();
    await settle();
    expect(root.querySelectorAll(".node.kind-file").length).toBeGreaterThanOrEqual(1); // left arch
    root.querySelector<HTMLElement>('#rg-crumbs .c[data-i="0"], .c[data-i="0"]')!.click();
    await settle();
    const ab = edge(root, "feeds");
    const bc = edge(root, "reads");
    expect(dashed(ab)).toBe(false);
    expect(italic(ab)).toBe(false);
    expect(dashed(bc)).toBe(true);
    expect(italic(bc)).toBe(true);
  });
});

describe("AC32 wiring — fetch failure and load triggers", () => {
  test("trust fetch 500: notice line says so, dashes fall back to the legacy tier", async () => {
    installFetchMock([["/arch/trust", () => Promise.resolve(new Response("boom", { status: 500 }))], ...base()]);
    const root = await mountRepoGraph({ generatedModel: gen });
    await settle();
    const noevi = root.querySelector<HTMLElement>("#rg-arch-noevi")!;
    expect(noevi.hidden).toBe(false);
    expect(noevi.textContent).toBe(NOTE);
    expect(dashed(edge(root, "feeds"))).toBe(true); // legacy: inferred
    expect(italic(edge(root, "feeds"))).toBe(true);
    expect(dashed(edge(root, "reads"))).toBe(false); // legacy: cited
    expect(italic(edge(root, "reads"))).toBe(false);
  });

  test("toggle Authored → Generated fetches the trust map exactly once, and only then", async () => {
    let calls = 0;
    installFetchMock([["/arch/trust", () => { calls += 1; return Promise.resolve(jsonResponse(trustBody(true, true))); }], ...base()]);
    const root = await mountRepoGraph({ authoredModel: AUTHORED, generatedModel: gen });
    await settle();
    expect(calls).toBe(0); // authored boot: no trust map
    root.querySelector<HTMLButtonElement>("#rg-src-generated")!.click();
    await settle();
    expect(calls).toBe(1);
    expect(dashed(edge(root, "feeds"))).toBe(false);
    expect(dashed(edge(root, "reads"))).toBe(false);
  });

  test("fresh generate on an authored repo fetches the trust map for the new model", async () => {
    let calls = 0;
    installFetchMock([
      ["/arch/trust", () => { calls += 1; return Promise.resolve(jsonResponse(trustBody(true, true))); }],
      ["/arch/generate", () => Promise.resolve(jsonResponse({ success: true, taskId: "t-1" }))],
      ["/arch/model", () => Promise.resolve(jsonResponse({ data: { model: DOC, groundedPct: 88 } }))],
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: { id: "t-1", kind: "arch_generate", status: "done", repo: "f1x7ur3hash0", startedTs: "2026-06-10T00:00:00.000Z", startedAgoMs: 100 } } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 1.55 } }))],
    ]);
    const root = await mountRepoGraph({ authoredModel: AUTHORED });
    await tick();
    root.querySelector<HTMLButtonElement>("#rg-arch-gen")!.click();
    await settle();
    expect(root.innerHTML).toContain("AlphaBox");
    expect(calls).toBe(1);
    expect(dashed(edge(root, "feeds"))).toBe(false);
  });
});

describe("AC32 wiring — stale responses", () => {
  test("race: an older trust response resolving LAST does not clobber the newer state", async () => {
    const d: Array<ReturnType<typeof deferred<Response>>> = [];
    installFetchMock([["/arch/trust", () => { const x = deferred<Response>(); d.push(x); return x.promise; }], ...base()]);
    const root = await mountRepoGraph({ authoredModel: AUTHORED, generatedModel: gen });
    root.querySelector<HTMLButtonElement>("#rg-src-generated")!.click(); // load 1
    await tick();
    root.querySelector<HTMLButtonElement>("#rg-src-authored")!.click();
    await tick();
    root.querySelector<HTMLButtonElement>("#rg-src-generated")!.click(); // load 2
    await tick();
    expect(d.length).toBe(2);
    d[1]!.resolve(jsonResponse(trustBody(true, true))); // newer: everything solid
    await settle();
    expect(dashed(edge(root, "feeds"))).toBe(false);
    d[0]!.resolve(jsonResponse(trustBody(false, false))); // older lands last: everything dashed
    await settle();
    expect(dashed(edge(root, "feeds"))).toBe(false);
    expect(dashed(edge(root, "reads"))).toBe(false);
    expect(root.querySelector<HTMLElement>("#rg-arch-noevi")!.textContent ?? "").not.toBe(NOTE);
  });
});

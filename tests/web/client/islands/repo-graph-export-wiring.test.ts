/** AC1/AC3 wiring — drives the REAL island and reads the Export button the way
 * a user sees it. The button must be visible in every C4 view (including the
 * plain Honest-subset view, where the source chip is hidden) and visibly
 * disabled — "No map yet" — when the page holds no map; clicking it then
 * fetches and builds nothing. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { installFetchMock, jsonResponse, mountRepoGraph, registerDom, unregisterDom } from "./_dom-harness";

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});
afterEach(() => {
  window.history.replaceState(null, "", "/repo-graph");
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 4; i++) await tick();
};
const AUTHORED = {
  N: { x: { kind: "cont", title: "AuthoredBox", accent: "sky", x: 70, y: 320, w: 170, h: 90 } },
  E: [],
  BANDS: [],
  BOUNDARY: { x: 40, y: 248, w: 800, h: 300, label: "fixture-repo · authored" },
  GROUP_ACCENT: { sky: "#7fb0c8", terra: "#d96b6b", moss: "#7a9a5e", amber: "#e8a85c" },
};
const EMPTY_GEN = { doc: { boundary: "x", bands: [], nodes: [], edges: [] }, groundedPct: 1, stale: false, fileFunctions: {} } as never;

/** Mount with a fetch mock that records every /arch/trust request. */
function mockTrust(status = 200): string[] {
  const urls: string[] = [];
  installFetchMock([
    ["/arch/trust", (u) => { urls.push(u); return Promise.resolve(status === 404 ? new Response(JSON.stringify({ success: false, error: "no_map" }), { status: 404 }) : jsonResponse({ success: false })); }],
  ]);
  return urls;
}
const btn = (root: HTMLElement) => root.querySelector<HTMLButtonElement>("#rg-export")!;

describe("Export button before any map exists (AC3)", () => {
  test("empty Authored model: visible, disabled, says why; click fetches nothing", async () => {
    const urls = mockTrust();
    const root = await mountRepoGraph({ authoredModel: { ...AUTHORED, N: {} } as never });
    await settle();
    expect(btn(root).hidden).toBe(false);
    expect(btn(root).disabled).toBe(true);
    expect(btn(root).title).toBe("No map yet");
    btn(root).click();
    await settle();
    expect(urls).toEqual([]);
  });

  test("Generated view with an empty generated model: same", async () => {
    const urls = mockTrust();
    window.history.replaceState(null, "", "/repo-graph?arch-source=generated");
    const root = await mountRepoGraph({ generatedModel: EMPTY_GEN });
    await settle();
    expect(btn(root).hidden).toBe(false);
    expect(btn(root).disabled).toBe(true);
    expect(btn(root).title).toBe("No map yet");
    const before = urls.length; // the page's own trust fetch on the Generated view
    btn(root).click();
    await settle();
    expect(urls.length).toBe(before);
  });

  test("a 404 at build time still disables the button (second net)", async () => {
    mockTrust(404);
    const root = await mountRepoGraph({ authoredModel: AUTHORED as never });
    await settle();
    expect(btn(root).disabled).toBe(false);
    btn(root).click();
    await settle();
    expect(btn(root).disabled).toBe(true);
    expect(btn(root).title).toBe("No map yet");
  });
});

describe("Export button where a map exists (AC1)", () => {
  test("Authored view: visible and enabled", async () => {
    mockTrust();
    const root = await mountRepoGraph({ authoredModel: AUTHORED as never });
    await settle();
    expect(btn(root).hidden).toBe(false);
    expect(btn(root).disabled).toBe(false);
  });

  test("plain Honest-subset view (source chip hidden): Export is still visible and enabled", async () => {
    mockTrust();
    const root = await mountRepoGraph({});
    await settle();
    expect(root.querySelector<HTMLElement>("#rg-src-chip")!.hidden).toBe(true);
    expect(btn(root).hidden).toBe(false);
    expect(btn(root).disabled).toBe(false);
  });

  test("repo with no index: no C4 view, so no Export", async () => {
    mockTrust();
    const empty = { repo: null, groups: [], subdirs: [], edges: [] } as never;
    const root = await mountRepoGraph({ projection: empty, repoEntries: [], currentProjHash: "" as never });
    await settle();
    expect(btn(root).hidden).toBe(true);
  });
});

describe("Export notice placement (AC2 layout)", () => {
  test("the notice is its own row directly after the page head, in normal flow — never floated over the toolbar", async () => {
    mockTrust();
    const root = await mountRepoGraph({ authoredModel: AUTHORED as never });
    await settle();
    const note = root.querySelector<HTMLElement>("#rg-export-note")!;
    const head = root.querySelector<HTMLElement>(".pagehead")!;
    expect(head.nextElementSibling?.id).toBe("rg-export-note");
    expect(note.hidden).toBe(false);
    const css = Array.from(root.querySelectorAll("style")).map((s) => s.textContent ?? "").join("");
    const rule = /\.rg-export-note\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule.length).toBeGreaterThan(0);
    expect(rule).not.toMatch(/position\s*:\s*absolute/);
  });
});

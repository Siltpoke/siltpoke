/** siltpoke-generate — authored-from-props gate.
 *
 * The gate must consume the authored model FROM THE PAYLOAD (SSR-loaded
 * `.siltpoke/arch-c4.json`), not from a bundle constant keyed on the repo's
 * folder name. RED on the old code: the fixture root is not named "siltpoke",
 * so `repoHasC4Model` says no-authored and the payload's `authoredModel` is
 * ignored entirely — the authored box never renders.
 */
import { afterEach, afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  installFetchMock,
  jsonResponse,
  mountRepoGraph,
  registerDom,
  unregisterDom,
} from "./_dom-harness";

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});
afterEach(() => {
  // URL-param tests rewrite the location; restore the clean page URL.
  window.history.replaceState(null, "", "/repo-graph");
});

function quietFetch(): void {
  installFetchMock([
    ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
    ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.1 } }))],
  ]);
}

/** Minimal valid authored C4 model — one band, one drillable cont. */
const AUTHORED = {
  N: {
    authbox: { kind: "cont", title: "AuthoredBox", accent: "sky", desc: "hand-written", drillTo: "alpha", x: 70, y: 320, w: 170, h: 90 },
  },
  E: [],
  BANDS: [{ x: 54, y: 288, w: 700, h: 160, label: "AUTHBAND", color: "rgba(127,176,200,.10)", lc: "#5f8499", note: "authored" }],
  BOUNDARY: { x: 40, y: 248, w: 800, h: 300, label: "fixture-repo · authored" },
  GROUP_ACCENT: { sky: "#7fb0c8", terra: "#d96b6b", moss: "#7a9a5e", amber: "#e8a85c" },
};

/** Valid generated ArchModelDoc (adapter shape — evidence-bearing). */
const GENERATED_DOC = {
  boundary: "fixture-gen",
  bands: [{ id: "core", label: { value: "GenBand", evidence: [{ file: "src/alpha/a.ts", line: 1 }] }, order: 0, members: ["genbox"] }],
  nodes: [
    { id: "genbox", kind: "cont", title: { value: "GeneratedBox", evidence: [{ file: "src/alpha/a.ts", line: 1 }] }, band: { value: "core", evidence: [{ file: "src/alpha/a.ts", line: 1 }] }, drillTo: "alpha" },
  ],
  edges: [],
};

describe("authored-from-props gate", () => {
  test("authoredModel in the payload → authored view renders by default", async () => {
    quietFetch();
    const root = await mountRepoGraph({ authoredModel: AUTHORED });
    // ── CHECKPOINT: the authored box is on the canvas. The old code ignores the
    // payload (name-keyed constant) → subset renders alpha/beta instead → RED.
    expect(root.innerHTML).toContain("AuthoredBox");
    expect(root.innerHTML).toContain("AUTHBAND");
  });

  test("a fresh generated model does NOT outrank authored (no demote)", async () => {
    quietFetch();
    const root = await mountRepoGraph({
      authoredModel: AUTHORED,
      generatedModel: { doc: GENERATED_DOC, groundedPct: 90, stale: false },
    });
    expect(root.innerHTML).toContain("AuthoredBox");
    expect(root.innerHTML).not.toContain("GeneratedBox");
  });

  test("?arch-source=generated overrides the authored default — even stale", async () => {
    quietFetch();
    window.history.replaceState(null, "", "/repo-graph?arch-source=generated");
    const root = await mountRepoGraph({
      authoredModel: AUTHORED,
      generatedModel: { doc: GENERATED_DOC, groundedPct: 90, stale: true }, // stale on purpose
    });
    expect(root.innerHTML).toContain("GeneratedBox");
    expect(root.innerHTML).not.toContain("AuthoredBox");
  });

  test("?arch-source=generated with NO generated model falls through to authored (no 500, no blank)", async () => {
    quietFetch();
    window.history.replaceState(null, "", "/repo-graph?arch-source=generated");
    const root = await mountRepoGraph({ authoredModel: AUTHORED });
    expect(root.innerHTML).toContain("AuthoredBox");
  });

  test("no authoredModel → byte-of-behavior unchanged (subset renders, no authored leak)", async () => {
    quietFetch();
    const root = await mountRepoGraph();
    expect(root.innerHTML).not.toContain("AuthoredBox");
    // subset fixture boxes render exactly as the existing boot tests pin.
    expect(root.querySelector("#rg-arch-gen")).not.toBeNull();
  });
});

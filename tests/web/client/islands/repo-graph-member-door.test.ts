/** Door = members (badge-door-members).
 *
 * On the old code: drilling a generated container opens the WHOLE bucket —
 * StatsBox's door shows ValidateBox's file (the cross-contamination this
 * fix kills). Anti-vacuous: every door assert first proves the door
 * actually OPENED (file level reached, ≥1 file node) before asserting what's
 * behind it — a no-op click can't pass by counting the arch view twice.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

const ev = (file: string) => [{ file, line: 1 }];
const SPLIT_DOC = {
  boundary: "fixture-split",
  bands: [{ id: "core", label: { value: "Core", evidence: ev("src/alpha/a.ts") }, order: 0, members: ["stats", "validate", "free"] }],
  nodes: [
    { id: "stats", kind: "cont", title: { value: "StatsBox", evidence: ev("src/alpha/a.ts") }, band: { value: "core", evidence: ev("src/alpha/a.ts") }, drillTo: "alpha", members: ["src/alpha/a.ts", "src/alpha/b.ts"] },
    { id: "validate", kind: "cont", title: { value: "ValidateBox", evidence: ev("src/alpha/c.ts") }, band: { value: "core", evidence: ev("src/alpha/c.ts") }, drillTo: "alpha", members: ["src/alpha/c.ts"] },
    // members but NO drillTo — drillTo is no longer required for a container
    // to be drillable, so this is a NORMAL drillable cont, not a leak.
    { id: "free", kind: "cont", title: { value: "FreeBox", evidence: ev("src/alpha/a.ts") }, band: { value: "core", evidence: ev("src/alpha/a.ts") }, members: ["src/alpha/a.ts"] },
  ],
  edges: [],
};
const FILE_FUNCTIONS = { "src/alpha/a.ts": 4, "src/alpha/b.ts": 2, "src/alpha/c.ts": 1 };
const FILES_ALPHA = ["a.ts", "b.ts", "c.ts"].map((name) => ({
  name,
  path: `src/alpha/${name}`,
  loc: 10,
  symbols: 1,
  functions: 1,
  desc: "",
  explainState: "none" as const,
}));

function mocks(): void {
  installFetchMock([
    ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
    ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.1 } }))],
    ["/files", () => Promise.resolve(jsonResponse({ data: { files: FILES_ALPHA, intraEdges: [] } }))],
  ]);
}

async function mountSplit() {
  mocks();
  return mountRepoGraph({
    generatedModel: { doc: SPLIT_DOC, groundedPct: 90, stale: false, fileFunctions: FILE_FUNCTIONS } as never,
  });
}

function contNode(root: HTMLElement, title: string): HTMLElement {
  const n = Array.from(root.querySelectorAll<HTMLElement>(".c4-node")).find(
    (el) => el.querySelector(".c4-ntitle")?.textContent === title,
  );
  if (!n) throw new Error(`cont not found: ${title}`);
  return n;
}

async function drill(root: HTMLElement, title: string): Promise<string[]> {
  const node = contNode(root, title);
  node.click(); // select
  await new Promise((r) => setTimeout(r, 0));
  node.click(); // drill
  await new Promise((r) => setTimeout(r, 0));
  // ANTI-VACUOUS: the door must have actually opened.
  const fileNodes = Array.from(root.querySelectorAll<HTMLElement>(".node.kind-file"));
  expect(fileNodes.length).toBeGreaterThanOrEqual(1);
  return fileNodes.map((f) => f.querySelector(".nname")?.getAttribute("title") ?? "");
}

describe("the door opens to the container's OWN members", () => {
  test("same-bucket conts open DISJOINT doors (StatsBox 2, ValidateBox 1, zero overlap)", async () => {
    const root = await mountSplit();
    const statsDoor = await drill(root, "StatsBox");
    // ── the old code opens the whole alpha bucket — ValidateBox's
    // c.ts shows up behind StatsBox's door.
    expect(statsDoor).not.toContain("src/alpha/c.ts");
    expect(statsDoor.sort()).toEqual(["src/alpha/a.ts", "src/alpha/b.ts"]);
  });

  test("the second cont's door is its OWN single member", async () => {
    const root = await mountSplit();
    const door = await drill(root, "ValidateBox");
    expect(door).toEqual(["src/alpha/c.ts"]);
  });

  test("members WITHOUT drillTo = normally drillable (conjunction dropped)", async () => {
    const root = await mountSplit();
    const free = contNode(root, "FreeBox");
    // ── the old canDrillNode requires drillTo → FreeBox unglyph'd.
    expect(free.classList.contains("drillable")).toBe(true);
    const door = await drill(root, "FreeBox");
    expect(door).toEqual(["src/alpha/a.ts"]);
  });

  test("invariant sweep: EVERY glyph'd cont drills to ≥1 file, all within its members", async () => {
    const memberByTitle: Record<string, string[]> = {
      StatsBox: ["src/alpha/a.ts", "src/alpha/b.ts"],
      ValidateBox: ["src/alpha/c.ts"],
      FreeBox: ["src/alpha/a.ts"],
    };
    for (const [title, members] of Object.entries(memberByTitle)) {
      const root = await mountSplit(); // fresh mount per cont (clean S)
      const door = await drill(root, title);
      expect(door.length).toBeGreaterThanOrEqual(1);
      for (const p of door) expect(members).toContain(p);
    }
  });

  test("subset drill keeps BUCKET semantics (whole alpha, byte-unchanged)", async () => {
    mocks();
    const root = await mountRepoGraph(); // no generated model → subset view
    const node = Array.from(root.querySelectorAll<HTMLElement>(".c4-node.drillable"))[0];
    expect(node).toBeDefined();
    node!.click();
    await new Promise((r) => setTimeout(r, 0));
    node!.click();
    await new Promise((r) => setTimeout(r, 0));
    const fileNodes = Array.from(root.querySelectorAll<HTMLElement>(".node.kind-file"));
    expect(fileNodes.length).toBe(3); // the whole bucket — subset is 1:1 by design
  });
});

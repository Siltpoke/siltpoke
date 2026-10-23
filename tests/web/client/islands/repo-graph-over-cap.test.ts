/**
 * Defect [38] — a kept over-cap architecture model is flagged beside the
 * Generate button. The pure note is tested in tests/web/client/lib; this file
 * proves the island actually WRITES it (the wiring half), through the real
 * boot path with an SSR payload.
 *
 * Run: bun test tests/web/client/islands/repo-graph-over-cap.test.ts
 */
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

const EV = [{ file: "src/alpha/a.ts", line: 1 }];
const GEN_DOC = {
  boundary: "fixture-gen",
  bands: [{ id: "core", label: { value: "GenBand", evidence: EV }, order: 0, members: ["genbox"] }],
  nodes: [
    {
      id: "genbox",
      kind: "cont",
      title: { value: "GeneratedBox", evidence: EV },
      band: { value: "core", evidence: EV },
      drillTo: "alpha",
      members: ["src/alpha/a.ts"],
    },
  ],
  edges: [],
};

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function genCostText(costUsd: number, hardCapUsd?: number): Promise<string> {
  installFetchMock([
    ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
    ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.08 } }))],
  ]);
  // subset view + fresh cache → the "Diagram is current" hint path.
  window.history.replaceState(null, "", "/repo-graph?arch-source=subset");
  const root = await mountRepoGraph({
    generatedModel: { doc: GEN_DOC as never, groundedPct: 88, stale: false, costUsd, hardCapUsd },
  });
  await tick();
  await tick();
  const genCost = root.querySelector<HTMLElement>("#rg-arch-gen-cost");
  if (!genCost) throw new Error("fixture missing #rg-arch-gen-cost");
  return genCost.textContent ?? "";
}

describe("arch over-cap note beside the Generate button (defect [38])", () => {
  test("a kept model over the cap is flagged with its cost and the cap", async () => {
    const text = await genCostText(2.3, 2);
    expect(text).toContain("Diagram is current");
    expect(text).toContain("$2.30");
    expect(text).toContain("over the $2.00 limit");
  });

  test("a model under the cap shows the plain hint only", async () => {
    const text = await genCostText(0.37, 2);
    expect(text).toContain("Diagram is current");
    expect(text).not.toContain("limit");
  });

  test("an older payload without a cap shows the plain hint only", async () => {
    const text = await genCostText(2.3);
    expect(text).toContain("Diagram is current");
    expect(text).not.toContain("limit");
  });
});

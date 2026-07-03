/** Badge = members (badge-door-members).
 *
 * On the old code: the adapter DROPS `doc.members`, so `withStats` falls
 * back to the shared bucket id — two containers splitting one bucket both
 * badge the WHOLE bucket's totals (the plc "5 files · 84 fn" ×3 lie), and a
 * member-less container still shows the drill glyph via bare `drillTo`.
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

function quietFetch(): void {
  installFetchMock([
    ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
    ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.1 } }))],
  ]);
}

const ev = (file: string) => [{ file, line: 1 }];
/** Two conts SPLIT the fixture's `alpha` bucket (2 members vs 1); a third has
 * drillTo but NO members (the honest-degrade case). */
const SPLIT_DOC = {
  boundary: "fixture-split",
  bands: [{ id: "core", label: { value: "Core", evidence: ev("src/alpha/a.ts") }, order: 0, members: ["stats", "validate", "ghost"] }],
  nodes: [
    { id: "stats", kind: "cont", title: { value: "StatsBox", evidence: ev("src/alpha/a.ts") }, band: { value: "core", evidence: ev("src/alpha/a.ts") }, drillTo: "alpha", members: ["src/alpha/a.ts", "src/alpha/b.ts"] },
    { id: "validate", kind: "cont", title: { value: "ValidateBox", evidence: ev("src/alpha/c.ts") }, band: { value: "core", evidence: ev("src/alpha/c.ts") }, drillTo: "alpha", members: ["src/alpha/c.ts"] },
    { id: "ghost", kind: "cont", title: { value: "GhostBox", evidence: ev("src/alpha/a.ts") }, band: { value: "core", evidence: ev("src/alpha/a.ts") }, drillTo: "alpha" },
  ],
  edges: [],
};
const FILE_FUNCTIONS = { "src/alpha/a.ts": 4, "src/alpha/b.ts": 2, "src/alpha/c.ts": 1 };

async function mountGenerated() {
  quietFetch();
  return mountRepoGraph({
    generatedModel: { doc: SPLIT_DOC, groundedPct: 90, stale: false, fileFunctions: FILE_FUNCTIONS } as never,
  });
}

function badgeOf(root: HTMLElement, title: string): string {
  const node = Array.from(root.querySelectorAll<HTMLElement>(".c4-node")).find((n) =>
    n.querySelector(".c4-ntitle")?.textContent === title,
  );
  return node?.querySelector(".c4-ncount")?.textContent ?? "(no badge)";
}

describe("badge counts the container's OWN members, not its bucket", () => {
  test("two conts splitting one bucket badge 2 files vs 1 file (not the bucket total twice)", async () => {
    const root = await mountGenerated();
    const stats = badgeOf(root, "StatsBox");
    const validate = badgeOf(root, "ValidateBox");
    // ── previously both read the alpha bucket's "2 files · 6 fn".
    expect(validate).toBe("1 file · 1 fn"); // exact — "1 files" plural bug can't hide as a substring
    expect(validate).not.toContain("1 files");
    expect(stats).toContain("2 files");
    expect(stats).toContain("6 fn"); // 4 + 2 over ITS members
    expect(stats).not.toBe(validate); // pairwise distinct — the twinning is dead
  });

  test("a member-less cont gets NO glyph, NO badge — and the page says so", async () => {
    const root = await mountGenerated();
    const ghost = Array.from(root.querySelectorAll<HTMLElement>(".c4-node")).find((n) =>
      n.querySelector(".c4-ntitle")?.textContent === "GhostBox",
    );
    expect(ghost).toBeDefined();
    // ── previously the bare drillTo grants the glyph + a bucket badge.
    expect(ghost!.classList.contains("drillable")).toBe(false);
    expect(ghost!.querySelector(".c4-drill")).toBeNull();
    expect(ghost!.querySelector(".c4-ncount")).toBeNull();
    const noevi = root.querySelector<HTMLElement>("#rg-arch-noevi");
    expect(noevi).not.toBeNull();
    expect(noevi!.hidden).toBe(false);
    expect(noevi!.textContent).toContain("1 containers carry no file evidence");
  });

  test("members WITH glyph keep drilling affordance (structural sanity)", async () => {
    const root = await mountGenerated();
    const stats = Array.from(root.querySelectorAll<HTMLElement>(".c4-node")).find((n) =>
      n.querySelector(".c4-ntitle")?.textContent === "StatsBox",
    );
    expect(stats!.classList.contains("drillable")).toBe(true);
  });

  test("subset view (no generated model) badges byte-unchanged", async () => {
    quietFetch();
    const root = await mountRepoGraph(); // plain fixture → subset
    // subset nodes carry projection stats exactly as before (alpha: 2 files).
    const anyCount = root.querySelector(".c4-ncount")?.textContent ?? "";
    expect(anyCount).toContain("2 files");
    const noevi = root.querySelector<HTMLElement>("#rg-arch-noevi");
    expect(noevi === null || noevi.hidden).toBe(true); // report line is generated-view only
  });
});

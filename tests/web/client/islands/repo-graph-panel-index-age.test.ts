/**
 * Defect [84] (audit §100.2): Code Map drew a file panel from a three-month-old
 * index — line count, symbol count, line numbers — and its foot said
 * "✓ cached · up to date with the code". That sentence was about the saved
 * explanation, which is compared with the INDEX, not with the file on disk.
 *
 * Unit half: what the panel may say for each index freshness. Wiring half:
 * through the real island with a fake server.
 *
 * Run: bun test tests/web/client/islands/repo-graph-panel-index-age.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { panelIndexNote } from "../../../../src/web/client/islands/repo-graph-index-freshness";
import { explBtnHtml } from "../../../../src/web/client/lib/explain-controls";
import { registerDom, unregisterDom } from "./_dom-harness";
import { click, foot, openDoThing, server } from "./_symbol-panel-harness";

const BEHIND = {
  level: "stale",
  headline: "88% out of date — re-index recommended",
  caveat: null,
  counts: { content_changed: 4, deleted_still_indexed: 0, unindexed_files: 3, indexed: 5, wrong_ratio: 0.875 },
};
const FRESH = {
  ...BEHIND,
  level: "fresh",
  headline: "index is current",
  counts: { ...BEHIND.counts, content_changed: 0, unindexed_files: 0, wrong_ratio: 0 },
};

const strip = (html: string): string => html.replace(/<[^>]+>/g, "");

describe("[84] the cached note claims the code only when the index is current", () => {
  test("fresh index: up to date with the code", () => {
    expect(strip(explBtnHtml("valid", "fresh"))).toContain("✓ cached · up to date with the code");
  });

  for (const f of ["behind", "pending", "unknown"] as const) {
    test(`${f} index: never 'up to date with the code'`, () => {
      const text = strip(explBtnHtml("valid", f));
      expect(text).toContain("✓ cached");
      expect(text).not.toContain("up to date with the code");
    });
  }

  test("behind: says the code changed since the index", () => {
    expect(strip(explBtnHtml("valid", "behind"))).toContain("matches the index, but the code changed since it was built");
  });

  test("the other states are unchanged by freshness", () => {
    expect(explBtnHtml("none", "behind")).toBe(explBtnHtml("none", "fresh"));
    expect(explBtnHtml("stale", "behind")).toBe(explBtnHtml("stale", "fresh"));
  });

  test("the panel note appears only for a behind index", () => {
    expect(strip(panelIndexNote("behind"))).toBe("From the index — some of the code has changed since it was built, so these numbers may be out of date. Re-index to refresh.");
    expect(panelIndexNote("fresh")).toBe("");
    expect(panelIndexNote("pending")).toBe("");
    expect(panelIndexNote("unknown")).toBe("");
  });
});

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});

const headText = (root: HTMLElement): string => (root.querySelector("#rg-phead")?.textContent ?? root.textContent ?? "").replace(/\s+/g, " ");

describe("[84] through the island", () => {
  test("index behind: the symbol panel says its numbers are from the index", async () => {
    const root = await openDoThing(() => {
      server.staleness = BEHIND;
    });
    expect(root.querySelector("[data-index-behind]")).not.toBeNull();
    expect(headText(root)).toContain("From the index — some of the code has changed since it was built");
  });

  test("index behind: a cached explanation does not claim to match the code", async () => {
    const root = await openDoThing(() => {
      server.staleness = BEHIND;
    });
    await click(root, "#rg-expl-btn");
    await click(root, "#rg-expl-btn");
    const f = foot(root);
    expect(f.act).toBe("open");
    expect(f.text).toContain("matches the index, but the code changed since it was built");
    expect(f.text).not.toContain("up to date with the code");
  });

  test("control — index fresh: no note, and the cached explanation is up to date with the code", async () => {
    const root = await openDoThing(() => {
      server.staleness = FRESH;
    });
    expect(root.querySelector("[data-index-behind]")).toBeNull();
    await click(root, "#rg-expl-btn");
    await click(root, "#rg-expl-btn");
    expect(foot(root).text).toContain("up to date with the code");
  });

  test("a failed check: no note, and no claim about the code", async () => {
    const root = await openDoThing();
    expect(root.querySelector("[data-index-behind]")).toBeNull();
    await click(root, "#rg-expl-btn");
    await click(root, "#rg-expl-btn");
    expect(foot(root).text).not.toContain("up to date with the code");
  });
});

type FocusFn = (t: { name: string; path: string; node_type?: string }) => Promise<boolean>;

describe("[84] the file panel", () => {
  async function openFile(staleness: Record<string, unknown> | null): Promise<HTMLElement> {
    const root = await openDoThing(() => {
      server.staleness = staleness;
    });
    const focus = (window as unknown as { __siltpokeFocusNode?: FocusFn }).__siltpokeFocusNode;
    if (!focus) throw new Error("island did not expose __siltpokeFocusNode");
    expect(await focus({ name: "a.ts", path: "src/alpha/a.ts", node_type: "file" })).toBe(true);
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    return root;
  }

  test("index behind: the line and symbol counts are marked as the index's", async () => {
    const root = await openFile(BEHIND);
    expect(headText(root)).toContain("20 lines");
    expect(root.querySelector("[data-index-behind]")).not.toBeNull();
  });

  test("a drifting index (a few files changed) is marked too", async () => {
    const root = await openFile({ ...BEHIND, level: "drifting", headline: "3% drifted since indexing" });
    expect(root.querySelector("[data-index-behind]")).not.toBeNull();
  });

  test("control — index fresh: no mark", async () => {
    const root = await openFile(FRESH);
    expect(headText(root)).toContain("20 lines");
    expect(root.querySelector("[data-index-behind]")).toBeNull();
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, it, expect } from "bun:test";
import { composeBaseSystemPrompt } from "../../src/chat/compose-base-context";

describe("composeBaseSystemPrompt precedence", () => {
  it("prefers the node anchor over page context", async () => {
    let assembleCalled = false;
    const out = await composeBaseSystemPrompt({
      anchorCtx: { systemPrompt: "ANCHOR", contextBundle: "BUNDLE" },
      pageId: "repo-graph",
      homeBase: "/tmp/nope",
      assemblePage: async () => {
        assembleCalled = true;
        return { systemPrompt: "PAGE", contextBundle: "", pageLabel: "Code map" };
      },
    });
    expect(out).toContain("ANCHOR");
    expect(out).toContain("BUNDLE");
    expect(assembleCalled).toBe(false);
  });

  it("falls back to page context when there is no anchor", async () => {
    const out = await composeBaseSystemPrompt({
      anchorCtx: null,
      pageId: "repo-graph",
      homeBase: "/tmp/nope",
      assemblePage: async () => ({ systemPrompt: "PAGE", contextBundle: "", pageLabel: "Code map" }),
    });
    expect(out).toBe("PAGE");
  });

  it("returns an empty prompt with neither anchor nor page", async () => {
    const out = await composeBaseSystemPrompt({
      anchorCtx: null,
      pageId: "",
      homeBase: "/tmp/nope",
    });
    expect(out).toBe("");
  });
});

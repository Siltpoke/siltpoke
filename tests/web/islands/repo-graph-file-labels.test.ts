/**
 * V4 — file-level drill basename disambiguation.
 *
 * Pins shortestUniqueLabels: unique basenames stay bare (no path noise),
 * colliding basenames grow the shortest trailing suffix to uniqueness, and the
 * rule is purely structural (no framework/filename constants).
 */
import { describe, expect, it } from "bun:test";
import { shortestUniqueLabels } from "../../../src/web/client/islands/repo-graph-file-labels";

describe("shortestUniqueLabels", () => {
  it("leaves all-unique basenames bare — no added path noise", () => {
    const files = [
      { name: "router.ts", path: "src/router/router.ts" },
      { name: "budget.ts", path: "src/router/budget.ts" },
      { name: "dispatch.ts", path: "src/router/dispatch.ts" },
    ];
    expect(shortestUniqueLabels(files)).toEqual(["router.ts", "budget.ts", "dispatch.ts"]);
  });

  it("disambiguates colliding basenames at the shortest unique depth (mixed depth)", () => {
    const files = [
      { name: "page.tsx", path: "app/works/[id]/page.tsx" },
      { name: "page.tsx", path: "app/auth/page.tsx" },
      { name: "layout.tsx", path: "app/layout.tsx" },
    ];
    // page.tsx collides → each grows to its shortest unique tail; layout.tsx is unique → bare.
    expect(shortestUniqueLabels(files)).toEqual(["[id]/page.tsx", "auth/page.tsx", "layout.tsx"]);
  });

  it("grows deeper when two segments still collide", () => {
    const files = [
      { name: "page.tsx", path: "app/(marketing)/about/page.tsx" },
      { name: "page.tsx", path: "app/(app)/about/page.tsx" },
    ];
    // 2-seg suffix `about/page.tsx` still collides → grow to 3.
    expect(shortestUniqueLabels(files)).toEqual([
      "(marketing)/about/page.tsx",
      "(app)/about/page.tsx",
    ]);
  });

  it("mixes unique and colliding basenames in one scope", () => {
    const files = [
      { name: "route.ts", path: "api/users/route.ts" },
      { name: "route.ts", path: "api/posts/route.ts" },
      { name: "client.ts", path: "lib/client.ts" },
    ];
    expect(shortestUniqueLabels(files)).toEqual(["users/route.ts", "posts/route.ts", "client.ts"]);
  });

  it("is order-stable (labels align to input index)", () => {
    const files = [
      { name: "index.ts", path: "a/index.ts" },
      { name: "index.ts", path: "b/index.ts" },
    ];
    expect(shortestUniqueLabels(files)).toEqual(["a/index.ts", "b/index.ts"]);
  });

  it("degenerate: identical paths fall back to the full path (no crash)", () => {
    const files = [
      { name: "dup.ts", path: "x/dup.ts" },
      { name: "dup.ts", path: "x/dup.ts" },
    ];
    expect(shortestUniqueLabels(files)).toEqual(["x/dup.ts", "x/dup.ts"]);
  });

  it("single file → bare basename", () => {
    expect(shortestUniqueLabels([{ name: "solo.ts", path: "deep/nested/solo.ts" }])).toEqual([
      "solo.ts",
    ]);
  });
});

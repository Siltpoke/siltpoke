import { describe, expect, it } from "bun:test";
import {
  computeContentHash,
  type EvalExample,
  type EvalManifest,
  freezeGuard,
  freezeManifest,
} from "../../../src/eval/caller-impact/manifest";

const exA: EvalExample = {
  id: "ex-a",
  repo: "repo-1",
  diff: "@@ -1 +1 @@",
  plantedBug: { file: "src/foo.ts", function: "doFoo", line: 42 },
  isControl: false,
};

const exB: EvalExample = {
  id: "ex-b",
  repo: "repo-1",
  diff: "@@ -2 +2 @@",
  plantedBug: null,
  isControl: true,
};

describe("computeContentHash", () => {
  it("is stable for the same examples", () => {
    const h1 = computeContentHash([exA, exB]);
    const h2 = computeContentHash([exA, exB]);
    expect(h1).toBe(h2);
  });

  it("is order-independent (canonicalized by id)", () => {
    const h1 = computeContentHash([exA, exB]);
    const h2 = computeContentHash([exB, exA]);
    expect(h1).toBe(h2);
  });

  it("is key-order independent on the example object", () => {
    // Same data, keys inserted in a different order.
    const reordered: EvalExample = {
      isControl: false,
      plantedBug: { line: 42, function: "doFoo", file: "src/foo.ts" },
      diff: "@@ -1 +1 @@",
      repo: "repo-1",
      id: "ex-a",
    };
    expect(computeContentHash([reordered])).toBe(computeContentHash([exA]));
  });

  it("changes when a planted-bug field is tampered", () => {
    const tampered: EvalExample = {
      ...exA,
      plantedBug: { file: "src/foo.ts", function: "doFoo", line: 99 },
    };
    expect(computeContentHash([tampered, exB])).not.toBe(
      computeContentHash([exA, exB]),
    );
  });
});

describe("freezeGuard (INV2)", () => {
  const manifest: EvalManifest = {
    version: "1",
    examples: [exA, exB],
    contentHash: computeContentHash([exA, exB]),
  };

  it("passes when live examples match the frozen hash", () => {
    const result = freezeGuard(manifest, [exA, exB]);
    expect(result.ok).toBe(true);
  });

  it("passes regardless of live example order", () => {
    expect(freezeGuard(manifest, [exB, exA]).ok).toBe(true);
  });

  it("refuses when a live example is tampered (INV2)", () => {
    const tampered: EvalExample = {
      ...exA,
      plantedBug: { file: "src/foo.ts", function: "doFoo", line: 99 },
    };
    const result = freezeGuard(manifest, [tampered, exB]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("drift");
  });

  it("refuses when an example is dropped (count drift)", () => {
    const result = freezeGuard(manifest, [exA]);
    expect(result.ok).toBe(false);
  });
});

describe("freezeManifest (INV2 pins diff bytes)", () => {
  it("builds a manifest whose hash matches computeContentHash", () => {
    const m = freezeManifest("1", [exA, exB]);
    expect(m.contentHash).toBe(computeContentHash([exA, exB]));
    expect(freezeGuard(m, [exA, exB]).ok).toBe(true);
  });

  it("throws when an example has diffPath but no inline diff content", () => {
    const pathOnly: EvalExample = {
      id: "ex-path",
      repo: "repo-1",
      diffPath: "fixtures/ex-path.diff", // provenance only — content not pinned
      plantedBug: null,
      isControl: true,
    };
    expect(() => freezeManifest("1", [pathOnly])).toThrow(/inline diff content/);
  });
});

/**
 * Unit tests for the explain-transform helpers in the repo-graph route
 * (fileFromNodeId / firstParagraph / parseCitations) — the pure pieces behind
 * POST /explain → Explanation, exercised directly for edge coverage.
 */
import { test, expect, describe } from "bun:test";
import {
  fileFromNodeId,
  firstParagraph,
  parseCitations,
} from "../../src/daemon/routes/repo-graph";

describe("fileFromNodeId", () => {
  test("extracts the path from a kind:path: node id", () => {
    expect(fileFromNodeId("file:src/explain/explain.ts:")).toBe("src/explain/explain.ts");
    expect(fileFromNodeId("function:src/explain/explain.ts:runExplain")).toBe("src/explain/explain.ts");
  });
  test("strips a trailing slash from a bare subdir scope", () => {
    expect(fileFromNodeId("src/explain/")).toBe("src/explain");
  });
  test("returns null for a bare token with no path/colon", () => {
    expect(fileFromNodeId("runExplain")).toBeNull();
  });
});

describe("firstParagraph", () => {
  test("skips leading markdown headings + returns the first prose block", () => {
    const md = "# explain.ts\n\nexplain.ts is the orchestrator.\n\nMore detail here.";
    expect(firstParagraph(md)).toBe("explain.ts is the orchestrator.");
  });
  test("skips the depth-hint footer marker", () => {
    const md = "💡 Try --depth 2\n\nReal lead sentence.";
    expect(firstParagraph(md)).toBe("Real lead sentence.");
  });
  test("collapses whitespace within the block", () => {
    expect(firstParagraph("a\n  b   c")).toBe("a b c");
  });
});

describe("parseCitations", () => {
  test("parses [path:line] + bare path:line refs, deduped", () => {
    const md = "See [src/explain/explain.ts:34] and src/explain/cache.ts:18 plus [src/explain/explain.ts:34] again.";
    const refs = parseCitations(md).map((c) => c.ref);
    expect(refs).toContain("src/explain/explain.ts:34");
    expect(refs).toContain("src/explain/cache.ts:18");
    // dedup: the repeated :34 appears once.
    expect(refs.filter((r) => r === "src/explain/explain.ts:34")).toHaveLength(1);
  });
  test("caps at 8 citations", () => {
    const md = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts:${i + 1}`).join(" ");
    expect(parseCitations(md).length).toBeLessThanOrEqual(8);
  });
  test("returns empty for prose with no refs", () => {
    expect(parseCitations("just words, no citations")).toEqual([]);
  });
});

import { describe, test, expect } from "bun:test";
import { adaptiveHunkBody } from "../../../src/critic/tools/diff-summarizer";

describe("adaptiveHunkBody", () => {
  test("hunk ≤ 60 lines → return full body", async () => {
    const body = Array.from({ length: 50 }, (_, i) => `+ line ${i}`).join("\n");
    expect(await adaptiveHunkBody(body, { sha: "abc" })).toBe(body);
  });

  test("hunk 60-200 → head 30 + tail 30 + elision marker", async () => {
    const body = Array.from({ length: 150 }, (_, i) => `+ line ${i}`).join("\n");
    const out = await adaptiveHunkBody(body, { sha: "abc" });
    expect(out).toContain("[middle 90 lines elided]");
    expect(out).toContain("line 0");
    expect(out).toContain("line 149");
  });

  test("hunk > 200 → LLM summary called", async () => {
    const body = Array.from({ length: 300 }, (_, i) => `+ line ${i}`).join("\n");
    const out = await adaptiveHunkBody(body, {
      sha: "xyz",
      summarizer: async () => "[SUMMARY: 300 lines added; 5 functions; minor stylistic edits.]",
    });
    expect(out).toContain("[SUMMARY:");
  });
});

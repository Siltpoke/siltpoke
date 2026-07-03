import { describe, test, expect } from "bun:test";
import { runDiffSummary } from "../../../src/critic/tools/run-diff-summary";
import type { BrainCallRawResult } from "../../../src/brain/brain";
import type { CallBrainOptions } from "../../../src/brain/brain";

type MockFn = (opts: CallBrainOptions) => Promise<BrainCallRawResult>;

const SAMPLE_DIFF = `diff --git a/x.ts b/x.ts
@@ -1,3 +1,5 @@
+export const FOO = 1;
+export const BAR = 2;
 export const BAZ = 3;
`;

describe("runDiffSummary — schema coercion", () => {
  test("over-length purpose (>160 chars) is truncated, not rejected", async () => {
    const overLongPurpose = "x".repeat(220);
    const callFn: MockFn = async () => ({
      output: {
        intent: "test intent",
        key_changes: ["one change"],
        risks: [],
        file_count: 1,
        files_with_purpose: [{ path: "x.ts", purpose: overLongPurpose }],
        source: "haiku",
      },
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0 },
    });
    const r = await runDiffSummary({ diffText: SAMPLE_DIFF, callFn });
    expect(r).not.toBeNull();
    expect(r?.summary.files_with_purpose[0].purpose.length).toBeLessThanOrEqual(160);
    expect(r?.summary.files_with_purpose[0].purpose).toContain("xxxx");
  });

  test("over-length intent (>600) truncated", async () => {
    const callFn: MockFn = async () => ({
      output: {
        intent: "x".repeat(700),
        key_changes: [],
        risks: [],
        file_count: 0,
        files_with_purpose: [],
        source: "haiku",
      },
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0 },
    });
    const r = await runDiffSummary({ diffText: SAMPLE_DIFF, callFn });
    expect(r?.summary.intent.length).toBeLessThanOrEqual(600);
  });

  test("over-length key_changes entry (>300) truncated", async () => {
    const callFn: MockFn = async () => ({
      output: {
        intent: "ok",
        key_changes: ["x".repeat(400)],
        risks: [],
        file_count: 0,
        files_with_purpose: [],
        source: "haiku",
      },
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0 },
    });
    const r = await runDiffSummary({ diffText: SAMPLE_DIFF, callFn });
    expect(r?.summary.key_changes[0].length).toBeLessThanOrEqual(300);
  });

  test("at-limit purpose (exactly 160) passes unchanged", async () => {
    const exact = "x".repeat(160);
    const callFn: MockFn = async () => ({
      output: {
        intent: "ok",
        key_changes: [],
        risks: [],
        file_count: 1,
        files_with_purpose: [{ path: "x.ts", purpose: exact }],
        source: "haiku",
      },
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0 },
    });
    const r = await runDiffSummary({ diffText: SAMPLE_DIFF, callFn });
    expect(r?.summary.files_with_purpose[0].purpose).toBe(exact);
  });
});

import { afterEach, describe, test, expect } from "bun:test";
import { __setTestGapDeps, testGapRule } from "../../../../src/critic/rubric/tier1/test-gap";

// This suite pins the pre-existing in-diff gate (threshold + in-diff matching test)
// unchanged by the Slice ② disk upgrade. It injects `TestGapDeps` so the assertions
// stay isolated from the real filesystem/git — disk-level behavior (new-vs-modified,
// downgrade, fail-open) is covered end-to-end in test-gap-disk.test.ts.
afterEach(() => __setTestGapDeps({}));

describe("test-gap rule", () => {
  test("source diff > 30 lines + no test diff, no disk test either → MED trigger", async () => {
    __setTestGapDeps({
      isNewFile: () => false,
      importers: () => new Map([["src/foo.ts", { importers: [], truncated: false, degraded: false }]]),
    });
    const result = await testGapRule.run({
      cwd: "/x",
      changedFiles: ["/x/src/foo.ts"],
      diffHunks: [{ file: "src/foo.ts", addedLines: Array.from({length: 40}, (_,i) => i+1) }],
    });
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0].severity).toBe("med");
  });

  test("source diff + matching test diff → no trigger", async () => {
    const result = await testGapRule.run({
      cwd: "/x",
      changedFiles: ["/x/src/foo.ts", "/x/tests/foo.test.ts"],
      diffHunks: [
        { file: "src/foo.ts", addedLines: Array.from({length: 40}, (_,i) => i+1) },
        { file: "tests/foo.test.ts", addedLines: [1,2,3] },
      ],
    });
    expect(result.triggers).toHaveLength(0);
  });

  test("source diff ≤ 30 lines → no trigger (too small to require tests)", async () => {
    const result = await testGapRule.run({
      cwd: "/x",
      changedFiles: ["/x/src/foo.ts"],
      diffHunks: [{ file: "src/foo.ts", addedLines: [1,2,3,4,5] }],
    });
    expect(result.triggers).toHaveLength(0);
  });
});

import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { godFileRule } from "../../../../src/critic/rubric/tier1/god-file";

describe("god-file rule", () => {
  const dir = join(tmpdir(), `siltpoke-test-${Date.now()}`);

  test("file ≤ 500 lines → no trigger", async () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "small.ts");
    writeFileSync(path, "x\n".repeat(400));
    const result = await godFileRule.run({ cwd: dir, changedFiles: [path], diffHunks: [] });
    expect(result.triggers).toHaveLength(0);
    rmSync(dir, { recursive: true });
  });

  test("file exactly 500 lines → no trigger (threshold is exclusive >500)", async () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "boundary.ts");
    // "x\n".repeat(500) → 500 "x" lines + trailing empty line = 501 items from split("\n")
    // Use 499 repetitions to get exactly 500 lines
    writeFileSync(path, `${"x\n".repeat(499)}x`);
    const result = await godFileRule.run({ cwd: dir, changedFiles: [path], diffHunks: [] });
    expect(result.triggers).toHaveLength(0);
    rmSync(dir, { recursive: true });
  });

  test("file > 500 lines → HIGH trigger", async () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "huge.ts");
    writeFileSync(path, "x\n".repeat(600));
    const result = await godFileRule.run({ cwd: dir, changedFiles: [path], diffHunks: [] });
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0].severity).toBe("high");
    expect(result.triggers[0].rule_id).toBe("god-file");
    rmSync(dir, { recursive: true });
  });
});

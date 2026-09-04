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

  // Measured, not hypothetical: 15 of the 26 rubric-restatement findings in the
  // 2026-08-21 critic failure corpus told an append-only ledger — LEDGER.md,
  // BACKLOG.md, CHANGELOG.md — to "split by responsibility", a split those documents'
  // design forbids. Prose has no "responsibility" to split by, and a ledger is
  // supposed to grow. See an internal design note
  //
  // The engine's own `languages` gate cannot fix this: engine.ts:17-20 decides
  // whether a rule runs AT ALL from whether ANY changed file matches, then run()
  // walks every changed file regardless. So one .ts in the diff lets the rule loose
  // on every .md beside it. The filter has to live per-file, here.
  test("markdown over the threshold → no trigger", async () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "ledger.md");
    writeFileSync(path, "x\n".repeat(2500));
    const result = await godFileRule.run({ cwd: dir, changedFiles: [path], diffHunks: [] });
    expect(result.triggers).toHaveLength(0);
    rmSync(dir, { recursive: true });
  });

  test("a source file in the same diff as a huge ledger still triggers, and only for itself", async () => {
    mkdirSync(dir, { recursive: true });
    const md = join(dir, "LEDGER.md");
    const ts = join(dir, "fat.ts");
    writeFileSync(md, "x\n".repeat(2500));
    writeFileSync(ts, "x\n".repeat(600));
    const result = await godFileRule.run({ cwd: dir, changedFiles: [md, ts], diffHunks: [] });
    expect(result.triggers.map(t => t.file)).toEqual([ts]);
    rmSync(dir, { recursive: true });
  });

  test("data and text files over the threshold → no trigger", async () => {
    mkdirSync(dir, { recursive: true });
    const paths = ["big.json", "big.jsonl", "notes.txt", "answers.snapshot.txt", "lock.yaml"].map(n => join(dir, n));
    mkdirSync(dir, { recursive: true });
    for (const p of paths) writeFileSync(p, "x\n".repeat(900));
    const result = await godFileRule.run({ cwd: dir, changedFiles: paths, diffHunks: [] });
    expect(result.triggers).toHaveLength(0);
    rmSync(dir, { recursive: true });
  });

  test("an extensionless file over the threshold → no trigger (not known to be source)", async () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "Makefile");
    writeFileSync(path, "x\n".repeat(900));
    const result = await godFileRule.run({ cwd: dir, changedFiles: [path], diffHunks: [] });
    expect(result.triggers).toHaveLength(0);
    rmSync(dir, { recursive: true });
  });

  test("shell and python over the threshold still trigger — they are source", async () => {
    mkdirSync(dir, { recursive: true });
    const sh = join(dir, "context-floor.sh");
    const py = join(dir, "validate.py");
    writeFileSync(sh, "x\n".repeat(900));
    writeFileSync(py, "x\n".repeat(900));
    const result = await godFileRule.run({ cwd: dir, changedFiles: [sh, py], diffHunks: [] });
    expect(result.triggers.map(t => t.file).sort()).toEqual([sh, py].sort());
    rmSync(dir, { recursive: true });
  });
});

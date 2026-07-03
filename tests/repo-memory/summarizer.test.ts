import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stubSummarize, summarizeFile } from "../../src/repo-memory/summarizer.ts";

describe("summarizer", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "siltpoke-summarizer-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("stubSummarize produces a non-empty summary containing path", async () => {
    const source = `import { foo } from "bar";\nexport const myFn = () => 42;\n`;
    const summary = await stubSummarize(source, "src/utils/my-fn.ts");
    expect(summary).toContain("src/utils/my-fn.ts");
    expect(summary.length).toBeGreaterThan(10);
  });

  test("stubSummarize includes export lines", async () => {
    const source = `export const alpha = 1;\nexport const beta = 2;\n`;
    const summary = await stubSummarize(source, "src/alpha.ts");
    expect(summary).toContain("export const alpha");
  });

  test("summarizeFile returns cached=false on first call, cached=true on second", async () => {
    const source = "export const x = 1;";
    const r1 = await summarizeFile(source, "src/x.ts", { cacheDir: tmp });
    expect(r1.cached).toBe(false);
    expect(r1.summary).toBeTruthy();

    const r2 = await summarizeFile(source, "src/x.ts", { cacheDir: tmp });
    expect(r2.cached).toBe(true);
    expect(r2.summary).toBe(r1.summary);
  });

  test("summarizeFile uses custom summarize fn when provided", async () => {
    const customSummarize = async (_source: string, path: string) => `CUSTOM:${path}`;
    const r = await summarizeFile("anything", "src/foo.ts", {
      cacheDir: tmp,
      summarize: customSummarize,
    });
    expect(r.summary).toBe("CUSTOM:src/foo.ts");
    expect(r.cached).toBe(false);
  });
});

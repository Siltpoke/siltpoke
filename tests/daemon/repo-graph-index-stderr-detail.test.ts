/**
 * A failed index must be able to say WHY.
 *
 * `defaultIndexRunner` spawned the child with `stderr: "ignore"`. That is what
 * let a spawn which could never succeed — the dist/ path bug pinned in
 * repo-graph-indexer-target.test.ts — run for its whole life reporting nothing
 * anywhere: the child said `error: Module not found …` on every single run and
 * neither a log line nor a pixel of UI ever carried it.
 *
 * These cover the reporting half: the stderr tail is captured, reduced to one
 * showable line, and only attached where it means something.
 *
 * Run: bun test tests/daemon/repo-graph-index-stderr-detail.test.ts
 */
import { describe, expect, test } from "bun:test";
import { indexerFailureLine } from "../../src/daemon/routes/repo-graph";

describe("indexerFailureLine — the two shapes that actually occur", () => {
  test("missing-module: the single error line survives its trailing blank", () => {
    // Verbatim shape of the live failure this whole PR came from.
    const tail = 'error: Module not found "/Users/v/Projects/ai-agents/siltpoke/cli/index-repo.ts"\n\n';
    expect(indexerFailureLine(tail)).toBe(
      'error: Module not found "/Users/v/Projects/ai-agents/siltpoke/cli/index-repo.ts"',
    );
  });

  test("crash: picks the error, NOT bun's trailing version banner", () => {
    // Captured by running `bun` on a throwing script — bun signs off with a
    // version line, so "the last non-blank line" reports the runtime version as
    // if it were the cause. This is the `index_error` terminal's shape.
    const tail = [
      "2 |   throw new Error(\"boom from inner\");",
      "                ^",
      "error: boom from inner",
      "      at inner (/tmp/boom.ts:2:13)",
      "      at loadAndEvaluateModule (2:1)",
      "",
      "Bun v1.3.11 (macOS arm64)",
    ].join("\n");
    expect(indexerFailureLine(tail)).toBe("error: boom from inner");
  });

  test("the banner alone is never reported as a failure reason", () => {
    expect(indexerFailureLine("Bun v1.3.11 (macOS arm64)\n")).toBeUndefined();
  });

  test("first error: line wins when several were written", () => {
    expect(indexerFailureLine("warning: x\nerror: the real one\nerror: a later one")).toBe(
      "error: the real one",
    );
  });

  test("no error: line at all → falls back to the last meaningful line", () => {
    expect(indexerFailureLine("something broke\n   \n\n")).toBe("something broke");
    expect(indexerFailureLine("first\nsecond\nlast one")).toBe("last one");
  });

  test("truncates a runaway line instead of putting it all on the wire", () => {
    const long = `error: ${"x".repeat(500)}`;
    const out = indexerFailureLine(long);
    expect(out).not.toBeUndefined();
    expect(out!.length).toBeLessThanOrEqual(200);
    expect(out!.endsWith("…")).toBe(true);
    // Positive control: the untruncated input really was longer than the cap,
    // so this is not passing because the fixture was short.
    expect(long.length).toBeGreaterThan(200);
  });

  test("undefined for no stderr and for whitespace-only stderr", () => {
    expect(indexerFailureLine(undefined)).toBeUndefined();
    expect(indexerFailureLine("")).toBeUndefined();
    expect(indexerFailureLine("\n  \n\t\n")).toBeUndefined();
  });
});

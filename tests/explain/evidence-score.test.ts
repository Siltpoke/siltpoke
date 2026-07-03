/**
 * evidence-score.ts tests.
 */
import { test, expect, describe } from "bun:test";
import {
  extractCitations,
  scoreCitations,
  type KnownFile,
} from "../../src/explain/evidence-score";

const KNOWN_FILES: Map<string, KnownFile> = new Map([
  ["src/cli/doctor.ts", { path: "src/cli/doctor.ts", maxLine: 200 }],
  ["src/brain/schema.ts", { path: "src/brain/schema.ts", maxLine: 100 }],
]);

describe("extractCitations", () => {
  test("extracts single-line citation `[file:line]`", () => {
    const out = extractCitations("see [src/cli/doctor.ts:42] for the entry");
    expect(out).toEqual([
      { file: "src/cli/doctor.ts", startLine: 42, endLine: 42 },
    ]);
  });

  test("extracts range citation `[file:start-end]`", () => {
    const out = extractCitations("body is [src/cli/doctor.ts:42-87]");
    expect(out).toEqual([
      { file: "src/cli/doctor.ts", startLine: 42, endLine: 87 },
    ]);
  });

  test("extracts citations inside markdown link text `[file:line](href)`", () => {
    const md = "See [src/cli/doctor.ts:42](src/cli/doctor.ts#L42) here.";
    const out = extractCitations(md);
    expect(out).toContainEqual({
      file: "src/cli/doctor.ts",
      startLine: 42,
      endLine: 42,
    });
  });

  test("returns empty array when no citations", () => {
    expect(extractCitations("nothing to cite")).toEqual([]);
  });

  test("dedupes identical citations", () => {
    const md = "[src/x.ts:1] [src/x.ts:1] [src/x.ts:2]";
    const out = extractCitations(md);
    expect(out).toHaveLength(2);
  });
});

describe("scoreCitations", () => {
  test("all cited files in knownFiles → score 1.0", () => {
    const result = scoreCitations(
      "[src/cli/doctor.ts:42] [src/brain/schema.ts:24]",
      KNOWN_FILES,
    );
    expect(result.score).toBe(1.0);
    expect(result.grounded).toHaveLength(2);
    expect(result.ungrounded).toHaveLength(0);
    expect(result.total).toBe(2);
  });

  test("hallucinated file → ungrounded, score reflects fraction", () => {
    const result = scoreCitations(
      "[src/cli/doctor.ts:42] [src/imaginary.ts:1]",
      KNOWN_FILES,
    );
    expect(result.score).toBe(0.5);
    expect(result.grounded).toHaveLength(1);
    expect(result.ungrounded).toHaveLength(1);
    expect(result.ungrounded[0].file).toBe("src/imaginary.ts");
  });

  test("line beyond file maxLine → ungrounded", () => {
    const result = scoreCitations(
      "[src/cli/doctor.ts:9999]",
      KNOWN_FILES,
    );
    expect(result.score).toBe(0);
    expect(result.ungrounded[0]).toMatchObject({
      file: "src/cli/doctor.ts",
      startLine: 9999,
    });
  });

  test("range citation requires both endpoints in range", () => {
    const okay = scoreCitations("[src/cli/doctor.ts:1-200]", KNOWN_FILES);
    expect(okay.score).toBe(1.0);
    const bad = scoreCitations("[src/cli/doctor.ts:1-9999]", KNOWN_FILES);
    expect(bad.score).toBe(0);
  });

  test("empty markdown (no citations) → score 0 (no evidence given)", () => {
    const result = scoreCitations("just prose, no citations", KNOWN_FILES);
    expect(result.score).toBe(0);
    expect(result.total).toBe(0);
  });

  test("partial grounding produces precise fraction", () => {
    const md =
      "[src/cli/doctor.ts:1] [src/brain/schema.ts:1] [src/x.ts:1] [src/y.ts:1]";
    const result = scoreCitations(md, KNOWN_FILES);
    expect(result.score).toBeCloseTo(0.5, 4);
    expect(result.grounded).toHaveLength(2);
    expect(result.ungrounded).toHaveLength(2);
  });
});

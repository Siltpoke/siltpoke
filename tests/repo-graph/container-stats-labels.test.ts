/**
 * Pure label-formatter tests — the one place badge/breakdown TEXT is built.
 * Counts + basenames are DATA; the strings here are generic words only.
 */
import { describe, expect, test } from "bun:test";
import {
  badgeLabel,
  breakdownRows,
} from "../../src/repo-graph/container-stats-labels";
import type { ContainerStats } from "../../src/repo-graph/container-stats";

const stats = (over: Partial<ContainerStats>): ContainerStats => ({
  fileCount: 0,
  funcCount: 0,
  recurringBasenames: [],
  ...over,
});

describe("badgeLabel", () => {
  test("files only when no functions", () => {
    expect(badgeLabel(stats({ fileCount: 229 }))).toBe("229 files");
  });

  test("files · fn when functions present", () => {
    expect(badgeLabel(stats({ fileCount: 229, funcCount: 122 }))).toBe(
      "229 files · 122 fn",
    );
  });

  test("code box with other files appends '· N other'", () => {
    expect(badgeLabel(stats({ fileCount: 1, funcCount: 1, otherCount: 2 }))).toBe("1 file · 1 fn · 2 other");
  });

  test("a box of only other files says so instead of '0 files'", () => {
    expect(badgeLabel(stats({ otherCount: 3 }))).toBe("3 other files");
    expect(badgeLabel(stats({ otherCount: 1 }))).toBe("1 other file");
  });

  test("otherCount 0 or absent leaves the label unchanged", () => {
    expect(badgeLabel(stats({ fileCount: 4, funcCount: 5, otherCount: 0 }))).toBe("4 files · 5 fn");
  });
});

describe("breakdownRows", () => {
  test("recurring basenames → 'count× name' rows (name is data)", () => {
    expect(
      breakdownRows(
        stats({ recurringBasenames: [{ name: "page.tsx", count: 46 }] }),
      ),
    ).toEqual(["46× page.tsx"]);
  });

  test("no recurring → single no-pattern line", () => {
    expect(breakdownRows(stats({}))).toEqual([
      "no recurring filename pattern",
    ]);
  });
});

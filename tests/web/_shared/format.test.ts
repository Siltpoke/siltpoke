import { test, expect, describe } from "bun:test";
import { formatCount } from "../../../src/web/_shared/format";

describe("formatCount", () => {
  test("0 renders as '0'", () => {
    expect(formatCount(0)).toBe("0");
  });

  test("999 renders as '999' (below threshold)", () => {
    expect(formatCount(999)).toBe("999");
  });

  test("1000 renders as '1k' (no trailing .0)", () => {
    expect(formatCount(1000)).toBe("1k");
  });

  test("1500 renders as '1.5k'", () => {
    expect(formatCount(1500)).toBe("1.5k");
  });

  test("5400 renders as '5.4k'", () => {
    expect(formatCount(5400)).toBe("5.4k");
  });

  test("99999 renders as '99.9k' (truncated, not rounded)", () => {
    expect(formatCount(99999)).toBe("99.9k");
  });

  test("999999 renders as '999.9k' (truncated, not rounded)", () => {
    expect(formatCount(999999)).toBe("999.9k");
  });

  test("2000 renders as '2k' (no trailing .0)", () => {
    expect(formatCount(2000)).toBe("2k");
  });

  test("10000 renders as '10k'", () => {
    expect(formatCount(10000)).toBe("10k");
  });

  test("1099 renders as '1k' (truncated to tenths, .09 dropped)", () => {
    expect(formatCount(1099)).toBe("1k");
  });

  test("1100 renders as '1.1k'", () => {
    expect(formatCount(1100)).toBe("1.1k");
  });
});

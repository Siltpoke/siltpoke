import { describe, expect, test } from "bun:test";
import { chooseScale, scaleLabel } from "../../../src/web/client/export/scale";

describe("chooseScale", () => {
  test("small map renders at 2x", () => {
    expect(chooseScale(1000, 800)).toEqual({ scale: 2, reduced: false });
  });
  test("side limit at 2x falls back to 1x", () => {
    expect(chooseScale(9000, 1000)).toEqual({ scale: 1, reduced: false });
  });
  test("area limit at 2x falls back to 1x", () => {
    // 2x: 4000*2 = 8000 per side ok, area 3000*... 3000*2500*4 = 30M > 16M; 1x = 7.5M ok
    expect(chooseScale(3000, 2500)).toEqual({ scale: 1, reduced: false });
  });
  test("oversized map is reduced to the tightest limit, floored to 2 dp", () => {
    expect(chooseScale(20000, 2000)).toEqual({ scale: 0.63, reduced: true });
  });
  test("exactly at the limits stays unreduced", () => {
    expect(chooseScale(8192, 488)).toEqual({ scale: 2, reduced: false }); // 8192*488*4 = 15.99M
    expect(chooseScale(16384, 976)).toEqual({ scale: 1, reduced: false }); // 16384*976 = 15.99M
  });
});

describe("scaleLabel", () => {
  test("exact preview strings", () => {
    expect(scaleLabel({ scale: 2, reduced: false })).toBe("Rendered at 2×");
    expect(scaleLabel({ scale: 1, reduced: false })).toBe("Rendered at 1×");
    expect(scaleLabel({ scale: 0.63, reduced: true })).toBe(
      "Rendered at 0.63× — map too large for a sharp image; the HTML export has no size limit",
    );
  });
});

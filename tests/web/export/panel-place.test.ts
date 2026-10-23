/** Where the exported HTML's side panel goes: level with the clicked box, always inside the window. */
import { describe, expect, test } from "bun:test";
import { placePanel } from "../../../src/web/client/export/panel-place";

describe("placePanel", () => {
  test("level with the box when it fits", () => {
    expect(placePanel(300, 400, 900)).toEqual({ top: 300, maxHeight: null });
  });
  test("a low box: moved up just enough to end 12px above the window's bottom", () => {
    expect(placePanel(700, 400, 900)).toEqual({ top: 488, maxHeight: null });
  });
  test("a box above the window's top (scrolled past): not above the 12px margin", () => {
    expect(placePanel(-200, 400, 900)).toEqual({ top: 12, maxHeight: null });
  });
  test("a panel taller than the window: top-aligned, and it scrolls inside", () => {
    expect(placePanel(500, 1200, 900)).toEqual({ top: 12, maxHeight: 876 });
  });
  test("exactly the window's room fits without a scrollbar", () => {
    expect(placePanel(500, 876, 900)).toEqual({ top: 12, maxHeight: null });
  });
});

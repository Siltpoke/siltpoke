// The PNG scale ladder, shared by the dashboard preview and the standalone HTML
// file's "Save as image" (AC28: the same PNG export would produce — one copy of
// the ladder, not two that drift).
import { rasterize } from "./rasterize";
import { chooseScale } from "./scale";

type Scale = ReturnType<typeof chooseScale>;

/** 2× → 1× → reduced by the size limits (chooseScale); if the browser still
 * paints a blank canvas at 2×, one retry at 1× before giving up. */
export async function renderPng(
  svg: string,
  w: number,
  h: number,
  raster: typeof rasterize = rasterize,
): Promise<{ blob: Blob; choice: Scale }> {
  const first = chooseScale(w, h);
  try {
    return { blob: await raster(svg, w, h, first.scale), choice: first };
  } catch (err) {
    if (first.scale <= 1) throw err;
    const second: Scale = { scale: 1, reduced: false };
    return { blob: await raster(svg, w, h, second.scale), choice: second };
  }
}

/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { sparkline } from "../../../src/web/charts/sparkline";

describe("sparkline", () => {
  test("default width 120, height 40", () => {
    const html = String(sparkline([1, 2, 3]));
    expect(html).toContain('width="120"');
    expect(html).toContain('height="40"');
  });

  test("custom width/height honored", () => {
    const html = String(sparkline([1, 2, 3], { width: 200, height: 60 }));
    expect(html).toContain('width="200"');
    expect(html).toContain('height="60"');
  });

  test("viewBox = '0 0 (len-1) (max-min)' for [1,2,3,4,5]", () => {
    const html = String(sparkline([1, 2, 3, 4, 5]));
    expect(html).toContain('viewBox="0 0 4 4"');
  });

  test("path d-string for [1,2,3,4,5] — y inverted (max=5 at top, min=1 at bottom)", () => {
    const html = String(sparkline([1, 2, 3, 4, 5]));
    expect(html).toContain('d="M 0,4 L 1,3 L 2,2 L 3,1 L 4,0"');
  });

  test("preserveAspectRatio='none' for non-uniform scaling", () => {
    const html = String(sparkline([1, 2, 3]));
    expect(html).toContain('preserveAspectRatio="none"');
  });

  test("stroke defaults to 'currentColor'", () => {
    const html = String(sparkline([1, 2, 3]));
    expect(html).toContain('stroke="currentColor"');
  });

  test("custom stroke applied", () => {
    const html = String(sparkline([1, 2, 3], { stroke: "#ff0000" }));
    expect(html).toContain('stroke="#ff0000"');
  });

  test("fill defaults to 'none' → no area path", () => {
    const html = String(sparkline([1, 2, 3]));
    const pathCount = (html.match(/<path/g) ?? []).length;
    expect(pathCount).toBe(1);
  });

  test("fill !== 'none' → adds closed area path", () => {
    const html = String(sparkline([1, 2, 3], { fill: "#cccccc" }));
    const pathCount = (html.match(/<path/g) ?? []).length;
    expect(pathCount).toBe(2);
    expect(html).toContain('fill="#cccccc"');
    // Closed area: ends with Z, includes corner anchors L (xMax,yMax) L 0,yMax
    expect(html).toMatch(/L 2,2 L 0,2 Z/);
  });

  test("ariaLabel renders <title> child and role='img'", () => {
    const html = String(sparkline([1, 2, 3], { ariaLabel: "Last 7 days" }));
    expect(html).toContain("<title>Last 7 days</title>");
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Last 7 days"');
  });

  test("no ariaLabel → no <title>, no role", () => {
    const html = String(sparkline([1, 2, 3]));
    expect(html).not.toContain("<title>");
    expect(html).not.toContain('role="img"');
  });

  test("single value → flat line across full width (M 0,0.5 L 1,0.5)", () => {
    const html = String(sparkline([5]));
    expect(html).toContain('d="M 0,0.5 L 1,0.5"');
    expect(html).toContain('viewBox="0 0 1 1"');
  });

  test("all-equal values → flat line at midline", () => {
    const html = String(sparkline([4, 4, 4, 4]));
    expect(html).toContain('d="M 0,0.5 L 3,0.5"');
    expect(html).toContain('viewBox="0 0 3 1"');
  });

  test("all-zero values → flat line at midline", () => {
    const html = String(sparkline([0, 0, 0, 0, 0]));
    expect(html).toContain('d="M 0,0.5 L 4,0.5"');
  });

  test("empty array → empty svg shell, no path", () => {
    const html = String(sparkline([]));
    expect(html).toContain("<svg");
    expect(html).not.toContain("<path");
  });

  test("empty array with ariaLabel still renders title for AT", () => {
    const html = String(sparkline([], { ariaLabel: "No data" }));
    expect(html).toContain("<title>No data</title>");
    expect(html).toContain('role="img"');
  });

  test("vector-effect non-scaling-stroke prevents stroke distortion", () => {
    const html = String(sparkline([1, 2, 3]));
    expect(html).toContain('vector-effect="non-scaling-stroke"');
  });
});

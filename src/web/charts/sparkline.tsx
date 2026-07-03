// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */

/**
 * Server-rendered inline sparkline. Returns an `<svg>` element with one path
 * (line) and an optional second path (area fill when `fill` is set).
 *
 * The viewBox maps data-coords (x: 0..len-1, y: 0..range) to display via
 * `preserveAspectRatio="none"`, so the same path string scales to any
 * width/height the caller passes.
 *
 * Edge cases:
 *  - empty values → empty <svg> shell (no path).
 *  - single value → horizontal line at midline across full width.
 *  - all-equal values (range = 0) → horizontal line at midline.
 */

export interface SparklineOptions {
  /** Display width in CSS pixels. Default 120. */
  width?: number;
  /** Display height in CSS pixels. Default 40. */
  height?: number;
  /** Stroke color for the line path. Default "currentColor". */
  stroke?: string;
  /** Fill color for the area path. "none" (default) suppresses the area. */
  fill?: string;
  /** Accessible label rendered as <title> child + aria-label. */
  ariaLabel?: string;
}

export function sparkline(values: number[], opts: SparklineOptions = {}) {
  const {
    width = 120,
    height = 40,
    stroke = "currentColor",
    fill = "none",
    ariaLabel,
  } = opts;

  if (values.length === 0) {
    return (
      <svg
        width={width}
        height={height}
        role={ariaLabel ? "img" : undefined}
        aria-label={ariaLabel}
      >
        {ariaLabel && <title>{ariaLabel}</title>}
      </svg>
    );
  }

  const len = values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const xMax = Math.max(1, len - 1);
  const yMax = range === 0 ? 1 : range;

  let d: string;
  if (range === 0) {
    d = `M 0,0.5 L ${xMax},0.5`;
  } else {
    const points = values.map((v, i) => `${i},${max - v}`);
    d = `M ${points.join(" L ")}`;
  }

  const areaPath =
    fill !== "none"
      ? `${d} L ${xMax},${yMax} L 0,${yMax} Z`
      : null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${xMax} ${yMax}`}
      preserveAspectRatio="none"
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
    >
      {ariaLabel && <title>{ariaLabel}</title>}
      {areaPath && <path d={areaPath} fill={fill} stroke="none" />}
      <path
        d={d}
        fill="none"
        stroke={stroke}
        stroke-width="1"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  );
}

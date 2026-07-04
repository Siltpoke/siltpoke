// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { tokens } from "../tokens/tokens";
import { sparkline } from "./sparkline";

const ASCENDING = [1, 2, 3, 4, 5, 6, 7];
const SPIKY = [3, 8, 4, 12, 5, 9, 2];
const FLAT = [4, 4, 4, 4, 4, 4, 4];

const stories: PreviewStory[] = [
  {
    name: "ascending — line only",
    render: () => (
      <div style={{ padding: 24, color: tokens.color.terra }}>
        {sparkline(ASCENDING, { ariaLabel: "Ascending trend" })}
      </div>
    ),
  },
  {
    name: "spiky — wider canvas + custom stroke",
    render: () => (
      <div style={{ padding: 24 }}>
        {sparkline(SPIKY, {
          width: 200,
          height: 60,
          stroke: tokens.color.moss,
          ariaLabel: "Spiky activity",
        })}
      </div>
    ),
  },
  {
    name: "flat — all-equal edge case",
    render: () => (
      <div style={{ padding: 24, color: tokens.color.ink2 }}>
        {sparkline(FLAT, { ariaLabel: "Flat (no variation)" })}
      </div>
    ),
  },
  {
    name: "single value — drawn across width",
    render: () => (
      <div style={{ padding: 24, color: tokens.color.terra }}>
        {sparkline([42], { ariaLabel: "Single value" })}
      </div>
    ),
  },
  {
    name: "with area fill",
    render: () => (
      <div style={{ padding: 24, color: tokens.color.terra }}>
        {sparkline(SPIKY, {
          stroke: tokens.color.terra,
          fill: tokens.color.paperD,
          ariaLabel: "Area fill",
        })}
      </div>
    ),
  },
];

export default stories;

// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { VitalsPanel } from "./VitalsPanel";
import type { VitalsData, VitalsValues } from "./VitalsPanel";

const SAMPLE_VITALS: VitalsData = {
  mood:   [5, 5, 6, 6, 7, 6, 6],
  hunger: [3, 4, 5, 6, 7, 5, 4],
  energy: [6, 7, 7, 8, 7, 7, 7],
  bond:   [7, 7, 7, 8, 8, 8, 8],
};

const SAMPLE_VALUES: VitalsValues = {
  mood:   "6/10",
  hunger: "fed",
  energy: "7/10",
  bond:   "+0.4",
};

const ALL_ZEROS: VitalsData = {
  mood:   [0, 0, 0, 0, 0, 0, 0],
  hunger: [0, 0, 0, 0, 0, 0, 0],
  energy: [0, 0, 0, 0, 0, 0, 0],
  bond:   [0, 0, 0, 0, 0, 0, 0],
};

const ZERO_VALUES: VitalsValues = {
  mood:   "0/10",
  hunger: "hungry",
  energy: "0/10",
  bond:   "0.0",
};

const SPIKY: VitalsData = {
  mood:   [1, 0, 0, 0, 0, 8, 0],
  hunger: [2, 0, 0, 0, 0, 9, 0],
  energy: [3, 0, 0, 0, 0, 10, 0],
  bond:   [1, 0, 0, 0, 0, 7, 0],
};

const stories: PreviewStory[] = [
  {
    name: "sample 7-day trend",
    render: () => (
      <div style={{ padding: 24, maxWidth: 400 }}>
        <VitalsPanel vitals={SAMPLE_VITALS} values={SAMPLE_VALUES} />
      </div>
    ),
  },
  {
    name: "edge — all zeros (flat lines)",
    render: () => (
      <div style={{ padding: 24, maxWidth: 400 }}>
        <VitalsPanel vitals={ALL_ZEROS} values={ZERO_VALUES} />
      </div>
    ),
  },
  {
    name: "edge — spiky single-day burst",
    render: () => (
      <div style={{ padding: 24, maxWidth: 400 }}>
        <VitalsPanel vitals={SPIKY} values={SAMPLE_VALUES} />
      </div>
    ),
  },
];

export default stories;

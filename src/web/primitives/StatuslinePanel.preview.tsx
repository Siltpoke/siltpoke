// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { StatuslinePanel } from "./StatuslinePanel";

const SHORT = "siltpoke · happy · L3";

const FULL_6_LINE = `siltpoke @ home
mood:  happy
hp:    9/10  ████████░
hunger:7/10  ███████░░
energy:8/10  ████████░
level: 3 · 540 / 1000 XP`;

const EDGE_WIDE = `[ALERT] outbound queue 2,341 messages — backpressure engaged @ 14:32:08 UTC, retry interval 30s`;

const stories: PreviewStory[] = [
  {
    name: "short — single line",
    render: () => (
      <div style={{ padding: 24, maxWidth: 360 }}>
        <StatuslinePanel text={SHORT} />
      </div>
    ),
  },
  {
    name: "full 6-line statusline",
    render: () => (
      <div style={{ padding: 24, maxWidth: 360 }}>
        <StatuslinePanel text={FULL_6_LINE} />
      </div>
    ),
  },
  {
    name: "edge — long single line (no scroll)",
    render: () => (
      <div style={{ padding: 24, maxWidth: 360 }}>
        <StatuslinePanel text={EDGE_WIDE} />
      </div>
    ),
  },
];

export default stories;

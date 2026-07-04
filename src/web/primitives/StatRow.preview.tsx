// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { tokens } from "../tokens/tokens";
import { StatRow } from "./StatRow";

const stories: PreviewStory[] = [
  {
    name: "full bar (terra)",
    render: () => (
      <div style={{ width: 280, display: "flex", flexDirection: "column", gap: 8 }}>
        <StatRow icon="💡" label="curiosity" value={10} max={10} />
        <StatRow icon="🔥" label="energy" value={8} max={10} />
        <StatRow icon="🎯" label="focus" value={7} max={10} />
      </div>
    ),
  },
  {
    name: "empty bar",
    render: () => (
      <div style={{ width: 280 }}>
        <StatRow icon="💤" label="stamina" value={0} max={10} />
      </div>
    ),
  },
  {
    name: "custom color (moss)",
    render: () => (
      <div style={{ width: 280, display: "flex", flexDirection: "column", gap: 8 }}>
        <StatRow icon="🌿" label="health" value={9} max={10} color={tokens.color.moss} />
        <StatRow icon="⚡" label="speed" value={5} max={10} color={tokens.color.amber} />
      </div>
    ),
  },
  {
    name: "no icon",
    render: () => (
      <div style={{ width: 280 }}>
        <StatRow label="xp earned" value={6} max={10} />
      </div>
    ),
  },
];

export default stories;

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { tokens } from "../tokens/tokens";
import { Dot } from "./Dot";

const stories: PreviewStory[] = [
  {
    name: "default (terra, size 8)",
    render: () => <Dot />,
  },
  {
    name: "moss, size 12",
    render: () => <Dot color={tokens.color.moss} size={12} />,
  },
  {
    name: "amber, size 10",
    render: () => <Dot color={tokens.color.amber} size={10} />,
  },
  {
    name: "traffic-light trio",
    render: () => (
      <div style={{ display: "flex", gap: 5 }}>
        <Dot color="#e36049" size={9} />
        <Dot color="#e8a85c" size={9} />
        <Dot color="#7a9a5e" size={9} />
      </div>
    ),
  },
];

export default stories;

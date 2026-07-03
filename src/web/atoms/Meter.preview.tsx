// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { tokens } from "../tokens/tokens";
import { Meter } from "./Meter";

const stories: PreviewStory[] = [
  {
    name: "3 of 10 (terra)",
    render: () => <Meter value={3} max={10} />,
  },
  {
    name: "8 of 10 (terra)",
    render: () => <Meter value={8} max={10} />,
  },
  {
    name: "5 of 10 (moss)",
    render: () => <Meter value={5} max={10} color={tokens.color.moss} />,
  },
  {
    name: "compact segments (segW=6 segH=6)",
    render: () => <Meter value={4} max={8} segW={6} segH={6} />,
  },
];

export default stories;

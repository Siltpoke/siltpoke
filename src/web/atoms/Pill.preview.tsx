// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { tokens } from "../tokens/tokens";
import { Pill } from "./Pill";

const stories: PreviewStory[] = [
  {
    name: "default",
    render: () => <Pill>default</Pill>,
  },
  {
    name: "terra background",
    render: () => (
      <Pill bg={tokens.color.terra} border={tokens.color.terra} color="#fff">
        terra
      </Pill>
    ),
  },
  {
    name: "moss background",
    render: () => (
      <Pill bg={tokens.color.moss} border={tokens.color.moss} color="#fff">
        moss
      </Pill>
    ),
  },
  {
    name: "amber background",
    render: () => (
      <Pill bg={tokens.color.amber} border={tokens.color.amber} color={tokens.color.ink}>
        amber
      </Pill>
    ),
  },
];

export default stories;

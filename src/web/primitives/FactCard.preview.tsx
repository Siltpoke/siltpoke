// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { tokens } from "../tokens/tokens";
import { FactCard } from "./FactCard";

const stories: PreviewStory[] = [
  {
    name: "high confidence (moss)",
    render: () => (
      <FactCard
        id="fact-001"
        text="The project uses Bun as the runtime and bundler."
        age="2h ago"
        confidence={0.92}
      />
    ),
  },
  {
    name: "mid confidence (amber)",
    render: () => (
      <FactCard
        id="fact-002"
        text="The team prefers small focused functions under 50 lines."
        age="1d ago"
        confidence={0.72}
      />
    ),
  },
  {
    name: "low confidence (terra)",
    render: () => (
      <FactCard
        id="fact-003"
        text="Authentication is handled by a third-party OAuth provider."
        age="3d ago"
        confidence={0.41}
      />
    ),
  },
  {
    name: "with goal + constraint pills",
    render: () => (
      <FactCard
        id="fact-004"
        text="Must ship the dashboard shell before the main UI screens."
        age="4h ago"
        confidence={0.88}
        goal
        constraint
        borderAccent={tokens.color.moss}
      />
    ),
  },
  {
    name: "with supersedes + reason",
    render: () => (
      <FactCard
        id="fact-005"
        text="Token budget is $3.00/day (revised down from $5.00)."
        age="6h ago"
        confidence={0.95}
        supersedes="fact-002"
        reason="Budget was reduced after board review on 2026-05-10."
        borderAccent={tokens.color.amber}
      />
    ),
  },
];

export default stories;

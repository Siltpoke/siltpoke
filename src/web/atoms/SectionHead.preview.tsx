// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { SectionHead } from "./SectionHead";

const stories: PreviewStory[] = [
  {
    name: "title only",
    render: () => <SectionHead title="Inbox" />,
  },
  {
    name: "title + sub",
    render: () => <SectionHead title="Inbox" sub="3 unread messages" />,
  },
  {
    name: "kicker + title + sub",
    render: () => (
      <SectionHead
        kicker="Activity"
        title="Recent Events"
        sub="Last 7 days"
      />
    ),
  },
  {
    name: "kicker only + title",
    render: () => <SectionHead kicker="Status" title="All systems nominal" />,
  },
];

export default stories;

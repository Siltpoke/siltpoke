// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { TimelineEvent } from "./TimelineEvent";

const stories: PreviewStory[] = [
  {
    name: "success tone",
    render: () => (
      <div style={{ width: 320 }}>
        <TimelineEvent
          time="2h ago"
          title="tests passed"
          body="All 1206 suite assertions green. Bundle size under 35 KB."
          tone="success"
        />
        <TimelineEvent
          time="4h ago"
          title="client wiring committed"
          body="Alpine islands + nanostores stores landed."
          tone="success"
          isLast
        />
      </div>
    ),
  },
  {
    name: "warn tone",
    render: () => (
      <div style={{ width: 320 }}>
        <TimelineEvent
          time="30m ago"
          title="budget at 80%"
          body="$4.01 of $5.00 spent today. Slowing down on heavy operations."
          tone="warn"
          isLast
        />
      </div>
    ),
  },
  {
    name: "danger tone",
    render: () => (
      <div style={{ width: 320 }}>
        <TimelineEvent
          time="1m ago"
          title="daemon crashed"
          body="SIGTERM received. Restarting via nohup detach."
          tone="danger"
          isLast
        />
      </div>
    ),
  },
  {
    name: "neutral tone + isLast suppresses line",
    render: () => (
      <div style={{ width: 320 }}>
        <TimelineEvent time="Mar 14, 09:12" title="project initialized" tone="neutral" />
        <TimelineEvent
          time="Mar 14, 09:14"
          title="first fact written"
          body="siltpoke inferred a coding preference from the first chat session."
          tone="neutral"
          isLast
        />
      </div>
    ),
  },
];

export default stories;

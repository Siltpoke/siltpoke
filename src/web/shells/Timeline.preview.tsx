// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { Timeline } from "./Timeline";
import { Creature } from "../creature/Creature";

const EVENTS = [
  { time: "just now", title: "daemon started", tone: "success" as const },
  { time: "2m ago", title: "chat message received", body: "hey, how are you?", tone: "neutral" as const },
  { time: "15m ago", title: "memory saved", body: "Favourite food: ramen", tone: "success" as const },
  { time: "1h ago", title: "sync warning", body: "embeddings model slow", tone: "warn" as const },
  { time: "3h ago", title: "error: timeout", body: "llm call exceeded 30s", tone: "danger" as const },
];

const stories: PreviewStory[] = [
  {
    name: "5 events — all tones",
    render: () => (
      <div style={{ height: 400 }}>
        <Timeline
          title="Activity"
          events={EVENTS}
        />
      </div>
    ),
  },
  {
    name: "empty state — creature art",
    render: () => (
      <div style={{ height: 320 }}>
        <Timeline
          title="Activity"
          events={[]}
          emptyArt={<Creature species="otter" mood="sleepy" stage="juvenile" cell={5} />}
          emptySub="no activity yet — start a chat"
        />
      </div>
    ),
  },
  {
    name: "empty state — no title, no art",
    render: () => (
      <div style={{ height: 200 }}>
        <Timeline events={[]} emptySub="nothing to show" />
      </div>
    ),
  },
];

export default stories;

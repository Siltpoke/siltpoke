// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { FactoidPanel } from "./FactoidPanel";
import type { Fact } from "../../memory/memory";

const NOW = new Date("2026-05-18T14:00:00Z");

function mkFact(i: number, over: Partial<Fact> = {}): Fact {
  return {
    id: `f-${i}`,
    text: `factoid number ${i} — short summary of what was remembered`,
    source_session_id: `s-${i}`,
    confidence: 0.85,
    status: "active",
    created_at: "2026-05-18T10:00:00Z",
    last_seen_at: `2026-05-18T${String(13 - (i % 6)).padStart(2, "0")}:00:00Z`,
    supersedes: null,
    superseded_by: null,
    pinned: false,
    recall_count: 0,
    retired_reason: null,
    stability: "durable",
    learned_from: null,
    last_confirmed_at: null,
    expires_at: null,
    save_reason: null,
    invalid_at: null,
    events: [],
    kind: null,
    ...over,
  };
}

const SHORT_LIST: Fact[] = [
  mkFact(1, { status: "active" }),
  mkFact(2, { status: "pending" }),
  mkFact(3, { status: "retired" }),
];

const TWELVE_FACTS: Fact[] = Array.from({ length: 12 }, (_, i) =>
  mkFact(i + 1, {
    status: i % 3 === 0 ? "active" : i % 3 === 1 ? "pending" : "retired",
  }),
);

const stories: PreviewStory[] = [
  {
    name: "3 facts — fits without scroll",
    render: () => (
      <div style={{ padding: 24, maxWidth: 420 }}>
        <FactoidPanel facts={SHORT_LIST} now={NOW} />
      </div>
    ),
  },
  {
    name: "12 facts — capped at 10 + scrolls",
    render: () => (
      <div style={{ padding: 24, maxWidth: 420 }}>
        <FactoidPanel facts={TWELVE_FACTS} now={NOW} />
      </div>
    ),
  },
  {
    name: "empty state",
    render: () => (
      <div style={{ padding: 24, maxWidth: 420 }}>
        <FactoidPanel facts={[]} now={NOW} />
      </div>
    ),
  },
];

export default stories;

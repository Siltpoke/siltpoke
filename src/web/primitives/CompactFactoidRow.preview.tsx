// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { CompactFactoidRow } from "./CompactFactoidRow";
import type { Fact } from "../../memory/memory";

const NOW = new Date("2026-05-18T14:00:00Z");

function makeFact(over: Partial<Fact>): Fact {
  return {
    id: "f-preview-1",
    text: "user prefers concise updates over verbose ones",
    source_session_id: "s-1",
    confidence: 0.92,
    status: "active",
    created_at: "2026-05-18T13:00:00Z",
    last_seen_at: "2026-05-18T13:30:00Z",
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

const stories: PreviewStory[] = [
  {
    name: "active — 30m ago",
    render: () => (
      <div style={{ padding: 24, maxWidth: 420 }}>
        <CompactFactoidRow fact={makeFact({})} now={NOW} />
      </div>
    ),
  },
  {
    name: "pending — 5h ago",
    render: () => (
      <div style={{ padding: 24, maxWidth: 420 }}>
        <CompactFactoidRow
          fact={makeFact({
            id: "f-preview-2",
            status: "pending",
            last_seen_at: "2026-05-18T09:00:00Z",
            text: "user mentioned wanting to integrate with Linear",
          })}
          now={NOW}
        />
      </div>
    ),
  },
  {
    name: "retired — 3d ago + long-text truncation",
    render: () => (
      <div style={{ padding: 24, maxWidth: 420 }}>
        <CompactFactoidRow
          fact={makeFact({
            id: "f-preview-3",
            status: "retired",
            last_seen_at: "2026-05-15T14:00:00Z",
            text: "this is a deliberately long factoid that should be truncated with an ellipsis when rendered inside the compact row container layout",
          })}
          now={NOW}
        />
      </div>
    ),
  },
];

export default stories;

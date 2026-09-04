// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { ResolvedContextBadge } from "./ResolvedContextBadge";

const stories: PreviewStory[] = [
  {
    name: "explicit — ?repo= selection",
    render: () => (
      <div style={{ padding: 24, maxWidth: 360 }}>
        <ResolvedContextBadge
          source="explicit"
          displayName="siltpoke"
          projHash="d752c853b0ee1e50"
        />
      </div>
    ),
  },
  {
    name: "sticky — server-side pin",
    render: () => (
      <div style={{ padding: 24, maxWidth: 360 }}>
        <ResolvedContextBadge
          source="sticky"
          displayName="ledger"
          projHash="0071b49a9413fb7f"
        />
      </div>
    ),
  },
  {
    name: "recent — recency guess",
    render: () => (
      <div style={{ padding: 24, maxWidth: 360 }}>
        <ResolvedContextBadge
          source="recent"
          displayName="siltpoke"
          projHash="d752c853b0ee1e50"
        />
      </div>
    ),
  },
  {
    name: "stale — pinned project no longer exists",
    render: () => (
      <div style={{ padding: 24, maxWidth: 360 }}>
        <ResolvedContextBadge source="stale" displayName={null} projHash={null} />
      </div>
    ),
  },
  {
    name: "none — no active project",
    render: () => (
      <div style={{ padding: 24, maxWidth: 360 }}>
        <ResolvedContextBadge source="none" displayName={null} projHash={null} />
      </div>
    ),
  },
];

export default stories;

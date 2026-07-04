// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { tokens } from "../tokens/tokens";
import { ListDetail } from "./ListDetail";
import { FactCard } from "../primitives/FactCard";

const stories: PreviewStory[] = [
  {
    name: "default widths — fact list + detail pane",
    render: () => (
      <div style={{ height: 360 }}>
        <ListDetail
          list={
            <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              <FactCard
                id="f-001"
                text="Favourite food is ramen"
                age="2d"
                confidence={0.92}
              />
              <FactCard
                id="f-002"
                text="Current mood: good vibes"
                age="1h"
                confidence={0.78}
              />
              <FactCard
                id="f-003"
                text="Working on siltpoke project"
                age="now"
                confidence={0.99}
                goal
              />
            </div>
          }
          detail={
            <div style={{ padding: 20 }}>
              <div
                style={{
                  fontFamily: tokens.font.display,
                  fontSize: 18,
                  color: tokens.color.ink,
                  marginBottom: 8,
                }}
              >
                Favourite food
              </div>
              <div
                style={{
                  fontFamily: tokens.font.body,
                  fontSize: 13,
                  color: tokens.color.ink2,
                }}
              >
                Remembered: 2 days ago · confidence: high
              </div>
            </div>
          }
        />
      </div>
    ),
  },
  {
    name: "narrow list (200px)",
    render: () => (
      <div style={{ height: 280 }}>
        <ListDetail
          listWidth={200}
          list={
            <div style={{ padding: 8 }}>
              <div
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 11,
                  color: tokens.color.ink3,
                  padding: "4px 8px",
                }}
              >
                narrow list
              </div>
            </div>
          }
          detail={
            <div
              style={{
                padding: 20,
                fontFamily: tokens.font.body,
                color: tokens.color.ink2,
                fontSize: 13,
              }}
            >
              detail pane (wider)
            </div>
          }
        />
      </div>
    ),
  },
];

export default stories;

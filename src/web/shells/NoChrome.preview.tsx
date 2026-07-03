// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { tokens } from "../tokens/tokens";
import { NoChrome } from "./NoChrome";
import { Creature } from "../creature/Creature";
import { EmptyPlaceholder } from "../primitives/EmptyPlaceholder";

const stories: PreviewStory[] = [
  {
    name: "default align=start — full bleed",
    render: () => (
      <div style={{ height: 200 }}>
        <NoChrome>
          <div
            style={{
              padding: 20,
              fontFamily: tokens.font.mono,
              fontSize: 12,
              color: tokens.color.ink2,
            }}
          >
            full-bleed cream canvas, start-aligned
          </div>
        </NoChrome>
      </div>
    ),
  },
  {
    name: "align=center — companion home",
    render: () => (
      <div style={{ height: 300 }}>
        <NoChrome align="center">
          <Creature species="cat" mood="happy" stage="juvenile" cell={8} />
          <div
            style={{
              marginTop: 12,
              fontFamily: tokens.font.display,
              fontSize: 16,
              color: tokens.color.ink,
            }}
          >
            hey there
          </div>
        </NoChrome>
      </div>
    ),
  },
  {
    name: "align=center pad=24 — empty state",
    render: () => (
      <div style={{ height: 280 }}>
        <NoChrome align="center" pad={24}>
          <EmptyPlaceholder
            art={<Creature species="cat" mood="neutral" stage="egg" cell={5} />}
            headline="nothing here yet"
            sub="start a conversation to see activity"
          />
        </NoChrome>
      </div>
    ),
  },
];

export default stories;

// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { tokens } from "../tokens/tokens";
import { AppChrome } from "./AppChrome";

const stories: PreviewStory[] = [
  {
    name: "default (no title/subtitle)",
    render: () => (
      <div style={{ height: 160 }}>
        <AppChrome>
          <div style={{ padding: 16, fontFamily: tokens.font.mono, fontSize: 12 }}>
            screen content here
          </div>
        </AppChrome>
      </div>
    ),
  },
  {
    name: "with title",
    render: () => (
      <div style={{ height: 160 }}>
        <AppChrome title=" / inbox">
          <div style={{ padding: 16, fontFamily: tokens.font.mono, fontSize: 12 }}>
            inbox screen
          </div>
        </AppChrome>
      </div>
    ),
  },
  {
    name: "with title + subtitle",
    render: () => (
      <div style={{ height: 160 }}>
        <AppChrome title=" / stats" subtitle="syncing…">
          <div style={{ padding: 16, fontFamily: tokens.font.mono, fontSize: 12 }}>
            stats screen
          </div>
        </AppChrome>
      </div>
    ),
  },
  {
    name: "moss accent",
    render: () => (
      <div style={{ height: 160 }}>
        <AppChrome accent={tokens.color.moss} subtitle="connected">
          <div style={{ padding: 16, fontFamily: tokens.font.mono, fontSize: 12 }}>
            moss accent variant
          </div>
        </AppChrome>
      </div>
    ),
  },
];

export default stories;

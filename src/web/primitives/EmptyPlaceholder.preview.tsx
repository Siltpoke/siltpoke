// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { tokens } from "../tokens/tokens";
import { EmptyPlaceholder } from "./EmptyPlaceholder";
import { Creature } from "../creature/Creature";

const stories: PreviewStory[] = [
  {
    name: "with Creature art slot",
    render: () => (
      <EmptyPlaceholder
        art={<Creature species="cat" mood="happy" stage="juvenile" cell={4} />}
        headline="nothing wrong rn"
        sub="siltpoke ran tsc · eslint · git diff · ripgrep. 0 findings. suspicious."
        action={
          <button
            style={{
              padding: "6px 12px",
              background: tokens.color.terra,
              color: "#fff",
              border: "none",
              borderRadius: 5,
              cursor: "pointer",
              fontFamily: tokens.font.body,
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            /siltpoke-review · run anyway
          </button>
        }
      />
    ),
  },
  {
    name: "without art slot",
    render: () => (
      <EmptyPlaceholder
        headline="no conversations yet"
        sub="siltpoke speaks via critiques + statusline. talk back when ready."
        action={
          <code
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10.5,
              color: tokens.color.ink,
              background: tokens.color.paper,
              padding: "3px 6px",
              borderRadius: 4,
              border: `1px solid ${tokens.color.edge}`,
            }}
          >
            siltpoke-chat --repl
          </code>
        }
      />
    ),
  },
  {
    name: "with Creature — facts empty",
    render: () => (
      <EmptyPlaceholder
        art={<Creature species="otter" mood="neutral" stage="juvenile" cell={4} />}
        headline="i don't know you yet"
        sub="chat a bit + dismiss a few critiques and siltpoke will start writing facts."
      />
    ),
  },
  {
    name: "no art, no action",
    render: () => (
      <EmptyPlaceholder
        headline="no siltpoke yet"
        sub="your Claude Code is running. install siltpoke to wrap its statusline."
      />
    ),
  },
];

export default stories;

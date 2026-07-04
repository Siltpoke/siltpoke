// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { tokens } from "../tokens/tokens";
import { Wizard } from "./Wizard";
import { EmptyPlaceholder } from "../primitives/EmptyPlaceholder";
import { Creature } from "../creature/Creature";

const stories: PreviewStory[] = [
  {
    name: "step 1 of 4 — prev disabled",
    render: () => (
      <Wizard
        step={1}
        totalSteps={4}
        nextHref="/onboarding/step/2"
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            padding: 16,
          }}
        >
          <div
            style={{
              fontFamily: tokens.font.display,
              fontSize: 16,
              color: tokens.color.ink,
              textAlign: "center",
            }}
          >
            meet your siltpoke
          </div>
          <Creature species="bunny" mood="happy" stage="egg" cell={6} />
        </div>
      </Wizard>
    ),
  },
  {
    name: "step 2 of 4 — mid-flow with empty placeholder",
    render: () => (
      <Wizard
        step={2}
        totalSteps={4}
        prevHref="/onboarding/step/1"
        nextHref="/onboarding/step/3"
      >
        <EmptyPlaceholder
          art={<Creature species="bunny" mood="neutral" stage="juvenile" cell={5} />}
          headline="name your pet"
          sub="pick something memorable"
        />
      </Wizard>
    ),
  },
  {
    name: "step 4 of 4 — next disabled (final)",
    render: () => (
      <Wizard
        step={4}
        totalSteps={4}
        prevHref="/onboarding/step/3"
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            padding: 16,
          }}
        >
          <Creature species="bunny" mood="happy" stage="adult" cell={6} />
          <div
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10.5,
              color: tokens.color.moss,
              textAlign: "center",
            }}
          >
            all done!
          </div>
        </div>
      </Wizard>
    ),
  },
];

export default stories;

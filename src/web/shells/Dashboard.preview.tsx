// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { tokens } from "../tokens/tokens";
import { Dashboard } from "./Dashboard";
import { Creature } from "../creature/Creature";
import { SectionHead } from "../atoms/SectionHead";
import { CANONICAL_NAV } from "../routes/nav";

/**
 * Preview stories migrated to sectioned navSections to keep preview
 * visually aligned with production (Home / Chat / Memory all render the
 * 9-entry sectioned sidebar). One explicit flat-back-compat story is kept
 * at the bottom to exercise the deprecated navItems render path.
 */
const FLAT_NAV_ITEMS = [
  { id: "home" as const, label: "Home", href: "/", icon: "⌂", count: null },
  { id: "memory" as const, label: "Memory", href: "/memory", icon: "◈", count: 14 },
  { id: "chat" as const, label: "Chat", href: "/chat", icon: "◉", count: null },
  { id: "memory" as const, label: "Memory", href: "/memory", icon: "M", count: null },
];

const stories: PreviewStory[] = [
  {
    name: "home active — sectioned nav",
    render: () => (
      <div style={{ height: 400 }}>
        <Dashboard
          title=" / home"
          navSections={CANONICAL_NAV}
          activeSection="home"
        >
          <div
            style={{
              padding: 24,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
            }}
          >
            <SectionHead title="Good afternoon" kicker="HOME" />
            <Creature species="cat" mood="happy" stage="juvenile" cell={8} />
          </div>
        </Dashboard>
      </div>
    ),
  },
  {
    name: "memory active — sectioned nav",
    render: () => (
      <div style={{ height: 400 }}>
        <Dashboard
          title=" / memory"
          subtitle="14 facts"
          accent={tokens.color.moss}
          navSections={CANONICAL_NAV}
          activeSection="memory"
        >
          <div style={{ padding: 24 }}>
            <SectionHead title="Memory" kicker="MEMORY" sub="14 stored facts" />
          </div>
        </Dashboard>
      </div>
    ),
  },
  {
    name: "chat active — sectioned nav",
    render: () => (
      <div style={{ height: 400 }}>
        <Dashboard
          title=" / chat"
          navSections={CANONICAL_NAV}
          activeSection="chat"
        >
          <div style={{ padding: 24 }}>
            <SectionHead title="Chat" kicker="CHAT" />
          </div>
        </Dashboard>
      </div>
    ),
  },
  {
    name: "deprecated flat navItems — back-compat render path",
    render: () => (
      <div style={{ height: 400 }}>
        <Dashboard
          title=" / flat back-compat"
          navItems={FLAT_NAV_ITEMS}
          activeSection="home"
        >
          <div style={{ padding: 24 }}>
            <SectionHead title="Flat nav (deprecated)" kicker="BACK-COMPAT" />
          </div>
        </Dashboard>
      </div>
    ),
  },
];

export default stories;

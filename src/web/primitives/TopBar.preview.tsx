// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { TopBar } from "./TopBar";

const stories: PreviewStory[] = [
  {
    name: "default — 3 badges + profile",
    render: () => (
      <div style={{ padding: 0 }}>
        <TopBar
          brand="siltpoke"
          petName="Bangbang"
          petMeta="L3 · cat"
          badges={[
            { id: "well-fed", label: "well-fed", tone: "good" },
            { id: "dressed", label: "since dressed", value: "22 hrs", tone: "neutral" },
            { id: "today", label: "today", value: "3 new", tone: "good" },
          ]}
          profile={{ initials: "AB", name: "Alex" }}
        />
      </div>
    ),
  },
  {
    name: "warning tone badge (hunger)",
    render: () => (
      <div style={{ padding: 0 }}>
        <TopBar
          brand="siltpoke"
          petName="Bangbang"
          petMeta="L3 · cat"
          badges={[
            { id: "hungry", label: "hungry", value: "8h", tone: "warn" },
            { id: "today", label: "today", value: "3 new", tone: "good" },
          ]}
          profile={{ initials: "AB" }}
        />
      </div>
    ),
  },
  {
    name: "no profile chip",
    render: () => (
      <div style={{ padding: 0 }}>
        <TopBar
          brand="siltpoke"
          petName="Bangbang"
          petMeta="L3 · cat"
          badges={[{ id: "well-fed", label: "well-fed", tone: "good" }]}
        />
      </div>
    ),
  },
  {
    name: "minimal — 0 badges no profile",
    render: () => (
      <div style={{ padding: 0 }}>
        <TopBar brand="siltpoke" petName="Bangbang" petMeta="L3" badges={[]} />
      </div>
    ),
  },
];

export default stories;

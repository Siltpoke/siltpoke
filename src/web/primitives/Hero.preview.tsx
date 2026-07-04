// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { Hero } from "./Hero";

const stories: PreviewStory[] = [
  {
    name: "happy cat",
    render: () => (
      <Hero
        pet={{ name: "siltpoke", species: "cat", mood: "happy", level: 3 }}
        progression={{ xp: 60, xp_to_next: 100 }}
      />
    ),
  },
  {
    name: "neutral slime",
    render: () => (
      <Hero
        pet={{ name: "siltpoke", species: "slime", mood: "neutral", level: 1 }}
        progression={{ xp: 0, xp_to_next: 100 }}
      />
    ),
  },
  {
    name: "sad bunny",
    render: () => (
      <Hero
        pet={{ name: "siltpoke", species: "bunny", mood: "sad", level: 7 }}
        progression={{ xp: 120, xp_to_next: 250 }}
      />
    ),
  },
  {
    name: "sleepy robot",
    render: () => (
      <Hero
        pet={{ name: "siltpoke", species: "robot", mood: "sleepy", level: 10 }}
        progression={{ xp: 900, xp_to_next: 1000 }}
      />
    ),
  },
  {
    name: "no progression",
    render: () => (
      <Hero
        pet={{ name: "siltpoke", species: "otter", mood: "neutral", level: 2 }}
      />
    ),
  },
];

export default stories;

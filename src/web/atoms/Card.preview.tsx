// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { Card } from "./Card";

const stories: PreviewStory[] = [
  {
    name: "default",
    render: () => <Card>Hello from Card</Card>,
  },
  {
    name: "custom padding",
    render: () => <Card pad={32}>Extra padded card content</Card>,
  },
  {
    name: "nested content",
    render: () => (
      <Card>
        <strong>Title</strong>
        <p>Body paragraph inside card.</p>
      </Card>
    ),
  },
  {
    name: "style override",
    render: () => (
      <Card style={{ maxWidth: 240 }}>Constrained width card</Card>
    ),
  },
];

export default stories;

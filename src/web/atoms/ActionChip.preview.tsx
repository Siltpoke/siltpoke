// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { ActionChip } from "./ActionChip";

const stories: PreviewStory[] = [
  {
    name: "feed",
    render: () => <ActionChip action="feed" label="feed" icon="🍖" />,
  },
  {
    name: "play",
    render: () => <ActionChip action="play" label="play" icon="🎾" />,
  },
  {
    name: "pet",
    render: () => <ActionChip action="pet" label="pet" icon="✋" />,
  },
  {
    name: "no icon",
    render: () => <ActionChip action="feed" label="feed" />,
  },
];

export default stories;

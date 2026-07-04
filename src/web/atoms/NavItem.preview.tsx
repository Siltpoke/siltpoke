// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { NavItem } from "./NavItem";

const stories: PreviewStory[] = [
  {
    name: "inactive",
    render: () => <NavItem icon="✉" label="Inbox" />,
  },
  {
    name: "active",
    render: () => <NavItem icon="✉" label="Inbox" active={true} />,
  },
  {
    name: "inactive with count",
    render: () => <NavItem icon="⚡" label="Events" count={42} />,
  },
  {
    name: "active with count",
    render: () => <NavItem icon="⚡" label="Events" active={true} count={7} />,
  },
  {
    name: "disabled",
    render: () => <NavItem icon="⚙" label="Disabled example" disabled={true} href="/nowhere" />,
  },
];

export default stories;

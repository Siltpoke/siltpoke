// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { Critique } from "../../primitives/CritiqueInbox";

/**
 * MOCK_CRITIQUES — 3 sample critique entries matching Design C mockup.
 *
 * Home screen uses these as stubs; no real critique source (critic output
 * → stored critique entries) is wired yet.
 */
export const MOCK_CRITIQUES: Critique[] = [
  {
    id: "crit-001",
    tag: "bug",
    text: "missing await on db query",
    file: "src/critic.tsx",
    line: 88,
    ts: "2026-05-18T10:00:00Z",
  },
  {
    id: "crit-002",
    tag: "style",
    text: "name reads like a function but returns a class",
    file: "src/critic.tsx",
    line: 42,
    ts: "2026-05-18T09:30:00Z",
  },
  {
    id: "crit-003",
    tag: "lint",
    text: "this lint disable is masking a real Number...",
    file: "shared/memory.ts",
    line: 120,
    ts: "2026-05-18T08:45:00Z",
  },
];

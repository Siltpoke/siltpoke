// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * CANONICAL_NAV — single source of truth for top-level navigation entries,
 * organised into two display sections (PET and WORK).
 *
 * Two display sections (PET and WORK); every entry is a live route.
 * All screens import from here instead of assembling their own navItems arrays.
 * Active state is derived at render time (compare entry.id to activeSection).
 */
import type { Section } from "../client/stores/navState";

export interface NavEntry {
  id: Section;
  label: string;
  href: string;
  /**
   * Icon glyph or emoji string rendered inside the NavItem icon span.
   * A dedicated icon component system will replace these plain strings later.
   */
  icon?: string;
  /**
   * Optional badge count shown next to the label (e.g. unread memory count).
   * Passed straight through to the NavItem atom.
   */
  count?: number | null;
  /**
   * When true, the entry is rendered as a non-interactive <span aria-disabled>.
   * Use for routes that exist in the nav schema but aren't implemented yet.
   * stats / inventory / friends / critic / commands / settings are currently disabled.
   */
  disabled?: boolean;
  /**
   * Optional trailing meta string (e.g. "today" / "7d" / "1.3k facts").
   * Rendered as right-aligned ink3 11px mono text on NavItem.
   * Distinct from the count badge (no pill background).
   */
  meta?: string;
}

export interface NavSection {
  id: "pet" | "work";
  label: string;
  entries: readonly NavEntry[];
}

/**
 * Icons are string glyph ids resolved by the Icon atom.
 *
 * Sectioned shape: 2 sections (PET / WORK); every entry is an active route.
 * Chat has no nav tab — the floating chat replaces the standalone /chat
 * surface. History + Traces merged into the single Timeline entry.
 */
/**
 * CANONICAL_NAV — static shape. No hardcoded meta counts.
 *
 * Live meta (facts count) is injected at render time via
 * Dashboard's navMetaOverrides prop. Home.tsx derives these from real memory
 * data on every render. CANONICAL_NAV itself stays free of fake numbers so a
 * stale static value never appears as real data.
 *
 * "today" on home is literal — it always means today, not a count.
 */
export const CANONICAL_NAV: readonly NavSection[] = [
  {
    id: "pet",
    label: "PET",
    entries: [
      { id: "home", label: "Home", href: "/", icon: "home", meta: "today" },
    ],
  },
  {
    id: "work",
    label: "WORK",
    entries: [
      // ONE Timeline entry replaces the History + Traces pair at the same
      // WORK position — /history and /traces are redirects now. Icon reuses
      // the "history" clock glyph (a clock reads naturally as "timeline";
      // keeps Icon.tsx untouched).
      { id: "timeline", label: "Timeline", href: "/timeline", icon: "history" },
      { id: "memory", label: "Memory", href: "/memory", icon: "memory" },
      { id: "repo-graph", label: "Repo Graph", href: "/repo-graph", icon: "repo-graph" },
    ],
  },
];

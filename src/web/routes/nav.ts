// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
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
      // "Quests" removed 2026-08-06 with the route's unmount (src/daemon/server.ts) —
      // the board's data file was deliberately frozen ~2026-07-12 and the page was
      // rendering month-old state. Screen + route + tests are all still in the tree.
      // ONE Timeline entry replaces the History + Traces pair at the same
      // WORK position — /history and /traces are redirects now. Icon reuses
      // the "history" clock glyph (a clock reads naturally as "timeline";
      // keeps Icon.tsx untouched).
      { id: "timeline", label: "Timeline", href: "/timeline", icon: "history" },
      { id: "memory", label: "Memory", href: "/memory", icon: "memory" },
      { id: "repo-graph", label: "Code Map", href: "/repo-graph", icon: "repo-graph" },
      // Derived from docs/ROADMAP.md on every request — never a second copy of
      // project state.
      //
      // Icon was `history`, the SAME glyph Timeline uses three rows above —
      // two sidebar entries drawn identically, which is how the maintainer found it
      // (2026-08-17): "the progress page has the icon that is the same as the
      // timeline". Second instance of this shape on this sidebar; Knowledge and
      // Memory shared `memory` until `ab204827`.
      //
      // `a retired surface` is the pennant flag already defined in `Icon.tsx` and used by
      // nothing — it was drawn for the retired a retired board (#493). This
      // page renders a a retired map, so the glyph is a fit rather than a spare.
      // Knowledge base wiki page (Task 12) — reuses the "memory" glyph
      // rather than adding a new Icon.tsx entry (brief's own instruction).
      // The Decisions-log view used to sit here as its own entry pointing at
      // /knowledge/decisions. That page was retired 2026-08-17 (Decisions log):
      // the view is now a right-side sheet on /knowledge itself, reached from a
      // header control rather than the nav, so a nav entry would name a route
      // that no longer exists.
      // The open book, not the database cylinder `/memory` wears: the two rows
      // used to draw the same picture, which is a nav you cannot read at a
      // glance. Memory keeps the cylinder because it IS a store; Knowledge is
      // a shelf of documents (2026-08-17).
      // "Settings" removed 2026-08-06 with its route's unmount (src/daemon/server.ts).
    ],
  },
];

/**
 * Which nav entries this install actually has.
 *
 * Set ONCE, by the daemon, at mount time — a per-request set would race
 * between concurrent requests, and this is a fact about the repo rather than
 * about a request. The cost is stated rather than hidden: create a `ROADMAP.md`
 * mid-session and the sidebar entry appears after the next daemon restart. The
 * `/progress` route itself re-checks per request, so the PAGE is never stale;
 * only its shortcut is.
 *
 * Entries absent from this map are available — a new nav entry is visible
 * unless something deliberately says otherwise.
 */
const unavailable = new Set<Section>();

export function setNavAvailability(flags: Partial<Record<Section, boolean>>): void {
  for (const [id, ok] of Object.entries(flags) as [Section, boolean][]) {
    if (ok) unavailable.delete(id);
    else unavailable.add(id);
  }
}

export function availableNavSections(
  sections: readonly NavSection[] = CANONICAL_NAV,
): readonly NavSection[] {
  if (unavailable.size === 0) return sections;
  return sections
    .map((s) => ({ ...s, entries: s.entries.filter((e) => !unavailable.has(e.id)) }))
    .filter((s) => s.entries.length > 0);
}

/**
 * TEST-ONLY. `unavailable` above is a bare module-level mutable global with
 * no reset contract — correct for a real daemon (one process, one boot,
 * nothing else ever shares the module), wrong for `bun test`, which runs the
 * WHOLE suite in one process sharing this exact singleton. Any test that
 * calls `startDaemon()` mutates it (`src/daemon/server.ts` calls
 * `setNavAvailability` once per boot); without a reset, whichever such test
 * runs LAST leaves its flags in place for every unrelated Dashboard-rendering
 * test that runs afterward — this is not hypothetical, it broke
 * `Home.test.tsx` and `Critic.golden.test.tsx` on a full-suite run before
 * this export existed. Call this from the `afterEach` of any test that boots
 * a daemon (directly or via a mount that reaches `setNavAvailability`), not
 * from production shutdown code — a real daemon process exiting needs no
 * cleanup here, and folding this into `stopDaemon` was the original (wrong)
 * fix: it gave the reset zero production purpose and no defense against a
 * test that crashes before its own teardown runs.
 */
export function resetNavAvailability(): void {
  unavailable.clear();
}

// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * navState — nanostore for sidebar collapsed state + active section.
 *
 * Uses `atom` (whole-object reads) — sections are always read together
 * when deciding what to render in the nav chrome.
 */
import { atom } from "nanostores";

/**
 * Sections the dashboard / shells will bind to. Typed union (not `string`)
 * so call sites get autocomplete + compile errors on typos — adding a new
 * section is intentionally a single-place edit here.
 *
 * Widened from 4 active entries to the full nav schema ids.
 * "chat" stays a valid Section (the /chat route + Chat screen still render with
 * activeSection="chat"), but it has no sidebar nav tab — the floating chat
 * replaces the standalone surface. Disabled ids are placeholders for future additions.
 *
 * "timeline" added (the merged /history + /traces
 * page, the only one of the three with a nav tab). "history" and "traces"
 * REMAIN valid Sections without nav tabs (same precedent as "chat"): the
 * /critique/:id permalink renders with activeSection="history" and the
 * standalone /traces/:trace_id span explorer with activeSection="traces" —
 * both pages survive the merge, they just lost their sidebar entries.
 */
export type Section = "home" | "history" | "memory" | "chat" | "traces" | "timeline" | "rubric" | "preference-log" | "few-shot" | "repo-memory" | "explain" | "repo-graph";

export interface NavState {
  sidebarCollapsed: boolean;
  activeSection: Section;
}

const DEFAULT_NAV: NavState = {
  sidebarCollapsed: false,
  activeSection: "home",
};

/** Writable atom holding navigation UI state. */
export const $nav = atom<NavState>(DEFAULT_NAV);

/**
 * Toggle the sidebar between collapsed and expanded.
 * Shallow-merge keeps `activeSection` unchanged.
 */
export function toggleSidebar(): void {
  const s = $nav.get();
  $nav.set({ ...s, sidebarCollapsed: !s.sidebarCollapsed });
}

/**
 * Set the currently active nav section.
 * Shallow-merge keeps `sidebarCollapsed` unchanged.
 */
export function setActiveSection(section: Section): void {
  $nav.set({ ...$nav.get(), activeSection: section });
}

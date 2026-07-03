// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * sidebar — collapsible left nav state, bridged from $nav nanostore.
 *
 * Usage: <aside x-data="sidebar">...</aside>
 *
 * Reactivity model: Alpine's Proxy effect-tracker only sees reads of
 * properties on the component's own data object — it can't intercept a
 * call to $nav.get(). So we subscribe in init() and copy the value into
 * the local reactive property `_collapsed`; the getter returns that. Any
 * external producer (keyboard shortcut, HTMX swap, test) that mutates
 * $nav fires the subscription, which writes _collapsed, which Alpine
 * sees and re-evaluates every binding that reads `collapsed`.
 */
import { $nav, toggleSidebar } from "../stores/navState";

// Hydrate $nav from localStorage so the toggle
// button text + Alpine bindings match what the pre-Alpine CSS already
// rendered (sidebar-collapsed-init class on <html> driven by localStorage
// in layout.tsx). Without this seed, $nav defaults to false → Alpine
// thinks expanded → toggle button shows '‹ collapse' even though the
// CSS already collapsed the sidebar visually.
function hydrateFromLocalStorage(): void {
  try {
    const persisted = localStorage.getItem("siltpokeSidebarCollapsed");
    if (persisted === "1" && !$nav.get().sidebarCollapsed) {
      $nav.set({ ...$nav.get(), sidebarCollapsed: true });
    } else if (persisted === "0" && $nav.get().sidebarCollapsed) {
      $nav.set({ ...$nav.get(), sidebarCollapsed: false });
    }
  } catch {
    // localStorage unavailable — fall back to default (expanded).
  }
}
hydrateFromLocalStorage();

document.addEventListener("alpine:init", () => {
  globalThis.Alpine.data("sidebar", () => ({
    _collapsed: false,
    _unsub: null as null | (() => void),
    init() {
      this._collapsed = $nav.get().sidebarCollapsed;
      this._unsub = $nav.subscribe((nav) => {
        this._collapsed = nav.sidebarCollapsed;
      });
    },
    destroy() {
      this._unsub?.();
      this._unsub = null;
    },
    get collapsed(): boolean {
      return this._collapsed;
    },
    toggle() {
      toggleSidebar();
      // Persist collapse state for pre-Alpine SSR
      // hydration (layout.tsx <head> script reads this on next page load to
      // apply .sidebar-collapsed-init class before first paint — no FOUC).
      try {
        const next = $nav.get().sidebarCollapsed;
        localStorage.setItem(
          "siltpokeSidebarCollapsed",
          next ? "1" : "0",
        );
        document.documentElement.classList.toggle(
          "sidebar-collapsed-init",
          next,
        );
      } catch {
        // localStorage unavailable (private mode etc.) — fail silent;
        // user just sees FOUC on next load, no functional impact.
      }
    },
  }));
});

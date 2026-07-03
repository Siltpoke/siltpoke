/**
 * Pure store tests for navState — no DOM required.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  $nav,
  toggleSidebar,
  setActiveSection,
} from "../../../../src/web/client/stores/navState";
import type { NavState } from "../../../../src/web/client/stores/navState";

const DEFAULT_NAV: NavState = {
  sidebarCollapsed: false,
  activeSection: "home",
};

beforeEach(() => {
  // Reset the atom to its initial value before each test.
  // cleanStores() only clears listeners — we must reset the value explicitly.
  $nav.set({ ...DEFAULT_NAV });
});

describe("$nav default state", () => {
  it("returns default nav on first get()", () => {
    const nav = $nav.get();
    expect(nav.sidebarCollapsed).toBe(false);
    expect(nav.activeSection).toBe("home");
  });
});

describe("toggleSidebar", () => {
  it("flips sidebarCollapsed from false to true", () => {
    toggleSidebar();
    expect($nav.get().sidebarCollapsed).toBe(true);
  });

  it("flips sidebarCollapsed back to false on second call", () => {
    toggleSidebar();
    toggleSidebar();
    expect($nav.get().sidebarCollapsed).toBe(false);
  });

  it("preserves activeSection when toggling", () => {
    setActiveSection("memory");
    toggleSidebar();
    expect($nav.get().activeSection).toBe("memory");
  });
});

describe("setActiveSection", () => {
  it("updates activeSection", () => {
    setActiveSection("memory");
    expect($nav.get().activeSection).toBe("memory");
  });

  it("preserves sidebarCollapsed when updating section", () => {
    toggleSidebar(); // set to true
    setActiveSection("repo-graph");
    expect($nav.get().sidebarCollapsed).toBe(true);
    expect($nav.get().activeSection).toBe("repo-graph");
  });
});

describe("subscribe", () => {
  it("fires callback when state changes", () => {
    const sections: string[] = [];
    const unsub = $nav.subscribe((nav) => {
      sections.push(nav.activeSection);
    });
    try {
      setActiveSection("memory");
      expect(sections).toContain("memory");
    } finally {
      // Always clean up the listener — nanostores' subscribe leaks across
      // test boundaries (beforeEach resets the VALUE but not the listener
      // list). Without this, prior-test subscribers continue firing.
      unsub();
    }
  });

  it("returns an unsubscribe function that stops further callbacks", () => {
    const calls: boolean[] = [];
    const unsub = $nav.subscribe((nav) => {
      calls.push(nav.sidebarCollapsed);
    });
    // Subscribe fires synchronously once with the current value.
    expect(calls.length).toBe(1);
    unsub();
    toggleSidebar();
    expect(calls.length).toBe(1);
  });
});

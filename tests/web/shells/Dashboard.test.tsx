/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { Dashboard } from "../../../src/web/shells/Dashboard";
import { tokens } from "../../../src/web/tokens/tokens";
import { CANONICAL_NAV } from "../../../src/web/routes/nav";
import type { NavSection } from "../../../src/web/routes/nav";

const NAV_ITEMS = [
  { id: "home" as const, label: "Home", href: "/", icon: "⌂", count: null },
  { id: "memory" as const, label: "Memory", href: "/memory", icon: "◈", count: 14 },
  { id: "chat" as const, label: "Chat", href: "/chat", icon: "◉", count: null },
  { id: "repo-graph" as const, label: "Repo Graph", href: "/repo-graph", icon: "R", count: null },
];

describe("Dashboard", () => {
  test("renders AppChrome outer wrapper (cream background)", () => {
    const html = String(
      <Dashboard navItems={NAV_ITEMS} activeSection="home">
        content
      </Dashboard>,
    );
    expect(html).toContain(tokens.color.cream);
    // Wave 1.5b: AppChrome trademark "siltpoked" bar dropped — sidebar
    // footer now renders the daemon identity instead.
    // Was `toContain("daemon")`, standing in for "the footer rendered".
    // That line is gone (a hardcoded port beside an always-green dot),
    // so anchor on the footer itself — the thing the test is about.
    expect(html).toContain("sidebar-footer");
  });

  test("renders all nav item labels", () => {
    const html = String(
      <Dashboard navItems={NAV_ITEMS} activeSection="home">
        content
      </Dashboard>,
    );
    expect(html).toContain("Home");
    expect(html).toContain("Memory");
    expect(html).toContain("Chat");
    expect(html).toContain("Repo Graph");
  });

  test("active nav item uses paperD background", () => {
    const html = String(
      <Dashboard navItems={NAV_ITEMS} activeSection="memory">
        content
      </Dashboard>,
    );
    expect(html).toContain(tokens.color.paperD);
  });

  test("sidebar uses paper background and edge border", () => {
    const html = String(
      <Dashboard navItems={NAV_ITEMS} activeSection="home">
        content
      </Dashboard>,
    );
    expect(html).toContain(tokens.color.paper);
    expect(html).toContain(tokens.color.edge);
  });

  test("Alpine x-data sidebar attribute present on aside", () => {
    const html = String(
      <Dashboard navItems={NAV_ITEMS} activeSection="home">
        content
      </Dashboard>,
    );
    expect(html).toContain('x-data="sidebar"');
  });

  test("renders children in main content area", () => {
    const html = String(
      <Dashboard navItems={NAV_ITEMS} activeSection="home">
        <span id="screen-content">hello world</span>
      </Dashboard>,
    );
    expect(html).toContain('id="screen-content"');
    expect(html).toContain("hello world");
  });

  test("title prop accepted for back-compat (no longer rendered)", () => {
    // Wave 1.5b: AppChrome no longer renders the title in a top bar.
    // Dashboard still accepts the prop for back-compat — does not throw.
    const html = String(
      <Dashboard navItems={NAV_ITEMS} activeSection="home" title=" / home">
        content
      </Dashboard>,
    );
    expect(html).toContain("content");
  });

  test("renders count badge on nav item", () => {
    const html = String(
      <Dashboard navItems={NAV_ITEMS} activeSection="home">
        content
      </Dashboard>,
    );
    expect(html).toContain("14");
  });

  test("sidebar re-renders per nav so activeSection highlight follows route", () => {
    // hx-preserve was REMOVED so each nav re-renders
    // the sidebar with the correct SSR-time activeSection highlight. Alpine
    // re-attaches via x-data="sidebar"; collapsed state lives in the $nav
    // nanostore (not the DOM), so destroying the sidebar element on each nav
    // does not lose collapse state. Test pins both the absence (regression
    // guard) and the per-screen highlight contract.
    const homeHtml = String(
      <Dashboard navItems={NAV_ITEMS} activeSection="home">
        content
      </Dashboard>,
    );
    const memHtml = String(
      <Dashboard navItems={NAV_ITEMS} activeSection="memory">
        content
      </Dashboard>,
    );
    expect(homeHtml).not.toContain('hx-preserve="true"');
    expect(memHtml).not.toContain('hx-preserve="true"');
    // Highlight must differ between the two SSR outputs (activeSection drives it)
    expect(homeHtml).not.toBe(memHtml);
  });

  test("nav labels carry x-show=!collapsed so they hide on collapse", () => {
    // Smoke F-S5: NavItem labels + count badges must hide when the
    // sidebar collapses; the icon-only column is what the user wants
    // to keep at the 52px width. Without these attributes, labels
    // truncate visually instead of disappearing.
    const html = String(
      <Dashboard navItems={NAV_ITEMS} activeSection="home">
        content
      </Dashboard>,
    );
    expect(html).toContain('x-show="!collapsed"');
  });

  test("renders without crashing when navItems is empty", () => {
    // Wave 1 onboarding routes may render Dashboard before the nav array
    // is constructed — a regression here would render nothing AND throw.
    const html = String(
      <Dashboard navItems={[]} activeSection="home">
        content
      </Dashboard>,
    );
    expect(html).toContain("content");
    expect(html).toContain('x-data="sidebar"');
  });

  // CANONICAL_NAV default wiring
  test("uses CANONICAL_NAV by default when navItems not provided", () => {
    // Dashboard must default to CANONICAL_NAV when navItems is omitted.
    // Callers no longer need to pass navItems.
    const html = String(
      <Dashboard activeSection="home">
        content
      </Dashboard>,
    );
    // Canonical labels should appear (Chat removed — floating chat replaces it)
    expect(html).toContain("Home");
    expect(html).toContain("Memory");
    expect(html).toContain("Code Map");
  });

  test("caller-supplied navItems prop overrides CANONICAL_NAV", () => {
    // Existing tests + previews pass custom navItems — must still work.
    const custom = [{ id: "home" as const, label: "Custom Home", href: "/", icon: "X", count: null }];
    const html = String(
      <Dashboard navItems={custom} activeSection="home">
        content
      </Dashboard>,
    );
    expect(html).toContain("Custom Home");
    // Canonical-only labels must NOT appear when overriding (Memory + Repo Graph
    // are CANONICAL_NAV entries — load-bearing guards that override suppresses them)
    expect(html).not.toContain("Memory");
    expect(html).not.toContain("Code Map");
  });
});

// sectioned navSections render path
describe("Dashboard sectioned navSections render", () => {
  test("renders 2 section labels: PET and WORK", () => {
    const html = String(
      <Dashboard navSections={CANONICAL_NAV} activeSection="home">
        content
      </Dashboard>,
    );
    expect(html).toContain("PET");
    expect(html).toContain("WORK");
  });

  test("renders all NavItems total (one per entry across both sections; /stats + chat removed; History+Traces merged into Timeline)", () => {
    const html = String(
      <Dashboard navSections={CANONICAL_NAV} activeSection="home">
        content
      </Dashboard>,
    );
    const allLabels = ["Home", "Timeline", "Memory", "Code Map"];
    for (const label of allLabels) {
      expect(html).toContain(label);
    }
  });

  test("PET section contains home only (placeholders removed 2026-07-02)", () => {
    const html = String(
      <Dashboard navSections={CANONICAL_NAV} activeSection="home">
        content
      </Dashboard>,
    );
    expect(html).toContain("Home");
    for (const gone of ["Inventory", "Friends"]) {
      expect(html).not.toContain(gone);
    }
  });

  test("WORK section contains timeline / memory / repo-graph labels in output", () => {
    const html = String(
      <Dashboard navSections={CANONICAL_NAV} activeSection="home">
        content
      </Dashboard>,
    );
    const workLabels = ["Timeline", "Memory", "Code Map"];
    for (const label of workLabels) {
      expect(html).toContain(label);
    }
    // "Quests" joins the removed set 2026-08-06 — the route is unmounted, so a nav link
    // to it would be a 404 the user finds rather than a page.
    for (const gone of ["Commands", "Help", "Quests", "Settings"]) {
      expect(html).not.toContain(gone);
    }
  });

  test("no entry renders as disabled (placeholders removed, all routes live)", () => {
    const html = String(
      <Dashboard navSections={CANONICAL_NAV} activeSection="home">
        content
      </Dashboard>,
    );
    expect(html.match(/aria-disabled="true"/g)).toBeNull();
  });

  test("memory entry is highlighted when activeSection=memory", () => {
    const homeHtml = String(
      <Dashboard navSections={CANONICAL_NAV} activeSection="home">
        content
      </Dashboard>,
    );
    const memHtml = String(
      <Dashboard navSections={CANONICAL_NAV} activeSection="memory">
        content
      </Dashboard>,
    );
    // The two renders must differ (active highlight differs)
    expect(homeHtml).not.toBe(memHtml);
    // Memory render has the active (paperD) background — check the hex value
    expect(memHtml).toContain(tokens.color.paperD);
  });

  test("default (neither navSections nor navItems) renders sectioned path with CANONICAL_NAV", () => {
    const html = String(
      <Dashboard activeSection="home">
        content
      </Dashboard>,
    );
    // Both section labels must appear — confirms sectioned render, not flat
    expect(html).toContain("PET");
    expect(html).toContain("WORK");
    // All entry labels present (/stats removed; chat removed — floating
    // chat replaces it; History+Traces merged into Timeline)
    const allLabels = ["Home", "Timeline", "Memory", "Code Map"];
    for (const label of allLabels) {
      expect(html).toContain(label);
    }
    // The default path must not resurrect an unmounted route either.
    expect(html).not.toContain("Quests");
    expect(html).not.toContain("Settings");
  });

  test("section labels carry x-show='!collapsed' for Alpine collapsed-sidebar hide", () => {
    const html = String(
      <Dashboard navSections={CANONICAL_NAV} activeSection="home">
        content
      </Dashboard>,
    );
    // SectionLabel renders x-show attribute on the label div
    expect(html).toContain('x-show="!collapsed"');
  });

  test("navSections prop takes priority over navItems when both provided", () => {
    const customFlat = [{ id: "home" as const, label: "Flat Home", href: "/", icon: "X", count: null }];
    const html = String(
      <Dashboard navSections={CANONICAL_NAV} navItems={customFlat} activeSection="home">
        content
      </Dashboard>,
    );
    // navSections wins: canonical labels appear, not custom flat label
    expect(html).toContain("PET");
    expect(html).toContain("WORK");
    // Flat-only label must NOT appear (navSections takes priority)
    expect(html).not.toContain("Flat Home");
  });

  test("custom NavSection array renders correct section ids and entries", () => {
    const customSections: readonly NavSection[] = [
      {
        id: "pet",
        label: "MYPET",
        entries: [{ id: "home", label: "HomeCustom", href: "/" }],
      },
    ];
    const html = String(
      <Dashboard navSections={customSections} activeSection="home">
        content
      </Dashboard>,
    );
    expect(html).toContain("MYPET");
    expect(html).toContain("HomeCustom");
    expect(html).not.toContain("WORK");
  });
});

describe("Dashboard — build-stamp footer row", () => {
  /**
   * The island can only ever run if the shell actually emits its mount point,
   * and the mount point only reaches the reader if it sits outside the
   * two-column footer flex (a third child there displaces the theme toggle).
   * Both are asserted structurally, because neither is visible to the island's
   * own unit tests: those drive a hand-built `$el` and would pass against a
   * shell that renders nothing at all.
   */
  function shellHtml(): string {
    return String(
      <Dashboard navItems={NAV_ITEMS} activeSection="home">
        content
      </Dashboard>,
    );
  }

  test("mounts the buildStamp island with the endpoint it reads", () => {
    const html = shellHtml();
    expect(html).toContain('x-data="buildStamp"');
    expect(html).toContain('data-build-url="/api/version"');
  });

  test("is its own row, not a third child of the two-column footer flex", () => {
    const html = shellHtml();
    const footer = html.indexOf('class="sidebar-footer"');
    const themeToggle = html.indexOf("data-theme-toggle");
    const buildRow = html.indexOf("data-build-stamp");
    expect(footer).toBeGreaterThan(-1);
    expect(themeToggle).toBeGreaterThan(-1);
    // Ordering IS the check: the build row must come after the theme toggle,
    // i.e. after the footer flex has closed, never between its two children.
    expect(buildRow).toBeGreaterThan(themeToggle);
  });

  test("ships hidden — nothing is claimed until /api/version answers", () => {
    const html = shellHtml();
    const row = html.slice(html.indexOf("data-build-stamp"), html.indexOf("data-build-stamp") + 500);
    expect(row).toContain("display:none");
    expect(row).toContain("ready");
  });
});

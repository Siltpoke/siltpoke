/** @jsxImportSource hono/jsx */
/**
 * Home.test.tsx — Wave 1.5b full-composition snapshot pin.
 *
 * Builds a minimal HomeData fixture, renders <Home data={fixture} /> to string,
 * and asserts the expected regions are present. TopBar is NOT mounted by the
 * Home component (dropped in Wave 1.5b — brand + pet meta live in sidebar chip
 * and Home content header).
 *
 * Real-data wiring: fixture uses null stats / [] vitals / []
 *   critiques / navMeta. MOCK_CRITIQUES only in preview stories.
 */
import { test, expect, describe } from "bun:test";
import { Home } from "../../../src/web/screens/Home";
import type { HomeData } from "../../../src/web/screens/Home";
import { HOME_RENDER_FIXTURE } from "./_home-render-fixture";

// ── Fixture ────────────────────────────────────────────────────────────────────
// Uses real-data shapes: stats=null, vitals=[], critiques=[], navMeta real.
// For visual preview stories with MOCK_CRITIQUES / full vitals, see:
//   src/web/screens/*.preview.tsx

const FIXTURE: HomeData = HOME_RENDER_FIXTURE;

// ── Render helper ──────────────────────────────────────────────────────────────

function render(): string {
  return String(<Home data={FIXTURE} />);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Home screen Wave 1.5b composition", () => {
  // Region 1: Dashboard sidebar with PET + WORK section labels
  test("Dashboard sidebar renders with PET section label", () => {
    const html = render();
    expect(html).toContain("PET");
  });

  test("Dashboard sidebar renders with WORK section label", () => {
    const html = render();
    expect(html).toContain("WORK");
  });

  test("Dashboard sidebar data-sidebar attribute present", () => {
    const html = render();
    expect(html).toContain("data-sidebar");
  });

  // Sidebar brand chip
  test("Sidebar brand chip renders siltpoke text", () => {
    const html = render();
    expect(html).toContain("siltpoke");
    expect(html).toContain("sidebar-brand");
  });

  test("Sidebar brand chip renders L12 level pill from real progression.level", () => {
    // Fixture passes level=12 → Dashboard renders L12 pill (not hardcoded).
    const html = render();
    expect(html).toContain("L12");
  });

  test("Sidebar daemon footer is present", () => {
    const html = render();
    expect(html).toContain("daemon");
    expect(html).toContain(":9876");
    expect(html).toContain("sidebar-footer");
  });

  // Region 2: HomeCenter (replaces Hero)
  test("HomeCenter renders <section id='hero'> for HTMX swap compat", () => {
    const html = render();
    expect(html).toContain('id="hero"');
  });

  test("HomeCenter renders home-center class", () => {
    const html = render();
    expect(html).toContain("home-center");
  });

  test("HomeCenter contains action chips (feed / play / clean / pet — no sleep)", () => {
    const html = render();
    expect(html).toContain('data-action="feed"');
    expect(html).toContain('data-action="play"');
    expect(html).toContain('data-action="clean"');
    expect(html).toContain('data-action="pet"');
  });

  test("HomeCenter renders sleep + tease chips (dashboard parity)", () => {
    const html = render();
    expect(html).toContain('data-action="sleep"');
    expect(html).toContain('data-action="tease"');
  });

  test("HomeCenter action chips have keyCap pills (F / P / C / E)", () => {
    const html = render();
    expect(html).toContain(">F<");
    expect(html).toContain(">P<");
    expect(html).toContain(">C<");
    expect(html).toContain(">E<");
  });

  test("HomeCenter renders status pills (awake · mood, last poke ·)", () => {
    const html = render();
    expect(html).toContain("awake ·");
    expect(html).toContain("last poke ·");
  });

  test("HomeCenter ViewToggle dropped", () => {
    const html = render();
    expect(html).not.toContain("view-toggle");
  });

  test("HomeCenter renders greeting 'hi.'", () => {
    const html = render();
    expect(html).toContain("hi.");
  });

  test("HomeCenter renders creature component", () => {
    const html = render();
    // Creature renders as <pre> element inside home-center
    expect(html).toContain("<pre");
  });

  // Region 3: HOME header (Design D)
  test("HOME header renders kicker label", () => {
    const html = render();
    expect(html).toContain("HOME");
  });

  test("HOME header renders pet name as h1", () => {
    const html = render();
    expect(html).toContain("<h1");
    expect(html).toContain("Bangbang");
  });

  test("HOME header shows well-fed pill when hunger > 4 (fixture hunger=5)", () => {
    const html = render();
    expect(html).toContain("well-fed");
  });

  test("HOME header hides well-fed pill when hunger <= 4", () => {
    const lowHunger = String(
      <Home data={{ ...FIXTURE, stats: { ...FIXTURE.stats, hunger: 4 } }} />,
    );
    expect(lowHunger).not.toContain("well-fed");
  });

  test("HOME · today kicker (Design D)", () => {
    const html = render();
    expect(html).toContain("HOME · today");
  });

  test("HOME header renders new subtitle: petTitle · level · since · together", () => {
    const html = render();
    // petTitle from fixture is "marshlump"
    expect(html).toContain("marshlump");
    expect(html).toContain("L12");
    expect(html).toContain("together");
  });

  // Region 4: StatsPanel — stats is always real (non-null)
  test("StatsPanel renders STATS header", () => {
    const html = render();
    expect(html).toContain("STATS");
    expect(html).toContain("stats-panel");
  });

  test("StatsPanel renders all 5 stat rows (real model, no empty state)", () => {
    // stats is always present — meter rows always rendered.
    const html = render();
    expect(html).toContain('data-stat="hp"');
    expect(html).toContain('data-stat="hunger"');
    expect(html).not.toContain("no stats data yet");
  });

  test("StatsPanel renders XP bar with level info", () => {
    const html = render();
    expect(html).toContain("stats-panel__xp");
    // XP line: L12 → L13
    expect(html).toContain("L12");
    expect(html).toContain("L13");
  });

  // Region 5: VitalsPanel + CritiqueInbox removed from Home (cleanup).
  // Operational telemetry now lives under StatsPanel via Gate / Budget /
  // SkipHistogram cards.
  test("VitalsPanel is NOT rendered on Home (removed)", () => {
    const html = render();
    expect(html).not.toContain("vitals-panel");
    expect(html).not.toContain('data-vital="mood"');
  });

  test("CritiqueInbox is NOT rendered on Home (removed)", () => {
    const html = render();
    expect(html).not.toContain("CRITIQUE INBOX");
    expect(html).not.toContain("critique-inbox");
  });

  test("Budget + SkipHistogram cards render under StatsPanel (GateCheckList dropped)", () => {
    const html = render();
    expect(html).not.toContain("GATE DIAGNOSTIC");
    expect(html).toContain("BUDGET");
    expect(html).toContain("REASON BREAKDOWN");
  });

  // Sidebar 4-entry count: PET (1) + WORK (3).
  test("sidebar has 4 total nav entries (PET 1 + WORK 3)", () => {
    const html = render();
    const activeMatches = html.match(/aria-current="page"/g) ?? [];
    expect(activeMatches.length).toBe(1);
    const navItemMatches = html.match(/class="nav-item(?:\s|")/g) ?? [];
    expect(navItemMatches.length).toBe(4);
  });

  test("no disabled nav entries remain (placeholders removed, all routes live)", () => {
    const html = render();
    expect(html.match(/aria-disabled="true"/g)).toBeNull();
  });

  // Dashboard wraps the active home entry (active = aria-current="page")
  test("Home nav entry has aria-current=page", () => {
    const html = render();
    expect(html).toContain('aria-current="page"');
  });

  // Per-entry nav meta strings — real data, no fake counts
  test("nav entries render trailing meta strings (today from home, memory from navMeta)", () => {
    const html = render();
    expect(html).toContain("nav-item__meta");
    // "today" is always shown on the home entry (literal, not a count)
    expect(html).toContain("today");
    // navMeta.memory = "1 fact" in fixture — injected via navMetaOverrides
    expect(html).toContain("1 fact");
    // Fake "1.3k facts" must NOT appear — it was a hardcoded stub
    expect(html).not.toContain("1.3k facts");
  });

  // TopBar is NOT part of Home component in Wave 1.5b
  test("TopBar is NOT rendered by Home component (dropped in Wave 1.5b)", () => {
    const html = render();
    expect(html).not.toContain('class="topbar"');
  });
});

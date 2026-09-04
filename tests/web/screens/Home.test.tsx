/** @jsxImportSource hono/jsx */
/**
 * Home.test.tsx — Wave 1.5b full-composition snapshot pin.
 *
 * Builds a minimal HomeData fixture, renders <Home data={fixture} /> to string,
 * and asserts the expected regions are present. TopBar is NOT mounted by the
 * Home component (dropped in Wave 1.5b — brand + pet meta live in sidebar chip
 * and Home content header).
 *
 * Real-data wiring: fixture uses null stats / [] vitals / navMeta.
 */
import { test, expect, describe } from "bun:test";
import { Home } from "../../../src/web/screens/Home";
import type { HomeData } from "../../../src/web/screens/Home";
import { HOME_RENDER_FIXTURE } from "./_home-render-fixture";

// ── Fixture ────────────────────────────────────────────────────────────────────
// Uses real-data shapes: stats=null, vitals=[], navMeta real.
// For visual preview stories with full vitals, see:
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

  test("Sidebar footer carries no daemon status line", () => {
    const html = render();
    // The footer itself stays — it holds the theme toggle.
    expect(html).toContain("sidebar-footer");
    // What is asserted ABSENT is the old daemon line: a status dot painted the
    // constant moss green whether or not the daemon answered, next to a port
    // the address bar already shows. Both were removed 2026-09-03. Asserting
    // absence rather than deleting the test, because the previous version of
    // this test asserted `:9876` was PRESENT — which is precisely what let a
    // hardcoded port live in the shell with the suite green.
    expect(html).not.toContain("daemon · :");
    expect(html).not.toContain(":9876");
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

  test("BUDGET renders under StatsPanel; the three internals panels do not", () => {
    // REASON BREAKDOWN / MODELS / BIAS AUDIT were hidden 2026-08-06 — they report on
    // siltpoke's own internals, not on the user's work. Asserted absent rather than just
    // dropped from the list, so a re-add is a deliberate act and not a silent one.
    const html = render();
    expect(html).not.toContain("GATE DIAGNOSTIC");
    expect(html).toContain("BUDGET");
    expect(html).not.toContain("REASON BREAKDOWN");
    expect(html).not.toContain("BIAS AUDIT");
  });

  // Sidebar 7-entry count: PET (1) + WORK (6) — "progress" added 2026-08-14
  // (progress-page-slice-1 Task 7, the /progress distribution view). Home's
  // fixture repo never seeds a ROADMAP.md, so this counts on the module-level
  // `unavailable` set in `src/web/routes/nav.ts` being empty by default (no
  // test in this file calls `setNavAvailability`) — the entry is visible
  // unless something deliberately hides it. Previously 6 (PET 1 + WORK 5)
  // after "knowledge" was added 2026-08-06 (Task 12, the /knowledge wiki
  // page). Previously 4 (PET 1 + WORK 3) after "Quests" and "Settings" were
  // both removed the same day with their routes' unmount. Previously 5, and
  // before that route's unmount. Previously 6; placeholders + help removed
  // 2026-07-02; "Restate" (re-internalization) nav entry added 064ba33c then
  // removed (spec §5 — shelved surface stripped, superseded by the AI quiz).
  //
  // The raw count stays a count (this test's whole point is being a change
  // detector for accidental nav additions/removals — same convention
  // tests/web/routes/nav.test.ts uses for its own flat-entry-count test),
  // but the new entry specifically is also named below rather than folded
  // silently into a bumped number.
  test("sidebar has 4 total nav entries (PET 1 + WORK 3) — Decisions came out 2026-08-17 with its route", () => {
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

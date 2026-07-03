/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { StatsPanel } from "../../../src/web/primitives/StatsPanel";

const SAMPLE_STATS = {
  hp:     9,
  hunger: 4,
  energy: 7,
  mood:   6,
  bond:   8,
};

const SAMPLE_XP = {
  level:    12,
  nextLevel: 13,
  xp:       1284,
  xpToNext: 2000,
  xpToday:  5,
  xpTodayCapped: false,
};

describe("StatsPanel", () => {
  test("renders STATS header", () => {
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={SAMPLE_XP} />);
    expect(html).toContain("STATS");
  });

  test("stats-panel class is on the root element", () => {
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={SAMPLE_XP} />);
    expect(html).toContain('class="stats-panel"');
  });

  test("renders 5 stat rows (hp/hunger/energy/mood/bond)", () => {
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={SAMPLE_XP} />);
    const rowMatches = html.match(/class="stats-panel__row"/g) ?? [];
    expect(rowMatches).toHaveLength(5);
  });

  test("renders all 5 data-stat attributes", () => {
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={SAMPLE_XP} />);
    expect(html).toContain('data-stat="hp"');
    expect(html).toContain('data-stat="hunger"');
    expect(html).toContain('data-stat="energy"');
    expect(html).toContain('data-stat="mood"');
    expect(html).toContain('data-stat="bond"');
  });

  test("renders stat labels", () => {
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={SAMPLE_XP} />);
    expect(html).toContain("hp");
    expect(html).toContain("hunger");
    expect(html).toContain("energy");
    expect(html).toContain("mood");
    expect(html).toContain("bond");
  });

  test("renders N/10 value for each stat", () => {
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={SAMPLE_XP} />);
    expect(html).toContain("9/10");
    expect(html).toContain("4/10");
    expect(html).toContain("7/10");
    expect(html).toContain("6/10");
    expect(html).toContain("8/10");
  });

  test("renders 10 blocks per stat row (total 50)", () => {
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={SAMPLE_XP} />);
    // Each block is a div with borderRadius:1px (the pixel meter style)
    // We can count the block divs by their inline style presence
    // Simple proxy: count occurrences of "border-radius:1px" within the meter area
    // More reliable: count the block pixel squares by counting the pattern
    // The meter renders METER_BLOCKS=10 per row, 5 rows = 50 total.
    // Check presence of block pattern across all rows
    const blockDivs = html.match(/border-radius:1px/g) ?? [];
    expect(blockDivs.length).toBe(50); // 5 stats × 10 blocks
  });

  test("renders XP section with level progression label", () => {
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={SAMPLE_XP} />);
    expect(html).toContain("stats-panel__xp");
    expect(html).toContain("L12");
    expect(html).toContain("L13");
    expect(html).toContain("→");
  });

  test("renders XP progress bar", () => {
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={SAMPLE_XP} />);
    // XP fill bar: width percent should be non-zero for xp=1284/xpToNext=2000
    expect(html).toContain("64%"); // Math.round(1284/2000*100) = 64
  });

  test("renders XP totals line (N / M)", () => {
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={SAMPLE_XP} />);
    // toLocaleString may format differently in test env; check raw numbers
    expect(html).toContain("1,284");
    expect(html).toContain("2,000");
  });

  test("renders 'to go' remainder label", () => {
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={SAMPLE_XP} />);
    expect(html).toContain("to go");
    // 2000 - 1284 = 716
    expect(html).toContain("716");
  });

  test("stat icons are rendered (♥ ⊙ ✦ ✱ ◆)", () => {
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={SAMPLE_XP} />);
    expect(html).toContain("♥");
    expect(html).toContain("⊙");
    expect(html).toContain("✦");
    expect(html).toContain("✱");
    expect(html).toContain("◆");
  });

  test("clamps stat values to 0-10 range (no crash on out-of-range)", () => {
    const outOfRange = { hp: 15, hunger: -3, energy: 10, mood: 0, bond: 7 };
    const html = String(<StatsPanel stats={outOfRange} xp={SAMPLE_XP} />);
    expect(html).toContain('data-stat="hp"');
    expect(html).toContain("10/10"); // clamped from 15
    expect(html).toContain("0/10"); // clamped from -3
  });

  test("XP bar width is 0% when xp=0", () => {
    const zeroXp = { level: 1, nextLevel: 2, xp: 0, xpToNext: 100, xpToday: 0, xpTodayCapped: false };
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={zeroXp} />);
    expect(html).toContain("0%");
  });

  test("XP bar width is capped at 100% when xp >= xpToNext", () => {
    const fullXp = { level: 5, nextLevel: 6, xp: 500, xpToNext: 500, xpToday: 0, xpTodayCapped: false };
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={fullXp} />);
    expect(html).toContain("100%");
  });

  // Design D — header "now" + xpToday delta

  test("header renders 'now' right-aligned label", () => {
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={SAMPLE_XP} />);
    expect(html).toContain("now");
    expect(html).toContain("stats-panel__now");
  });

  test("xpToday > 0 renders '+5 today' in terra color", () => {
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={SAMPLE_XP} />);
    expect(html).toContain("+5 today");
    expect(html).toContain("stats-panel__xp-today");
  });

  test("xpToday === 0 does NOT render the delta row", () => {
    const noXpToday = { ...SAMPLE_XP, xpToday: 0 };
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={noXpToday} />);
    expect(html).not.toContain("today");
    expect(html).not.toContain("stats-panel__xp-today");
  });

  test("xpTodayCapped renders '+100 today · capped'", () => {
    const cappedXp = { ...SAMPLE_XP, xpToday: 100, xpTodayCapped: true };
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={cappedXp} />);
    expect(html).toContain("+100 today · capped");
  });

  test("uncapped badge does NOT render the capped suffix", () => {
    const html = String(<StatsPanel stats={SAMPLE_STATS} xp={SAMPLE_XP} />);
    expect(html).toContain("+5 today");
    expect(html).not.toContain("capped");
  });
});

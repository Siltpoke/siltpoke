/**
 * Tests for dashboard-helpers renderStatsPanelOOB — the post-action HTMX
 * out-of-band swap must show the same awarded-ledger XP badge as the full
 * Home SSR (single source: progression.action_xp).
 */
import { test, expect, describe } from "bun:test";
import { renderStatsPanelOOB } from "../../src/daemon/routes/dashboard-helpers";
import { DEFAULT_PROGRESSION, type Progression } from "../../src/state/progression";

const NOW = new Date("2026-05-18T14:00:00Z");

function progressionWith(overrides: Partial<Progression>): Progression {
  return {
    ...DEFAULT_PROGRESSION,
    stats_last_tick_at: NOW.toISOString(),
    ...overrides,
  };
}

describe("renderStatsPanelOOB", () => {
  test("badge reads the awarded ledger, not daily_actions counts", () => {
    const prog = progressionWith({
      // Counts would price differently than the ledger — ledger must win.
      daily_actions: [{ day: "2026-05-18", feed: 2, play: 0, pet: 0, tease: 0, clean: 0, sleep: 0 }],
      action_xp: [{ day: "2026-05-18", xp: 37 }],
    });
    const html = renderStatsPanelOOB(prog, NOW);
    expect(html).toContain("+37 today");
    expect(html).not.toContain("capped");
  });

  test("ledger at the daily cap renders '+100 today · capped'", () => {
    const prog = progressionWith({
      action_xp: [{ day: "2026-05-18", xp: 100 }],
    });
    const html = renderStatsPanelOOB(prog, NOW);
    expect(html).toContain("+100 today · capped");
  });

  test("no ledger entry for today renders no badge", () => {
    const prog = progressionWith({
      daily_actions: [{ day: "2026-05-18", feed: 1, play: 0, pet: 1, tease: 0, clean: 0, sleep: 0 }],
    });
    const html = renderStatsPanelOOB(prog, NOW);
    expect(html).not.toContain("today");
  });

  test("wraps the panel in the hx-swap-oob container", () => {
    const html = renderStatsPanelOOB(progressionWith({}), NOW);
    expect(html).toContain('id="stats-panel"');
    expect(html).toContain('hx-swap-oob="true"');
  });
});

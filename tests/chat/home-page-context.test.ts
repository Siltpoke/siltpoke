/**
 * Chat on Home (/) is told what the page shows: the pet, its stats and XP
 * (worded as StatsPanel words them), and today's budget.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homePageText, readHomePageText } from "../../src/chat/home-page-context";
import { assemblePageContext } from "../../src/chat/page-context";
import type { HomeData } from "../../src/web/screens/Home.data";
import { HOME_RENDER_FIXTURE } from "../web/screens/_home-render-fixture";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const withBudget = (d: HomeData): HomeData => ({
  ...d,
  telemetry: {
    ...d.telemetry,
    budget: {
      ...d.telemetry.budget,
      stage: "soft",
      used_pct: 81.25,
      remaining_tokens: 93_750,
      rollup: {
        schemaVersion: 1,
        day: "2026-10-17",
        total_input_tokens: 104,
        total_output_tokens: 301_545,
        total_cache_tokens: 3_457_590,
        total_cost_usd: 3.8396,
        brain_calls: 43,
        reflections: 0,
        computed_at_ms: 0,
      },
    },
  },
});

describe("the Home page as chat context", () => {
  test("names the pet, its stats, XP as the page shows it, and today's budget", () => {
    const text = homePageText(withBudget(HOME_RENDER_FIXTURE));
    expect(text).toContain("Pet: Bangbang");
    expect(text).toContain("level 12");
    expect(text).toContain("since may 14");
    expect(text).toContain("Last poke: 2m ago");
    expect(text).toContain("Well-fed.");
    expect(text).toContain("Stats (out of 10): hp 10, hunger 5, energy 8, mood 6, bond 0.");
    // StatsPanel: "1,284 / 2,000" and "716 to go"
    expect(text).toContain("XP: level 12 → 13, 1,284 / 2,000, 716 to go; 10 today.");
    expect(text).toContain("Budget today: soft, 81.3% used, 93,750 tokens remaining");
    expect(text).toContain("output 301,545, cache (raw) 3,457,590, 43 brain calls, $3.8396 today");
  });

  test("stats as the page shows them: decayed floats rounded and clamped to 0–10; no XP-today when 0", () => {
    const d: HomeData = {
      ...HOME_RENDER_FIXTURE,
      stats: { hp: 7.318204, hunger: 4.5, energy: 10.4, mood: -0.2, bond: 2.49 },
      xp: { ...HOME_RENDER_FIXTURE.xp, xpToday: 0 },
    };
    const text = homePageText(d);
    expect(text).toContain("Stats (out of 10): hp 7, hunger 5, energy 10, mood 0, bond 2.");
    expect(text).not.toContain("7.318");
    expect(text).toContain("716 to go.");
    expect(text).not.toContain("today.");
  });

  test("leaves out what the page does not show: no well-fed badge, no quiet hours, no health warning", () => {
    const d = { ...HOME_RENDER_FIXTURE, topbarBadges: { ...HOME_RENDER_FIXTURE.topbarBadges, wellFed: false } };
    const text = homePageText(d);
    expect(text).not.toContain("Well-fed");
    expect(text).not.toContain("Quiet hours");
    expect(text).not.toContain("Warning shown");
    // no rollup yet: no token breakdown
    expect(text).not.toContain("brain calls");
  });

  test("quiet hours and a brain-health warning appear when the page shows them", () => {
    const d: HomeData = {
      ...HOME_RENDER_FIXTURE,
      telemetry: {
        ...HOME_RENDER_FIXTURE.telemetry,
        gateState: { blocking: "quiet hours", detail: "", checks: [{ name: "quiet hours", pass: false, detail: "22:00–07:00" }] },
      },
      brainHealth: { show: true, line: "Reviews are failing: claude is not logged in.", detail: "" },
    };
    const text = homePageText(d);
    expect(text).toContain("Quiet hours are on.");
    expect(text).toContain("Warning shown: Reviews are failing: claude is not logged in.");
  });

  test("the real reader on a fresh home, delivered through assemblePageContext('/')", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-home-ctx-"));
    homes.push(home);
    const text = await readHomePageText(home);
    expect(text).toMatch(/^Pet: /);
    expect(text).toContain("Stats (out of 10): hp ");
    expect(text).toContain("Budget today: ");
    const ctx = await assemblePageContext("/", { homeBase: home });
    expect(ctx?.pageLabel).toBe("Home");
    expect(ctx?.contextBundle).toBe(text);
    expect(ctx?.systemPrompt).toContain("which shows their pet, its stats and XP, and today's token budget");
  });

  test("a read failure degrades to label only", async () => {
    const ctx = await assemblePageContext("/", {
      homeBase: "/tmp",
      readHomePage: async () => {
        throw new Error("io");
      },
    });
    expect(ctx?.contextBundle).toBe("");
    expect(ctx?.pageLabel).toBe("Home");
  });
});

/** @jsxImportSource hono/jsx */
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Audit defect [3] — one screen must not answer "is it fed?" two ways.
 *
 * A new pet showed `awake · hungry` on the left and a green `well-fed` badge on
 * the right, at the same time, on the very first look. Not a race: the top-bar
 * badge read `stats.hunger > 4` while the mood read "was there a feed action
 * today", and a new pet starts at hunger 5 having never been fed, so both were
 * true. Every new user saw it.
 *
 * The fixture is the defect's own state — hunger at its 5 default, empty
 * daily_actions — and the assertions run against REAL getHomeData output fed
 * into the REAL component, not a hand-built render fixture. A hand-built one
 * could not have caught this: the contradiction lived in how the two values
 * were DERIVED, and a fixture that states both by hand states them
 * consistently by accident.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Home } from "../../../src/web/screens/Home";
import { getHomeData, type HomeDeps } from "../../../src/web/screens/Home.data";
import { HOME_DATA_NOW as NOW, writeHomeFixtures } from "./_home-data-fixtures";

/** A pet nobody has fed: stats omitted so hunger takes its 5 default. */
const NEVER_FED = {
  schemaVersion: 1,
  level: 3,
  xp: 240,
  xp_to_next_level: 500,
  unlocked_poses: ["base"],
  unlocked_titles: ["Hatchling"],
  pet_log: [],
  daily_actions: [],
};

describe("Home — well-fed and hungry cannot appear together", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "siltpoke-wellfed-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function renderFresh(): Promise<{ html: string; hunger: number; wellFed: boolean }> {
    writeHomeFixtures(tmp, { progression: NEVER_FED });
    const deps: HomeDeps = { basePath: tmp, now: NOW };
    const data = await getHomeData(deps);
    return {
      html: String(<Home data={data} />),
      hunger: data.stats.hunger,
      wellFed: data.topbarBadges.wellFed,
    };
  }

  test("the fixture really is the state that produced the defect", async () => {
    // Device check. If hunger drifted off its default, or the fixture picked up
    // a feed action, the assertions below would pass without ever reaching the
    // case that broke — the way an empty comparison prints like a passing one.
    const { hunger } = await renderFresh();
    expect(hunger).toBe(5);
    expect(hunger).toBeGreaterThan(4); // the badge's old trigger
  });

  test("a never-fed new pet does not render both labels at once", async () => {
    const { html } = await renderFresh();
    const saysWellFed = html.includes("well-fed");
    const saysHungry = html.includes("hungry");
    expect(
      `well-fed=${saysWellFed} hungry=${saysHungry}`,
      "one screen answered 'is it fed?' both ways",
    ).not.toBe("well-fed=true hungry=true");
  });

  test("the badge and the vitals row agree, whichever way they land", async () => {
    // Pins them to ONE derivation. Scope, because it is easy to over-read: this
    // catches the two labels DIVERGING again. It does NOT catch one source
    // computing a wrong value — forcing wellFedFromHunger to return false makes
    // both sides say `hungry`, and both this test and the one above pass. The
    // hunger=0 and hunger=9 tests below are what fail there.
    const { html, wellFed } = await renderFresh();
    expect(html.includes("well-fed")).toBe(wellFed);
    expect(html.includes("hungry")).toBe(!wellFed);
  });

  test("a starving pet reads hungry on both, with no well-fed badge", async () => {
    // The other end of the scale — absence is asserted, not just presence, so
    // "never shows well-fed" cannot pass by the badge being broken off.
    writeHomeFixtures(tmp, {
      progression: { ...NEVER_FED, stats: { hp: 10, hunger: 0, energy: 5, mood: 5, bond: 5 } },
    });
    const data = await getHomeData({ basePath: tmp, now: NOW });
    const html = String(<Home data={data} />);
    expect(data.topbarBadges.wellFed).toBe(false);
    expect(html).not.toContain("well-fed");
    expect(html).toContain("hungry");
  });

  test("a freshly fed pet reads well-fed on both, and never says hungry", async () => {
    writeHomeFixtures(tmp, {
      progression: { ...NEVER_FED, stats: { hp: 10, hunger: 9, energy: 5, mood: 5, bond: 5 } },
    });
    const data = await getHomeData({ basePath: tmp, now: NOW });
    const html = String(<Home data={data} />);
    expect(data.topbarBadges.wellFed).toBe(true);
    expect(html).toContain("well-fed");
    // The case the discarded stand-in got wrong: fed yesterday, 9/10 today, and
    // it still answered "hungry" because no feed action was logged for today.
    expect(html).not.toContain("hungry");
  });
});

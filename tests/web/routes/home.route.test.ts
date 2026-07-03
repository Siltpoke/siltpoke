/**
 * topbarBadgesFromData mapper unit tests.
 *
 * Pins the route-side translator (HomeData.topbarBadges → TopBarBadge[]).
 * Tested in isolation so a mapper bug is distinguishable from a render bug
 * in the e2e — the mapper has its own branching (wellFed / todayCount > 0)
 * that the e2e cannot exhaustively cover.
 */
import { test, expect, describe } from "bun:test";
import { topbarBadgesFromData } from "../../../src/web/routes/home";
import type { HomeData } from "../../../src/web/screens/Home.data";

type TopbarBadgesInput = HomeData["topbarBadges"];

function badges(over: Partial<TopbarBadgesInput> = {}): TopbarBadgesInput {
  return {
    wellFed: false,
    sinceDressed: "22 hrs",
    todayCount: 0,
    ...over,
  };
}

describe("topbarBadgesFromData", () => {
  test("wellFed=true emits 'well-fed' badge as first entry with good tone", () => {
    const out = topbarBadgesFromData(badges({ wellFed: true }));
    expect(out[0]?.id).toBe("well-fed");
    expect(out[0]?.label).toBe("well-fed");
    expect(out[0]?.tone).toBe("good");
  });

  test("wellFed=false omits 'well-fed' badge entirely", () => {
    const out = topbarBadgesFromData(badges({ wellFed: false }));
    expect(out.find((b) => b.id === "well-fed")).toBeUndefined();
  });

  test("always emits 'dressed' badge with sinceDressed as value (neutral tone, label='dressed')", () => {
    const out = topbarBadgesFromData(badges({ sinceDressed: "22 hrs" }));
    const dressed = out.find((b) => b.id === "dressed");
    expect(dressed).toBeDefined();
    expect(dressed?.label).toBe("dressed");
    expect(dressed?.value).toBe("22 hrs");
    expect(dressed?.tone).toBe("neutral");
  });

  test("'dressed' label is 'dressed' (NOT 'since dressed') to avoid double-stamping", () => {
    const out = topbarBadgesFromData(badges({ sinceDressed: "22 hrs" }));
    const dressed = out.find((b) => b.id === "dressed");
    expect(dressed?.label).not.toContain("since");
    expect(dressed?.value).not.toContain("since dressed");
  });

  test("'dressed' threads 'never' through unchanged", () => {
    const out = topbarBadgesFromData(badges({ sinceDressed: "never" }));
    const dressed = out.find((b) => b.id === "dressed");
    expect(dressed?.value).toBe("never");
  });

  test("todayCount > 0 emits 'today' badge with 'N new' value (good tone)", () => {
    const out = topbarBadgesFromData(badges({ todayCount: 5 }));
    const today = out.find((b) => b.id === "today");
    expect(today).toBeDefined();
    expect(today?.label).toBe("today");
    expect(today?.value).toBe("5 new");
    expect(today?.tone).toBe("good");
  });

  test("todayCount=0 omits 'today' badge ('0 new' would be visual noise)", () => {
    const out = topbarBadgesFromData(badges({ todayCount: 0 }));
    expect(out.find((b) => b.id === "today")).toBeUndefined();
  });

  test("full input (wellFed + sinceDressed + todayCount=3) → 3 badges in order: well-fed, dressed, today", () => {
    const out = topbarBadgesFromData(badges({ wellFed: true, sinceDressed: "3 hrs", todayCount: 3 }));
    expect(out).toHaveLength(3);
    expect(out.map((b) => b.id)).toEqual(["well-fed", "dressed", "today"]);
  });

  test("minimal input (no wellFed + 0 todayCount) → 1 badge: dressed only", () => {
    const out = topbarBadgesFromData(badges({ wellFed: false, todayCount: 0 }));
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("dressed");
  });

  test("wellFed without todayCount → 2 badges in order: well-fed, dressed", () => {
    const out = topbarBadgesFromData(badges({ wellFed: true, todayCount: 0 }));
    expect(out.map((b) => b.id)).toEqual(["well-fed", "dressed"]);
  });

  test("no wellFed but todayCount > 0 → 2 badges in order: dressed, today", () => {
    const out = topbarBadgesFromData(badges({ wellFed: false, todayCount: 4 }));
    expect(out.map((b) => b.id)).toEqual(["dressed", "today"]);
  });
});

/**
 * The history pane's grouping: Today / Yesterday / This week / Earlier by
 * local calendar day, a time for the first two, a date for the rest.
 */
import { describe, expect, test } from "bun:test";
import { groupHistory } from "../../../../src/web/client/islands/floating-chat-history";

// Local times, so the day boundaries are the viewer's, not UTC's.
const NOW = new Date(2026, 9, 17, 21, 30);
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).toISOString();
const hm = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const md = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

describe("groupHistory", () => {
  test("groups by local day, keeps the given order, and labels each row", () => {
    const convs = [
      { id: "a", title: "today late", label: "x", createdAt: at(17, 11, 4) },
      { id: "b", title: "today 00:00", label: "x", createdAt: at(17, 0, 0) },
      { id: "c", title: "", label: "yesterday label", createdAt: at(16, 22, 27) },
      { id: "d", title: "six days ago", label: "x", createdAt: at(11, 9) },
      { id: "e", title: "seven days ago", label: "x", createdAt: at(10, 9) },
      { id: "f", title: "no date", label: "x", createdAt: null },
    ];
    const g = groupHistory(convs, NOW);
    expect(g.map((x) => [x.label, x.rows.map((r) => r.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      ["This week", ["d"]],
      ["Earlier", ["e", "f"]],
    ]);
    // Today / Yesterday show the time; older rows the date; no date shows nothing.
    expect(g[0]?.rows[0]).toEqual({ id: "a", title: "today late", when: hm(at(17, 11, 4)) });
    expect(g[1]?.rows[0]).toEqual({ id: "c", title: "yesterday label", when: hm(at(16, 22, 27)) });
    expect(g[2]?.rows[0]?.when).toBe(md(at(11, 9)));
    expect(g[3]?.rows[0]?.when).toBe(md(at(10, 9)));
    expect(g[3]?.rows[1]?.when).toBe("");
  });

  test("an unreadable date is Earlier with no time; no conversations, no groups", () => {
    expect(groupHistory([{ id: "z", label: "l", createdAt: "not-a-date" }], NOW)).toEqual([
      { label: "Earlier", rows: [{ id: "z", title: "l", when: "" }] },
    ]);
    expect(groupHistory([], NOW)).toEqual([]);
  });

  test("a chat at five past midnight shows 00:05, not 24:05", () => {
    const [g] = groupHistory([{ id: "m", label: "m", createdAt: at(17, 0, 5) }], NOW);
    expect(g?.rows[0]?.when).toMatch(/^00\D05/);
  });

  test("days are calendar days: the day after a 25-hour DST day is still Yesterday", () => {
    // bun test runs in UTC, which has no DST; 2026-11-01 is 25 hours long in Los Angeles.
    const before = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const now = new Date(2026, 10, 2, 9, 0);
      const yesterday = new Date(2026, 10, 1, 0, 30);
      expect((now.getTime() - yesterday.getTime()) / 3_600_000).toBe(33.5); // the 25-hour day is in effect
      const [g] = groupHistory([{ id: "y", label: "y", createdAt: yesterday.toISOString() }], now);
      expect(g?.label).toBe("Yesterday");
    } finally {
      process.env.TZ = before;
    }
  });

  test("a label appears once per run of rows — empty groups are left out", () => {
    const g = groupHistory(
      [
        { id: "a", label: "a", createdAt: at(17, 9) },
        { id: "b", label: "b", createdAt: at(2, 9) },
      ],
      NOW,
    );
    expect(g.map((x) => x.label)).toEqual(["Today", "Earlier"]);
  });
});

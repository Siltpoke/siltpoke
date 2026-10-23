process.env.TZ = "UTC";

/**
 * Memory page timeline shows 10 memories per page, with previous / next.
 *
 * Why: each timeline row costs ~7 ms to draw (50 rows 0.35–0.44 s, 342 rows
 * 2.2–3.0 s, measured on the live page 2026-10-15). "Show more" (#996) grew
 * the drawn set with every click, back toward the slow case; a page keeps it
 * at 10 however far you go. The data still arrives whole; counts on the filter
 * chips keep using every memory.
 */
import { describe, expect, it } from "bun:test";
import type { MemoryEventClient } from "../../../../src/web/client/islands/memory-book";
import { makeMemoryBookData } from "../../../../src/web/client/islands/memory-book";

/** n memories, one per minute; newest-first order is mem-(n-1) … mem-0. */
function memories(n: number, type: MemoryEventClient["type"] = "semantic"): MemoryEventClient[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `mem-${i}`,
    ts: new Date(Date.UTC(2026, 9, 1, 0, 0) + i * 60_000).toISOString(),
    type,
    text: `memory ${i}`,
    why: null,
    status: "active" as const,
  }));
}

function book(list: MemoryEventClient[]) {
  const data = makeMemoryBookData();
  data.memories = list;
  data.todayKey = "2026-10-15";
  return data;
}

const drawn = (data: ReturnType<typeof book>) => data.groups().flatMap((g) => g.items.map((r) => r.id));

describe("memory book — timeline pages of 10", () => {
  it("page 1 of 35 memories is the newest 10", () => {
    const data = book(memories(35));
    const ids = drawn(data);
    expect(ids.length).toBe(10);
    expect(ids[0]).toBe("mem-34");
    expect(ids[9]).toBe("mem-25");
    expect(data.pageNumber()).toBe(1);
    expect(data.pageCount()).toBe(4);
  });

  it("next and previous move one page; the last page holds only what is left", () => {
    const data = book(memories(35));
    data.nextPage();
    expect(drawn(data)).toEqual(Array.from({ length: 10 }, (_, i) => `mem-${24 - i}`));
    data.nextPage();
    expect(drawn(data)).toEqual(Array.from({ length: 10 }, (_, i) => `mem-${14 - i}`));
    data.nextPage();
    expect(drawn(data)).toEqual(Array.from({ length: 5 }, (_, i) => `mem-${4 - i}`));
    expect(data.pageNumber()).toBe(4);
    data.prevPage();
    expect(data.pageNumber()).toBe(3);
    expect(drawn(data)[0]).toBe("mem-14");
  });

  it("previous on page 1 and next on the last page stay put", () => {
    const data = book(memories(35));
    data.prevPage();
    expect(data.pageNumber()).toBe(1);
    data.nextPage();
    data.nextPage();
    data.nextPage();
    data.nextPage();
    expect(data.pageNumber()).toBe(4);
    expect(drawn(data).length).toBe(5);
  });

  it("extra clicks on next at the last page do not carry over when the list grows", () => {
    // The display is the same either way; the stored page is what differs.
    // Unclamped, 4 extra clicks would leave page 8 stored, and a list grown to
    // 70 (7 pages) would jump to page 7, a page she never chose.
    const data = book(memories(35));
    for (let i = 0; i < 7; i++) data.nextPage();
    expect(data.pageNumber()).toBe(4);
    data.memories = memories(70);
    expect(data.pageNumber()).toBe(4);
  });

  it("10 or fewer is one page; none is one empty page", () => {
    for (const n of [1, 10]) {
      const data = book(memories(n));
      expect(drawn(data).length).toBe(n);
      expect(data.pageCount()).toBe(1);
    }
    const empty = book([]);
    expect(drawn(empty)).toEqual([]);
    expect(empty.pageCount()).toBe(1);
    expect(empty.pageNumber()).toBe(1);
  });

  it("pages count the filtered list, and chip counts still use every memory", () => {
    const data = book([...memories(32, "episodic"), ...memories(10, "semantic").map((m) => ({ ...m, id: `s-${m.id}` }))]);
    data.setFilterType("episodic");
    expect(data.pageCount()).toBe(4);
    expect(drawn(data).length).toBe(10);
    expect(data.countByType("episodic")).toBe(32);
    expect(data.countByType("semantic")).toBe(10);
  });

  it("changing the type filter, the status filter, or the sort goes back to page 1", () => {
    for (const change of [
      (d: ReturnType<typeof book>) => d.setFilterType("semantic"),
      (d: ReturnType<typeof book>) => d.setFilterStatus("active"),
      (d: ReturnType<typeof book>) => d.toggleSort(),
    ]) {
      const data = book(memories(60));
      data.nextPage();
      data.nextPage();
      expect(data.pageNumber()).toBe(3);
      change(data);
      expect(data.pageNumber()).toBe(1);
    }
  });

  it("the sort direction decides what page 1 holds", () => {
    const data = book(memories(40));
    data.toggleSort();
    const ids = drawn(data);
    expect(ids[0]).toBe("mem-0");
    expect(ids[9]).toBe("mem-9");
  });

  it("a page emptied by the list shrinking shows the last page that still has rows", () => {
    // e.g. retiring rows while the "Active" status filter is on.
    const data = book(memories(35));
    data.nextPage();
    data.nextPage();
    data.nextPage();
    expect(data.pageNumber()).toBe(4);
    data.memories = memories(15);
    expect(data.pageNumber()).toBe(2);
    expect(drawn(data).length).toBe(5);
  });

  it("jumping to a memory on another page turns to that page", () => {
    // A supersede link can point at an older, retired fact many pages down.
    const data = book(memories(60));
    data.jumpToFact("mem-10"); // newest-first index 49 → page 5
    expect(data.pageNumber()).toBe(5);
    expect(drawn(data)).toContain("mem-10");
  });

  it("jumping from the by-type view does not change the timeline page", () => {
    const data = book(memories(60));
    data.setView("byType");
    data.jumpToFact("mem-10");
    data.setView("timeline");
    expect(data.pageNumber()).toBe(1);
  });

  it("jumping to a memory on this page, an unknown id, or a filtered-out one keeps the page", () => {
    const data = book(memories(60));
    data.nextPage();
    data.jumpToFact("mem-40"); // index 19 → page 2, already here
    data.jumpToFact("no-such-id");
    data.jumpToFact(null);
    expect(data.pageNumber()).toBe(2);

    const filtered = book([...memories(40), { ...memories(1, "procedural")[0]!, id: "p-old", ts: "2020-01-01T00:00:00.000Z" }]);
    filtered.setFilterType("semantic");
    filtered.jumpToFact("p-old");
    expect(filtered.pageNumber()).toBe(1);
  });
});

describe("memory book — order across time-zone spellings", () => {
  // Stored timestamps mix "Z" and "-07:00" spellings (live data, 2026-10-16).
  // Compared as text, 20:00-07:00 (= 03:00Z next day) sorted below 23:00Z, so
  // one day came out as two groups with the same key, and the page drew them
  // below the pager.
  const mixed: MemoryEventClient[] = [
    { id: "a", ts: "2026-10-02T01:00:00.000Z", type: "semantic", text: "a", why: null, status: "active" },
    { id: "b", ts: "2026-10-01T20:00:00-07:00", type: "semantic", text: "b", why: null, status: "active" },
    { id: "c", ts: "2026-10-01T23:00:00Z", type: "semantic", text: "c", why: null, status: "active" },
  ];

  it("sorts by the moment, not the text", () => {
    const data = book(mixed);
    expect(drawn(data)).toEqual(["b", "a", "c"]);
    data.toggleSort();
    expect(drawn(data)).toEqual(["c", "a", "b"]);
  });

  it("puts a time it cannot read after every time it can", () => {
    const bad: MemoryEventClient = { id: "x", ts: "unknown", type: "semantic", text: "x", why: null, status: "active" };
    expect(drawn(book([bad, ...mixed]))).toEqual(["b", "a", "c", "x"]);
  });

  it("gives each day one group", () => {
    const dates = book(mixed).groups().map((g) => g.date);
    expect(dates).toEqual(["2026-10-02", "2026-10-01"]);
  });
});

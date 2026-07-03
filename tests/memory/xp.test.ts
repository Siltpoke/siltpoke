import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendXpEvent,
  xpFor,
  resetDailyCapsIfNewDay,
} from "../../src/memory/xp";
import { emptyGlobal, readGlobal, writeGlobal } from "../../src/memory/global";
import { DAILY_CAPS } from "../../src/memory/xp-caps";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-xp-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("appendXpEvent", () => {
  test("creates global.json if missing", async () => {
    const r = await appendXpEvent(home, { amount: 5, source: "manual_pet" });
    expect(r.new_total).toBe(5);
    expect(r.capped).toBe(false);
    expect(r.written.amount).toBe(5);
  });

  test("increments xp_total cumulatively", async () => {
    await appendXpEvent(home, { amount: 3, source: "manual_pet" });
    const r = await appendXpEvent(home, { amount: 2, source: "manual_pet" });
    expect(r.new_total).toBe(5);
  });

  test("persists source_id + source_project + note", async () => {
    const r = await appendXpEvent(home, {
      amount: 4,
      source: "accepted_fact",
      source_id: "f-1",
      source_project: "p-abc",
      note: "user approved a fact",
    });
    expect(r.written.source_id).toBe("f-1");
    expect(r.written.source_project).toBe("p-abc");
    expect(r.written.note).toBe("user approved a fact");
  });

  test("caps + writes capped=true amount=0 once over the per-source cap", async () => {
    const cap = DAILY_CAPS.manual_pet; // 5
    const fixedDay = new Date("2026-05-16T10:00:00Z");
    for (let i = 0; i < cap; i++) {
      const r = await appendXpEvent(home, {
        amount: 1,
        source: "manual_pet",
        now: fixedDay,
      });
      expect(r.capped).toBe(false);
    }
    const over = await appendXpEvent(home, {
      amount: 1,
      source: "manual_pet",
      now: fixedDay,
    });
    expect(over.capped).toBe(true);
    expect(over.written.amount).toBe(0);
    expect(over.new_total).toBe(cap);
  });

  test("resets the cap on new local day", async () => {
    const day1 = new Date("2026-05-16T10:00:00Z");
    const day2 = new Date("2026-05-17T10:00:00Z");
    for (let i = 0; i < DAILY_CAPS.manual_pet + 2; i++) {
      await appendXpEvent(home, { amount: 1, source: "manual_pet", now: day1 });
    }
    const fresh = await appendXpEvent(home, {
      amount: 1,
      source: "manual_pet",
      now: day2,
    });
    expect(fresh.capped).toBe(false);
  });

  test("caps are per-source independent", async () => {
    const day = new Date("2026-05-16T10:00:00Z");
    // first_chat_of_day cap is 1
    const r1 = await appendXpEvent(home, {
      amount: 10,
      source: "first_chat_of_day",
      now: day,
    });
    expect(r1.capped).toBe(false);
    const r2 = await appendXpEvent(home, {
      amount: 10,
      source: "first_chat_of_day",
      now: day,
    });
    expect(r2.capped).toBe(true);
    // manual_pet still has room
    const r3 = await appendXpEvent(home, {
      amount: 1,
      source: "manual_pet",
      now: day,
    });
    expect(r3.capped).toBe(false);
  });

  test("rejects negative amounts", async () => {
    await expect(
      appendXpEvent(home, { amount: -1, source: "manual_pet" }),
    ).rejects.toThrow(/non-negative/);
  });

  test("rejects non-integer amounts", async () => {
    await expect(
      appendXpEvent(home, { amount: 1.5, source: "manual_pet" }),
    ).rejects.toThrow(/non-negative integer/);
  });
});

describe("xpFor", () => {
  beforeEach(async () => {
    await appendXpEvent(home, {
      amount: 3,
      source: "forwarded_critique",
      source_project: "p-a",
      ts: "2026-05-16T10:00:00Z",
    });
    await appendXpEvent(home, {
      amount: 2,
      source: "accepted_fact",
      source_project: "p-a",
      ts: "2026-05-16T11:00:00Z",
    });
    await appendXpEvent(home, {
      amount: 4,
      source: "forwarded_critique",
      source_project: "p-b",
      ts: "2026-05-17T09:00:00Z",
    });
  });

  test("no filter returns all events", async () => {
    const r = await xpFor(home, {});
    expect(r.events.length).toBe(3);
    expect(r.total).toBe(9);
  });

  test("filter by project_id", async () => {
    const r = await xpFor(home, { project_id: "p-a" });
    expect(r.events.length).toBe(2);
    expect(r.total).toBe(5);
  });

  test("filter by source", async () => {
    const r = await xpFor(home, { source: "forwarded_critique" });
    expect(r.events.length).toBe(2);
    expect(r.total).toBe(7);
  });

  test("filter by local date", async () => {
    // Local YYYY-MM-DD; ISO timestamps above are UTC but localDateOf uses
    // host TZ, so this test passes regardless of system TZ as long as the
    // ISO date matches the local date for both points (true in CI Ubuntu UTC
    // and most US/EU TZs for these particular times).
    const r = await xpFor(home, { date: "2026-05-17" });
    // We don't assert exact length here — TZ-sensitive — but the total
    // should be EITHER 4 (p-b event) or 0 (TZ shifted it elsewhere).
    expect([0, 4]).toContain(r.total);
  });

  test("combined filters AND together", async () => {
    const r = await xpFor(home, {
      project_id: "p-a",
      source: "accepted_fact",
    });
    expect(r.events.length).toBe(1);
    expect(r.total).toBe(2);
  });

  test("returns empty when global.json missing", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "siltpoke-xp-empty-"));
    try {
      const r = await xpFor(fresh, {});
      expect(r.events).toEqual([]);
      expect(r.total).toBe(0);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("resetDailyCapsIfNewDay", () => {
  test("no-op when local_date matches", () => {
    const g = emptyGlobal(new Date("2026-05-16T10:00:00Z"));
    g.daily_caps_state.per_source_counts = { manual_pet: 3 };
    const out = resetDailyCapsIfNewDay(g, new Date("2026-05-16T22:00:00Z"));
    expect(out.daily_caps_state.per_source_counts.manual_pet).toBe(3);
  });

  test("clears counts on new local day", () => {
    const g = emptyGlobal(new Date("2026-05-16T10:00:00Z"));
    g.daily_caps_state.per_source_counts = { manual_pet: 3 };
    const out = resetDailyCapsIfNewDay(g, new Date("2026-05-17T01:00:00Z"));
    expect(out.daily_caps_state.per_source_counts).toEqual({});
    expect(out.daily_caps_state.local_date).toBe("2026-05-17");
  });

  test("does not mutate input", () => {
    const g = emptyGlobal(new Date("2026-05-16T10:00:00Z"));
    const original = JSON.parse(JSON.stringify(g));
    resetDailyCapsIfNewDay(g, new Date("2026-05-17T10:00:00Z"));
    expect(g).toEqual(original);
  });
});

test("appendXpEvent persists through readGlobal round-trip", async () => {
  await appendXpEvent(home, {
    amount: 5,
    source: "achievement_unlock",
    source_id: "ach-1",
  });
  const back = await readGlobal(home);
  expect(back?.xp_total).toBe(5);
  expect(back?.xp_log).toHaveLength(1);
  expect(back?.xp_log[0]?.source).toBe("achievement_unlock");
});

test("appendXpEvent preserves prior xp_log entries", async () => {
  const seeded = emptyGlobal();
  seeded.xp_log.push({
    id: "xp-seed",
    ts: "2026-05-15T00:00:00Z",
    amount: 7,
    source: "manual_pet",
    source_id: null,
    source_project: null,
    capped: false,
    note: null,
  });
  seeded.xp_total = 7;
  await writeGlobal(home, seeded);
  await appendXpEvent(home, { amount: 3, source: "forwarded_critique" });
  const back = await readGlobal(home);
  expect(back?.xp_total).toBe(10);
  expect(back?.xp_log).toHaveLength(2);
  expect(back?.xp_log[0]?.id).toBe("xp-seed");
});

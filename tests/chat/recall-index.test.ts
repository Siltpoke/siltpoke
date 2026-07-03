import { test, expect } from "bun:test";
import {
  summaryHash,
  refreshSummaryIndex,
  type SummaryIndexEntry,
} from "../../src/chat/recall";

const fakeEmbed = (calls: string[]) => async (t: string) => {
  calls.push(t);
  return [t.length, 0, 0]; // deterministic tiny vector
};

test("unchanged summary is NOT re-embedded; changed one is", async () => {
  const now = new Date("2026-06-26T00:00:00Z");
  const sessions = [{ id: "s1", summary: "wire recall to consolidate" }];
  const calls: string[] = [];
  const embed = fakeEmbed(calls);

  // first pass: cold index → embeds once
  const r1 = await refreshSummaryIndex(sessions, [], embed, now);
  expect(r1.embedCount).toBe(1);

  // second pass, same summary → zero embeds
  const calls2: string[] = [];
  const r2 = await refreshSummaryIndex(sessions, r1.entries, fakeEmbed(calls2), now);
  expect(r2.embedCount).toBe(0);

  // change summary → re-embed once
  const calls3: string[] = [];
  const r3 = await refreshSummaryIndex(
    [{ id: "s1", summary: "CHANGED text" }], r1.entries, fakeEmbed(calls3), now,
  );
  expect(r3.embedCount).toBe(1);
  expect(r3.entries[0].summary_hash).toBe(summaryHash("CHANGED text"));
});

test("empty/whitespace summary skipped; vanished session dropped", async () => {
  const now = new Date("2026-06-26T00:00:00Z");
  const seed: SummaryIndexEntry[] = [
    { session_id: "old", summary_hash: "x", embedding: [1], updated_at: now.toISOString() },
  ];
  const calls: string[] = [];
  const r = await refreshSummaryIndex(
    [{ id: "s1", summary: "   " }], seed, fakeEmbed(calls), now,
  );
  expect(calls.length).toBe(0);              // empty summary not embedded
  expect(r.entries.find((e) => e.session_id === "old")).toBeUndefined(); // vanished dropped
  expect(r.entries.find((e) => e.session_id === "s1")).toBeUndefined();  // empty not indexed
});

/**
 * Chat on /timeline is told what the page shows: its reviews, newest first,
 * and the review the page opens by default. Read through the real telemetry
 * reader against a real home, the way the /timeline route reads it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemblePageContext } from "../../src/chat/page-context";
import { readTimelinePageText } from "../../src/chat/timeline-page-context";
import { type FixtureCall, fixtureLines } from "../web/routes/timeline-fixture-lines";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function home(calls: FixtureCall[]): string {
  const h = mkdtempSync(join(tmpdir(), "siltpoke-timeline-ctx-"));
  homes.push(h);
  if (calls.length > 0) writeFileSync(join(h, "brain-calls.jsonl"), `${fixtureLines(calls).join("\n")}\n`);
  return h;
}

const NOW = new Date("2026-10-17T22:00:00.000Z");
const CALLS: FixtureCall[] = [
  {
    ts: "2026-10-17T20:00:00.000Z",
    session: "s-old",
    status: "fired",
    cwd: "/Users/foo/older-proj",
    bubble_short: "OLDER-SHORT the retry loop has no exit",
    bubble_long: "OLDER-LONG must not be sent",
  },
  { ts: "2026-10-17T20:30:00.000Z", session: "s-skip", status: "skipped", skip_reason: "quiet_hours" },
  {
    ts: "2026-10-17T21:00:00.000Z",
    session: "s-new",
    status: "fired",
    cwd: "/Users/foo/newer-proj",
    bubble_short: "NEWER-SHORT the test asserts nothing",
    bubble_long: `NEWER-LONG the assertion is missing. ${"x".repeat(3000)}`,
    critique: "NEWER-CRITIQUE add expect(result).toBe(3)",
    severity: "high",
  },
];

describe("the Timeline page as chat context", () => {
  test("lists the page's reviews newest first, and opens the newest", async () => {
    const text = await readTimelinePageText(home(CALLS), NOW);
    const newer = text.indexOf("NEWER-SHORT");
    const older = text.indexOf("OLDER-SHORT");
    expect(newer).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(newer);
    expect(text).toContain("newer-proj");
    expect(text).toContain("no filters set");
    // the review open by default: its long text and what it asked the agent
    expect(text).toContain("NEWER-LONG the assertion is missing.");
    expect(text).toContain("NEWER-CRITIQUE add expect(result).toBe(3)");
  });

  test("only what the page shows by default: no skipped rows, no other review's long text, long text clipped", async () => {
    const text = await readTimelinePageText(home(CALLS), NOW);
    expect(text).not.toContain("quiet_hours");
    expect(text).not.toContain("OLDER-LONG");
    expect(text).not.toContain("x".repeat(1600));
    expect(text).toContain("…");
  });

  test("the page's window: the 12 newest reviews, however old, and no more", async () => {
    // 13 fired reviews, the oldest a year back: the page shows 12 with no
    // range filter, so the year-old one is out only because it is 13th.
    const calls: FixtureCall[] = Array.from({ length: 13 }, (_, i) => ({
      ts: i === 0 ? "2025-10-01T09:00:00.000Z" : new Date(Date.UTC(2026, 9, 1 + i, 9)).toISOString(),
      session: `s-${i}`,
      status: "fired",
      bubble_short: `REVIEW-${String(i).padStart(2, "0")}`,
    }));
    const text = await readTimelinePageText(home(calls), NOW);
    expect(text.match(/REVIEW-\d\d/g)).toHaveLength(12);
    expect(text).not.toContain("REVIEW-00");
    expect(text).toContain("REVIEW-12");
    // with 12 rows the year-old one is on the page: no time-range cut
    const twelve = await readTimelinePageText(home(calls.slice(0, 12)), NOW);
    expect(twelve).toContain("REVIEW-00");
  });

  test("assemblePageContext delivers it for /timeline with no seam", async () => {
    const ctx = await assemblePageContext("/timeline", { homeBase: home(CALLS) });
    expect(ctx?.pageLabel).toBe("Timeline");
    expect(ctx?.contextBundle).toContain("NEWER-SHORT");
    expect(ctx?.systemPrompt).toContain("lists Siltpoke's reviews");
  });

  test("no reviews yet: label only", async () => {
    const ctx = await assemblePageContext("/timeline", { homeBase: home([]) });
    expect(ctx?.contextBundle).toBe("");
    expect(ctx?.systemPrompt).toContain("Timeline");
  });

  test("a read failure degrades to label only", async () => {
    const ctx = await assemblePageContext("/timeline", {
      homeBase: "/tmp",
      readTimelinePage: async () => {
        throw new Error("io");
      },
    });
    expect(ctx?.contextBundle).toBe("");
    expect(ctx?.pageLabel).toBe("Timeline");
  });
});

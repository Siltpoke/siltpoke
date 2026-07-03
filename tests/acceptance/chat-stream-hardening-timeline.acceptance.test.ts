/**
 * chat-stream-hardening-timeline.acceptance.test.ts — ACCEPTANCE tests for
 * chat-stream-hardening.
 *
 *
 * SCOPE — Timeline Load-older pagination:
 *   With >200 telemetry rows dated today —
 *     (a) /timeline shows the newest window plus a "Load older" control
 *         whenever more range-passing rows exist beyond the window;
 *     (b) activating it (preserving all active filters) shows the next-older
 *         window — reaching rows from days before today;
 *     (c) the today range never shows rows from other days;
 *     (d) a window that exhausts the range shows no Load-older control.
 *   The filter-contextual totals (`N turns · tokens · $`) reflect the
 *     same corrected (visible, filtered) set the list shows.
 *
 * ACCEPTANCE BOUNDARY — outside-observable behavior only:
 *   • Fixture telemetry is written directly to disk (brain-calls.jsonl in a
 *     temp ~/.siltpoke) — no internal writer function is used.
 *   • Behavior is observed at the ROUTE level: an in-process Hono app with
 *     the REAL mountTimelineRoutes (same pattern as
 *     chat-stream-hardening-xp-badge.acceptance.test.ts), asserting on the
 *     returned HTML only.
 *   • "Activating the Load-older control" = literally extracting the
 *     anchor's href from the rendered HTML and issuing the GET it points to.
 *
 * Anti-vacuous discipline:
 *   • Every presence assertion (row keys, control) is paired with absence
 *     assertions for what a wrong window would show (older-page keys on
 *     page 1, other-day keys under range=today, out-of-range keys under 7d).
 *   • The Load-older control is asserted PRESENT when range-passing rows
 *     remain and ABSENT in three distinct exhaustion shapes: below-limit
 *     file, page-2 exhaustion, and the sharp edge of an EXACTLY-full window
 *     whose only older rows are out of range (a lazy `hasMore = window.length
 *     === limit` fails that one).
 *   • Summary strings are hardcoded expectations computed by hand from
 *     the fixture (15 tok / $0.001 per row), never recomputed via the
 *     implementation's own formatters; each is paired with an absence check
 *     for the raw-window totals a wrong (unfiltered) sum would show.
 *
 * Run: bun test tests/acceptance/chat-stream-hardening-timeline.acceptance.test.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountTimelineRoutes } from "../../src/web/routes/timeline";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// ── Time base (same UTC-day convention the route's range=today uses) ─────────

const NOW_MS = Date.now();
const START_OF_TODAY_MS = (() => {
  const d = new Date(NOW_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
})();
const iso = (ms: number): string => new Date(ms).toISOString();

// ── Fixture builders ──────────────────────────────────────────────────────────

/**
 * One FIRED brain-calls.jsonl line. Every fired row carries the same usage
 * (10 in + 5 out + 0 cache = 15 tok, $0.001) so expected summary totals are
 * exact hand multiples of the visible row count.
 */
function firedLine(opts: {
  ms: number;
  sid: string;
  bubble: string;
  severity?: string;
}): string {
  return JSON.stringify({
    timestamp: iso(opts.ms),
    session_id: opts.sid,
    cwd: "/tmp/proj",
    brain_output: {
      bubble_short: opts.bubble,
      bubble_long: `${opts.bubble} (long)`,
      severity: opts.severity ?? "low",
      confidence: "high",
      evidence: [],
    },
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      total_cost_usd: 0.001,
    },
  });
}

function makeHome(tag: string, lines: string[]): string {
  const tmpHome = mkdtempSync(join(tmpdir(), `sp-acc-${tag}-`));
  tempDirs.push(tmpHome);
  const homeBase = join(tmpHome, ".siltpoke");
  mkdirSync(homeBase, { recursive: true });
  writeFileSync(join(homeBase, "brain-calls.jsonl"), `${lines.join("\n")}\n`, "utf8");
  return homeBase;
}

/**
 * Setup A — the main multiday corpus (chronological append order, 260 rows):
 *   • 20 rows 10 days ago  (s-10d-*)  — beyond the 7d range
 *   • 30 rows 2 days ago   (s-2d-*)   — within 7d, before today
 *   • 10 rows today, early (s-early-*): all bubbles contain "earlybird";
 *       k<6 additionally contain "zebra" with severity medium (kind=warning)
 *   • 200 rows today, late (s-late-*): the newest window; j<5 severity high
 *       (kind=critical), rest low (kind=comment)
 * Today total = 210 (>200), so the newest window always leaves today rows
 * beyond it.
 */
function setupA(): string {
  const lines: string[] = [];
  for (let k = 0; k < 20; k++) {
    lines.push(
      firedLine({ ms: NOW_MS - 10 * 864e5 + k, sid: `s-10d-${k}`, bubble: `ancient row ${k}` }),
    );
  }
  for (let k = 0; k < 30; k++) {
    lines.push(
      firedLine({ ms: NOW_MS - 2 * 864e5 + k, sid: `s-2d-${k}`, bubble: `middleaged row ${k}` }),
    );
  }
  for (let k = 0; k < 10; k++) {
    lines.push(
      firedLine({
        ms: START_OF_TODAY_MS + k,
        sid: `s-early-${k}`,
        bubble: k < 6 ? `zebra earlybird ${k}` : `earlybird ${k}`,
        severity: k < 6 ? "medium" : "low",
      }),
    );
  }
  for (let j = 0; j < 200; j++) {
    lines.push(
      firedLine({
        ms: START_OF_TODAY_MS + 1000 + j,
        sid: `s-late-${j}`,
        bubble: `plain row ${j}`,
        severity: j < 5 ? "high" : "low",
      }),
    );
  }
  return makeHome("multiday", lines);
}

/** Oldest row of setup A's newest window (late j=180 at limit 20) — the expected `before` anchor. */
const WINDOW_OLDEST_ISO = iso(START_OF_TODAY_MS + 1180);

// ── Route-level helpers (outside-observable surface only) ─────────────────────

async function getTimeline(homeBase: string, path: string): Promise<string> {
  const app = new Hono();
  mountTimelineRoutes(app, { homeBase });
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return res.text();
}

/** Rail list rows: `class="tl-row"` is emitted ONLY by fired rail rows. */
function railRowCount(html: string): number {
  return (html.match(/class="tl-row"/g) ?? []).length;
}

/** The Load-older anchor's href, HTML-entity-decoded; null when absent. */
function loadOlderHref(html: string): string | null {
  const m = html.match(/class="tl-load-older"[^>]*href="([^"]+)"/);
  return m?.[1] ? m[1].replace(/&amp;/g, "&") : null;
}

/** Query params of an href as a plain object (sorted, decoded). */
function hrefParams(href: string): Record<string, string> {
  const qs = href.split("?")[1] ?? "";
  return Object.fromEntries(new URLSearchParams(qs).entries());
}

/** The header summary line text: `N turns · X tok · $Y · a acked / d dismissed`. */
function summaryText(html: string): string {
  const m = html.match(/class="tl-summary"[^>]*>([^<]*)</);
  expect(m).not.toBeNull();
  return (m?.[1] ?? "").trim();
}

function keyPresent(html: string, sid: string, ms: number): boolean {
  return html.includes(`data-turn-key="${iso(ms)}|${sid}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// newest window + Load-older control when range-passing rows remain
// ─────────────────────────────────────────────────────────────────────────────

describe("newest window + Load-older control presence", () => {
  test(">20 today rows under range=today — page 1 is exactly the newest 20 today rows, and the Load-older control is present with before=<oldest window row> preserving range+status", async () => {
    const home = setupA();
    const html = await getTimeline(home, "/timeline?range=today");

    // The newest window: exactly 20 rail rows.
    expect(railRowCount(html)).toBe(20);
    // Newest and oldest rows OF THE WINDOW are present…
    expect(keyPresent(html, "s-late-199", START_OF_TODAY_MS + 1199)).toBe(true);
    expect(keyPresent(html, "s-late-180", START_OF_TODAY_MS + 1180)).toBe(true);
    // …while today rows BEYOND the window are not (they belong to page 2)…
    expect(keyPresent(html, "s-late-179", START_OF_TODAY_MS + 1179)).toBe(false);
    expect(keyPresent(html, "s-early-9", START_OF_TODAY_MS + 9)).toBe(false);
    // …and no other-day rows leak in (page 1).
    expect(html).not.toContain("|s-2d-");
    expect(html).not.toContain("|s-10d-");

    // The control exists and its href carries the active filters + anchor.
    const href = loadOlderHref(html);
    expect(href).not.toBeNull();
    expect(href?.startsWith("/timeline?")).toBe(true);
    expect(hrefParams(href as string)).toEqual({
      status: "fired", // default status, emitted explicitly
      range: "today",
      before: WINDOW_OLDEST_ISO, // exclusive bound = oldest row of the window
    });
  });

  test("control pairing: a file smaller than one window shows NO Load-older control", async () => {
    const home = makeHome(
      "small",
      Array.from({ length: 5 }, (_, k) =>
        firedLine({ ms: START_OF_TODAY_MS + k, sid: `s-small-${k}`, bubble: `small row ${k}` }),
      ),
    );
    const html = await getTimeline(home, "/timeline?range=today");
    expect(railRowCount(html)).toBe(5);
    expect(loadOlderHref(html)).toBeNull();
    expect(html).not.toContain("tl-load-older");
  });

  test("sharp edge: an EXACTLY-full window whose only older rows are OUT of range shows no control — hasMore must mean range-passing, not merely window-full", async () => {
    // 30 yesterday rows, then exactly 20 today rows (one full window).
    const lines: string[] = [];
    for (let k = 0; k < 30; k++) {
      lines.push(
        firedLine({
          ms: START_OF_TODAY_MS - 3_600_000 + k,
          sid: `s-yd-${k}`,
          bubble: `yesterday row ${k}`,
        }),
      );
    }
    for (let j = 0; j < 20; j++) {
      lines.push(
        firedLine({ ms: START_OF_TODAY_MS + 1000 + j, sid: `s-td-${j}`, bubble: `today row ${j}` }),
      );
    }
    const home = makeHome("exact-full", lines);

    const html = await getTimeline(home, "/timeline?range=today");
    expect(railRowCount(html)).toBe(20); // window really is full
    expect(html).not.toContain("|s-yd-"); // no other-day rows
    // The range is exhausted despite a full window: no control.
    expect(loadOlderHref(html)).toBeNull();
    expect(html).not.toContain("tl-load-older");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// activating the control (GET its href) reaches days before today
// ─────────────────────────────────────────────────────────────────────────────

describe("following the Load-older href shows the next-older window", () => {
  test("under range=7d, following the Load-older chain crosses the day boundary (reaches rows from days before today), never leaks rows beyond 7d, preserves the filter every hop, visits each row once, and terminates", async () => {
    // At limit 20 the 240-row 7d range spans many windows, so the day
    // boundary is crossed several hops in (not on page 2). "Activating the
    // control" = issuing the GET the anchor points to; we follow the whole
    // chain and assert the properties over the walk.
    const home = setupA();
    let path: string | null = "/timeline?range=7d";
    const seen = new Set<string>();
    let sawEarly = false;
    let sawTwoDay = false;
    let hops = 0;
    let terminated = false;
    for (; hops <= 30; hops++) {
      expect(hops).toBeLessThan(30); // must terminate well before the guard
      const html = await getTimeline(home, path);
      expect(railRowCount(html)).toBeLessThanOrEqual(20);
      // Rows beyond the 7d range never appear on any page.
      expect(html).not.toContain("|s-10d-");
      // Dedupe within the page first (a fired row's key appears in both its
      // rail row and its detail pane), then assert exclusivity across hops.
      const pageKeys = new Set(
        [...html.matchAll(/data-turn-key="([^"]+)"/g)].map((m) => m[1] as string),
      );
      for (const key of pageKeys) {
        // Exclusive cursors: no row is ever shown twice across the walk.
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      if (html.includes("|s-early-")) sawEarly = true;
      if (html.includes("|s-2d-")) sawTwoDay = true;
      const href = loadOlderHref(html);
      if (href === null) {
        terminated = true;
        break;
      }
      expect(hrefParams(href).range).toBe("7d"); // filter preserved each hop
      path = href;
    }
    // The chain reached today's early overflow AND rows from days before today.
    expect(sawEarly).toBe(true);
    expect(sawTwoDay).toBe(true);
    expect([...seen].some((k) => k.endsWith("|s-2d-29"))).toBe(true);
    expect([...seen].some((k) => k.endsWith("|s-2d-0"))).toBe(true);
    // Every 7d-passing row (240 = 10 early + 30 two-days-ago + 200 late)
    // reached exactly once, and the chain ends without a control.
    expect(seen.size).toBe(240);
    expect(terminated).toBe(true);
  });

  test("superseded by predicate windows: filters that match only rows BEYOND the old raw window now surface them on PAGE 1 — no pagination detour, single page, no pager", async () => {
    // DELIBERATE REWRITE (timeline true-pagination): the original test
    // walked Load-older through an all-hidden raw window to reach the 6
    // zebra+warning rows. The window now collects predicate-passing rows
    // directly, so those 6 rows ARE page 1; a window can no longer be
    // "hidden" by its own filters and the detour it tested cannot occur.
    const home = setupA();
    const page1 = await getTimeline(home, "/timeline?range=7d&kind=warning&q=zebra&sort=oldest");
    expect(railRowCount(page1)).toBe(6);
    for (let k = 0; k < 6; k++) {
      expect(keyPresent(page1, `s-early-${k}`, START_OF_TODAY_MS + k)).toBe(true);
    }
    // Non-zebra early rows and 2d rows are filtered out; 10d out of range.
    expect(keyPresent(page1, "s-early-6", START_OF_TODAY_MS + 6)).toBe(false);
    expect(page1).not.toContain("|s-2d-");
    expect(page1).not.toContain("|s-10d-");
    // 6 matches < limit → the whole result is one page: no pager either way.
    expect(loadOlderHref(page1)).toBeNull();
    expect(page1).not.toContain("tl-load-newer");
  });

  test("honesty edge: the Load-older chain TERMINATES — following hrefs from range=all visits every row exactly once and ends without a control", async () => {
    const home = setupA();
    const GUARD = 20;
    const pageCounts: number[] = [];
    const seenKeys = new Set<string>();
    const hrefsFollowed = new Set<string>();

    let path = "/timeline"; // range=all, default status=fired
    for (let hop = 0; hop <= GUARD; hop++) {
      expect(hop).toBeLessThan(GUARD); // must terminate well before the guard
      const html = await getTimeline(home, path);
      pageCounts.push(railRowCount(html));
      for (const m of html.matchAll(/data-turn-key="([^"]+)"/g)) {
        seenKeys.add(m[1] as string);
      }
      const next = loadOlderHref(html);
      if (next === null) break;
      // A repeated href would loop forever — fail loudly instead.
      expect(hrefsFollowed.has(next)).toBe(false);
      hrefsFollowed.add(next);
      path = next;
    }

    // 260 rows in exactly 13 windows of 20 (260 / 20 = 13).
    expect(pageCounts).toEqual(Array.from({ length: 13 }, () => 20));
    expect(seenKeys.size).toBe(260); // every row reached exactly once, no gaps
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// summary totals reflect the same visible, filtered set the list shows
// ─────────────────────────────────────────────────────────────────────────────

describe("filter-contextual totals match the visible set", () => {
  // Every fired fixture row is 15 tok / $0.001 — expected strings are hand
  // computed: N rows → N turns · 15N tok · $0.001N.

  test("full newest window (range=7d) — summary leads with the 240-row range total + showing 20, page sums 300 tok · $0.02", async () => {
    // DELIBERATE UPDATE (timeline true-pagination): honest totals — the
    // 7d range holds 240 turns (10 early + 30 two-days-ago + 200 late), the
    // page shows 20; tokens/$ stay contextual to the visible page.
    const home = setupA();
    const html = await getTimeline(home, "/timeline?range=7d");
    expect(summaryText(html)).toBe(
      "240 turns in range · showing 20 · 300 tok · $0.02 · 0 acked / 0 dismissed",
    );
    expect(railRowCount(html)).toBe(20); // list and page totals describe the same set
  });

  test("a kind filter shrinks the visible set — summary counts ONLY the 5 visible critical rows (75 tok · $0.0050), not the 200-row raw window", async () => {
    const home = setupA();
    const html = await getTimeline(home, "/timeline?range=7d&kind=critical");
    expect(railRowCount(html)).toBe(5);
    expect(summaryText(html)).toBe("5 turns · 75 tok · $0.0050 · 0 acked / 0 dismissed");
    // The raw-window totals must NOT appear anywhere in the summary.
    expect(html).not.toContain("200 turns");
    expect(html).not.toContain("3.0k tok");
  });

  test("on the terminal Load-older page (range=today) the summary reflects THAT page's visible set — 10 turns · 150 tok · $0.01", async () => {
    // At limit 20 today's 210 rows span 11 windows; the oldest (terminal)
    // window is a partial page of 10. Walk older to it and assert its
    // summary describes that page's visible set.
    const home = setupA();
    let path: string | null = "/timeline?range=today";
    let last = "";
    let hops = 0;
    for (; hops <= 30; hops++) {
      expect(hops).toBeLessThan(30);
      last = await getTimeline(home, path);
      const href = loadOlderHref(last);
      if (href === null) break;
      path = href;
    }
    expect(railRowCount(last)).toBe(10);
    // Cross-check: today's terminal page still shows no other-day rows.
    expect(last).not.toContain("|s-2d-");
    expect(last).not.toContain("|s-yd-");
    // DELIBERATE UPDATE (timeline true-pagination): the range total
    // (210 today turns) leads; tok/$ still sum the visible 10 rows.
    expect(summaryText(last)).toBe(
      "210 turns in range · showing 10 · 150 tok · $0.01 · 0 acked / 0 dismissed",
    );
    expect(last).not.toContain("200 turns"); // not an earlier page's totals
    // The terminal page exhausts today: no further OLDER control.
    expect(loadOlderHref(last)).toBeNull();
  });
});

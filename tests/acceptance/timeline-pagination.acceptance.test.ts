/**
 * timeline-pagination.acceptance.test.ts — ACCEPTANCE tests for the
 * timeline true-pagination fast-follow.
 *
 * (contingencies are the oracle).
 *
 * FIXTURE SHAPE — mirrors the live store's pathology: display-eligible
 * turns spread across months, drowned in gate-skip rows, with a PURE-SKIP
 * tail (the newest lines are almost all skips). A line-counted window over
 * this store shows ~0 turns; a turn-counted window must show 200.
 *
 *   • 60 fired ~45 days ago  (s-old-*)  + 120 interleaved skips
 *   • 100 fired ~10 days ago (s-mid-*)  + 400 interleaved skips
 *   • 100 fired ~6 hours ago (s-rec-*)  + 300 interleaved skips
 *   • 1,500 pure gate-skip rows at the tail (newest lines)
 *   = 260 display-eligible turns among 2,580 lines (~90% skips).
 *
 * ACCEPTANCE BOUNDARY — outside-observable behavior only: fixture JSONL
 * written straight to disk; behavior observed at the ROUTE level through
 * the real mountTimelineRoutes; "activating a pager anchor" = extracting
 * its href from the HTML and issuing the GET it points to.
 *
 * Anti-vacuous discipline: every presence assertion is paired with the
 * absence a wrong window would show (page-2 keys on page 1, skip rows under
 * status=fired, raw-window totals in the summary); summary strings are hand
 * computed from the fixture (15 tok / $0.001 per fired row), never via the
 * implementation's formatters.
 *
 * Run: bun test tests/acceptance/timeline-pagination.acceptance.test.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { readCriticTelemetry } from "../../src/state/critic-event-log";
import { mountTimelineRoutes } from "../../src/web/routes/timeline";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// ── Time base ─────────────────────────────────────────────────────────────────

const NOW_MS = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();

const OLD_BASE = NOW_MS - 45 * 864e5;
const MID_BASE = NOW_MS - 10 * 864e5;
const REC_BASE = NOW_MS - 6 * 3600e3;
const TAIL_BASE = NOW_MS - 3600e3;

const oldMs = (k: number) => OLD_BASE + k * 1000;
const midMs = (k: number) => MID_BASE + k * 1000;
const recMs = (k: number) => REC_BASE + k * 1000;

// ── Fixture builders ──────────────────────────────────────────────────────────

/** One FIRED line: 10 in + 5 out = 15 tok, $0.001 — hand-computable sums. */
function firedLine(ms: number, sid: string, bubble: string): string {
  return JSON.stringify({
    timestamp: iso(ms),
    session_id: sid,
    cwd: "/tmp/proj-tp",
    brain_output: {
      bubble_short: bubble,
      bubble_long: `${bubble} (long)`,
      severity: "low",
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

/** One gate-skip line — same key shape the live gate writes (no `kind`). */
function skipLine(ms: number, sid: string): string {
  return JSON.stringify({
    timestamp: iso(ms),
    session_id: sid,
    cwd: "/tmp/proj-tp",
    skipped: "soft_budget_on_demand",
    used_pct: 87.2,
    degraded: false,
  });
}

/** The skip-flooded multiday corpus described in the header. */
function floodedFixture(): string[] {
  const lines: string[] = [];
  for (let k = 0; k < 60; k++) {
    lines.push(firedLine(oldMs(k), `s-old-${k}`, `vintage turn ${k}`));
    lines.push(skipLine(oldMs(k) + 200, `sk-old-${k}a`));
    lines.push(skipLine(oldMs(k) + 400, `sk-old-${k}b`));
  }
  for (let k = 0; k < 100; k++) {
    lines.push(firedLine(midMs(k), `s-mid-${k}`, `mid turn ${k}`));
    for (const off of [200, 400, 600, 800]) {
      lines.push(skipLine(midMs(k) + off, `sk-mid-${k}-${off}`));
    }
  }
  for (let k = 0; k < 100; k++) {
    lines.push(firedLine(recMs(k), `s-rec-${k}`, `recent turn ${k}`));
    for (const off of [200, 400, 600]) {
      lines.push(skipLine(recMs(k) + off, `sk-rec-${k}-${off}`));
    }
  }
  for (let i = 0; i < 1500; i++) {
    lines.push(skipLine(TAIL_BASE + i * 2000, `sk-tail-${i}`));
  }
  return lines;
}

const TOTAL_SKIPS = 120 + 400 + 300 + 1500; // 2,320

function makeHome(tag: string, lines: string[]): string {
  const tmpHome = mkdtempSync(join(tmpdir(), `sp-acc-tp-${tag}-`));
  tempDirs.push(tmpHome);
  const homeBase = join(tmpHome, ".siltpoke");
  mkdirSync(homeBase, { recursive: true });
  writeFileSync(join(homeBase, "brain-calls.jsonl"), `${lines.join("\n")}\n`, "utf8");
  return homeBase;
}

// ── Route-level helpers (outside-observable surface only) ─────────────────────

async function getTimeline(homeBase: string, path: string): Promise<string> {
  const app = new Hono();
  mountTimelineRoutes(app, { homeBase });
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return res.text();
}

/** Fired rail rows only (`class="tl-row"` is emitted only for fired rows). */
function railRowCount(html: string): number {
  return (html.match(/class="tl-row"/g) ?? []).length;
}

/**
 * All rail rows (fired + flat skipped) carry data-turn-key; fired turns
 * ALSO get a detail pane with the same attribute — subtract those.
 */
function allRowCount(html: string): number {
  const keys = (html.match(/data-turn-key="/g) ?? []).length;
  const panes = (html.match(/class="tl-detail-pane"/g) ?? []).length;
  return keys - panes;
}

function anchorHref(html: string, cls: "tl-load-older" | "tl-load-newer"): string | null {
  const m = html.match(new RegExp(`class="${cls}"[^>]*href="([^"]+)"`));
  return m?.[1] ? m[1].replace(/&amp;/g, "&") : null;
}

function hrefParams(href: string): Record<string, string> {
  const qs = href.split("?")[1] ?? "";
  return Object.fromEntries(new URLSearchParams(qs).entries());
}

function summaryText(html: string): string {
  const m = html.match(/class="tl-summary"[^>]*>([^<]*)</);
  expect(m).not.toBeNull();
  return (m?.[1] ?? "").trim();
}

function keyPresent(html: string, sid: string, ms: number): boolean {
  return html.includes(`data-turn-key="${iso(ms)}|${sid}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The window counts turns, not lines
// ─────────────────────────────────────────────────────────────────────────────

describe("window counts display-eligible turns, never lines", () => {
  test("default view over the flooded store shows exactly 20 real turns — the 1,500-skip tail consumes zero window slots", async () => {
    const home = makeHome("ac1", floodedFixture());
    const html = await getTimeline(home, "/timeline"); // default status=fired, range=all

    // 20 fired rows despite the newest ~1,500 lines being pure skips.
    expect(railRowCount(html)).toBe(20);
    expect(allRowCount(html)).toBe(20); // no skip row leaked into the rail
    // Newest 20 turns = rec 80..99; the window's oldest row is rec-80…
    expect(keyPresent(html, "s-rec-99", recMs(99))).toBe(true);
    expect(keyPresent(html, "s-rec-80", recMs(80))).toBe(true);
    // …and the mid/old blocks belong to later pages (a line window would
    // never even reach mid rows).
    expect(html).not.toContain("|s-mid-");
    expect(html).not.toContain("|s-old-");
    expect(html).not.toContain("|sk-"); // skips invisible under status=fired

    // Older anchor: exclusive bound = the page's oldest TURN, filters kept.
    const href = anchorHref(html, "tl-load-older");
    expect(href).not.toBeNull();
    expect(hrefParams(href as string)).toEqual({
      status: "fired",
      before: iso(recMs(80)),
    });
    // Newest edge: nothing newer — no newer anchor (no-dead-end shape).
    expect(html).not.toContain("tl-load-newer");
  });

  test("in-scan predicate: a q filter whose matches all sit BEYOND the naive tail window finds them on page 1", async () => {
    const home = makeHome("ac1q", floodedFixture());
    const html = await getTimeline(home, "/timeline?q=vintage");
    // The predicate finds the buried vintage rows (all 60 sit past the naive
    // tail window). At limit 20 they page: page 1 = the newest 20 vintage.
    expect(railRowCount(html)).toBe(20);
    expect(keyPresent(html, "s-old-59", oldMs(59))).toBe(true); // newest vintage
    expect(keyPresent(html, "s-old-40", oldMs(40))).toBe(true); // window's oldest
    expect(keyPresent(html, "s-old-39", oldMs(39))).toBe(false); // belongs to page 2
    expect(html).not.toContain("|s-mid-"); // mid never matches q=vintage
    // 60 vintage matches > limit 20 → paged: older control present, and the
    // newest edge means no newer control.
    expect(html).toContain("tl-load-older");
    expect(html).not.toContain("tl-load-newer");
    // Range total leads; tok/$ follow the visible 20-row page.
    expect(summaryText(html)).toBe(
      "60 turns in range · showing 20 · 300 tok · $0.02 · 0 acked / 0 dismissed",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bidirectional cursors, no dead ends, chains terminate
// ─────────────────────────────────────────────────────────────────────────────

describe("bidirectional cursors", () => {
  test("older reaches the vintage page (with a way back); newer returns to the newest window; both directions preserve filters", async () => {
    // At limit 20 the 260-turn store spans 13 windows, so "reaching the
    // vintage page" and "returning to the newest window" are multi-hop
    // walks. Every hop preserves the filter; cursors are exclusive so no
    // row is seen twice going older.
    const home = makeHome("ac2", floodedFixture());

    // Walk older to the oldest edge.
    let path: string | null = "/timeline";
    const seenOlder = new Set<string>();
    let oldestPage = "";
    let hops = 0;
    for (; hops <= 30; hops++) {
      expect(hops).toBeLessThan(30);
      oldestPage = await getTimeline(home, path);
      const pageKeys = new Set(
        [...oldestPage.matchAll(/data-turn-key="([^"]+)"/g)].map((m) => m[1] as string),
      );
      for (const k of pageKeys) {
        expect(seenOlder.has(k)).toBe(false); // exclusive cursors — no overlap
        seenOlder.add(k);
      }
      const href = anchorHref(oldestPage, "tl-load-older");
      if (href === null) break;
      expect(hrefParams(href).status).toBe("fired"); // filter preserved older-ward
      path = href;
    }
    // Oldest edge = the vintage page: every fired turn reached once, no gaps.
    expect([...seenOlder].some((k) => k.endsWith("|s-old-0"))).toBe(true);
    expect(seenOlder.size).toBe(260);
    // No further older, but a way BACK (newer) preserving the filter.
    expect(oldestPage).not.toContain("tl-load-older");
    const backHref = anchorHref(oldestPage, "tl-load-newer");
    expect(backHref).not.toBeNull();
    expect(hrefParams(backHref as string).status).toBe("fired");

    // Walk newer back to the newest edge.
    path = backHref;
    let newestPage = oldestPage;
    hops = 0;
    for (; hops <= 30; hops++) {
      expect(hops).toBeLessThan(30);
      if (path === null) break;
      newestPage = await getTimeline(home, path);
      const href = anchorHref(newestPage, "tl-load-newer");
      if (href === null) break;
      expect(hrefParams(href).status).toBe("fired"); // filter preserved newer-ward
      path = href;
    }
    // Newest edge = the newest window: reaches rec-99, no dead end (no further
    // newer, older anchor back).
    expect(keyPresent(newestPage, "s-rec-99", recMs(99))).toBe(true);
    expect(newestPage).not.toContain("tl-load-newer");
    expect(anchorHref(newestPage, "tl-load-older")).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Honest totals
// ─────────────────────────────────────────────────────────────────────────────

describe("honest totals in the summary line", () => {
  test("summary leads with the 260-turn range total + page count; tok/$ stay per-visible-page on both pages", async () => {
    const home = makeHome("ac3", floodedFixture());
    const page1 = await getTimeline(home, "/timeline");
    // 20 visible × 15 tok / $0.001 — NOT the 260-row range sums.
    expect(summaryText(page1)).toBe(
      "260 turns in range · showing 20 · 300 tok · $0.02 · 0 acked / 0 dismissed",
    );

    const page2 = await getTimeline(home, anchorHref(page1, "tl-load-older") as string);
    expect(summaryText(page2)).toBe(
      "260 turns in range · showing 20 · 300 tok · $0.02 · 0 acked / 0 dismissed",
    );
  });

  test("thousands separators live: status=skipped totals count every gate-skip row in range", async () => {
    const home = makeHome("ac3sk", floodedFixture());
    const html = await getTimeline(home, "/timeline?status=skipped");
    // Contingency: under status=skipped, skip rows ARE the display rows —
    // they fill the window and the total counts all 2,320 of them.
    expect(allRowCount(html)).toBe(20);
    expect(railRowCount(html)).toBe(0); // none selectable (all skipped)
    expect(summaryText(html)).toBe(
      `${TOTAL_SKIPS.toLocaleString("en-US")} turns in range · showing 20 · 0 tok · $0.00 · 0 acked / 0 dismissed`,
    );
    expect(anchorHref(html, "tl-load-older")).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sort anchors the window
// ─────────────────────────────────────────────────────────────────────────────

describe("sort anchors the first page", () => {
  test("sort=oldest anchors at the range's oldest end, renders chronologically, and pages toward newer", async () => {
    const home = makeHome("ac4", floodedFixture());
    const html = await getTimeline(home, "/timeline?sort=oldest");

    // Oldest 20 turns: old 0..19.
    expect(railRowCount(html)).toBe(20);
    expect(keyPresent(html, "s-old-0", oldMs(0))).toBe(true);
    expect(keyPresent(html, "s-old-19", oldMs(19))).toBe(true);
    expect(keyPresent(html, "s-old-20", oldMs(20))).toBe(false); // belongs to page 2
    // Chronological render: the FIRST rail row is the oldest turn.
    const firstKey = html.match(/data-turn-key="([^"]+)"/)?.[1] ?? "";
    expect(firstKey).toBe(`${iso(oldMs(0))}|s-old-0`);

    // Paging direction from the oldest anchor is toward NEWER only.
    expect(html).not.toContain("tl-load-older");
    const newerHref = anchorHref(html, "tl-load-newer");
    expect(newerHref).not.toBeNull();
    expect(hrefParams(newerHref as string)).toEqual({
      status: "fired",
      sort: "oldest",
      after: iso(oldMs(19)),
    });

    // Walk newer to the newest edge: the chain reaches the newest turns and
    // terminates (no further newer, older anchor back).
    let path: string | null = newerHref;
    let last = html;
    let hops = 0;
    for (; hops <= 30; hops++) {
      expect(hops).toBeLessThan(30);
      if (path === null) break;
      last = await getTimeline(home, path);
      const href = anchorHref(last, "tl-load-newer");
      if (href === null) break;
      expect(hrefParams(href).sort).toBe("oldest"); // filter preserved newer-ward
      path = href;
    }
    expect(keyPresent(last, "s-rec-99", recMs(99))).toBe(true);
    expect(last).not.toContain("tl-load-newer");
    expect(anchorHref(last, "tl-load-older")).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression floor
// ─────────────────────────────────────────────────────────────────────────────

describe("regression floor", () => {
  test("the no-bounds module caller (Home feed shape) keeps LINE-window semantics over the same flooded store — last 200 lines, all skips", async () => {
    // The Home feed's exact call shape: no range/before/after/windowMode.
    // Over the skip-flooded store the legacy tail window is the 200 newest
    // LINES (all tail skips) — proof the turn-counted window did not leak
    // into the legacy path. (Row-level byte-identity vs the tail-limit
    // reference is unit-tested in tests/state/critic-event-log.test.ts.)
    const home = makeHome("ac5", floodedFixture());
    const t = await readCriticTelemetry(home, new Date(), { limit: 200 });
    expect(t.recent.length).toBe(200);
    expect(t.recent.every((c) => c.status === "skipped")).toBe(true);
    expect(t.recent[0]?.session_id).toBe("sk-tail-1499");
    // Turn-window fields stay inert on the legacy path.
    expect(t.totalInRange).toBeNull();
    expect(t.hasNewer).toBe(false);
    expect(t.windowNewestTs).toBeNull();
  });

  test("/timeline default view = newest window, ≤20 real turns, older control present when more exist", async () => {
    const home = makeHome("ac5r", floodedFixture());
    const html = await getTimeline(home, "/timeline");
    expect(railRowCount(html)).toBe(20);
    expect(anchorHref(html, "tl-load-older")).not.toBeNull();

    // And with fewer turns than one window: single page, no pager.
    const small = makeHome(
      "ac5s",
      Array.from({ length: 3 }, (_, k) => firedLine(recMs(k), `s-few-${k}`, `few turn ${k}`)),
    );
    const smallHtml = await getTimeline(small, "/timeline");
    expect(railRowCount(smallHtml)).toBe(3);
    expect(smallHtml).not.toContain("tl-load-older");
    expect(smallHtml).not.toContain("tl-load-newer");
    expect(summaryText(smallHtml)).toBe("3 turns · 45 tok · $0.0030 · 0 acked / 0 dismissed");
  });
});

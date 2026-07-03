/**
 * /timeline route + screen SSR tests.
 *
 * Mounts mountTimelineRoutes on a bare Hono app over a tmp homeBase seeded
 * with brain-calls.jsonl fixtures (same fixture shape as
 * tests/state/critic-event-log.test.ts) and asserts against the SSR HTML:
 *
 *   - master/detail: rail rows + per-fired-turn embedded detail panes,
 *     newest fired turn pre-selected (visible without hydration),
 *     older panes x-cloak'd; row-select is Alpine state, no reload.
 *   - filter parity with /history: same query params, same defaults
 *     (status omitted → fired), composition, chips point at /timeline.
 *   - contextual summary line from telemetry.totals + actionStats.
 *   - Critic tab content: user raw query + honesty-labeled agent reply
 *     (v2 sidecar) + critique body + gate context.
 *
 * Tab suites (Diff / Trace / Feedback) live in
 * timeline-tabs.test.ts; shared fixtures in timeline-fixtures.ts.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { mountCriticRoutes } from "../../../src/web/routes/critic";
import { mountTimelineRoutes } from "../../../src/web/routes/timeline";
import { mountTraceWebRoutes } from "../../../src/web/routes/traces";
import { AGENT_REPLY_LABEL } from "../../../src/web/screens/timeline/detail-pane";
import { fmtCost, fmtTokens } from "../../../src/web/screens/timeline/format";
import { type FixtureCall, writeFixture } from "./timeline-fixtures";

let homeBase: string;

beforeEach(async () => {
  homeBase = join(tmpdir(), `timeline-route-test-${randomUUID()}`);
  await mkdir(homeBase, { recursive: true });
});

function buildApp(): Hono {
  const app = new Hono();
  mountTimelineRoutes(app, { homeBase });
  return app;
}

async function getHtml(path: string): Promise<string> {
  const res = await buildApp().request(path);
  expect(res.status).toBe(200);
  return res.text();
}

describe("GET /timeline — shell", () => {
  test("renders the Timeline page with rail + dossier + tab shell", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", bubble_short: "older turn" },
      { ts: "2026-07-01T11:00:00Z", session: "s2", status: "fired", bubble_short: "newest turn" },
    ]);
    const html = await getHtml("/timeline");
    expect(html).toContain(">Timeline</h1>");
    expect(html).toContain("siltpoke · observability");
    // Tab shell: all four tabs present, all live (no stubs left).
    expect(html).toContain(">Critic</button>");
    expect(html).toContain(">Diff</button>");
    expect(html).toContain(">Trace</button>");
    expect(html).toContain(">Feedback</button>");
    expect(html).not.toContain("not yet wired");
  });

  test("empty store: zero summary + honest empty states (contingency)", async () => {
    const html = await getHtml("/timeline");
    expect(html).toContain("0 turns · 0 tok · $0.00 · 0 acked / 0 dismissed");
    expect(html).toContain("no turns match");
    expect(html).toContain("nothing here yet");
  });
});

describe("master/detail row select without reload", () => {
  test("newest fired turn is pre-selected; its pane is visible (no x-cloak), older panes are cloaked", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", bubble_short: "older turn" },
      { ts: "2026-07-01T11:00:00Z", session: "s2", status: "fired", bubble_short: "newest turn" },
    ]);
    const html = await getHtml("/timeline");
    // Same shape turnKey builds: `${timestamp}|${session_id}`.
    const newestKey = "2026-07-01T11:00:00Z|s2";
    const olderKey = "2026-07-01T10:00:00Z|s1";

    // Alpine root state pre-selects the newest fired row.
    expect(html).toContain(`selected: ${JSON.stringify(newestKey).replace(/"/g, "&quot;")}`);

    // Both detail panes are server-embedded (row click = state swap, no fetch).
    const paneRe = (key: string) =>
      new RegExp(`<div class="tl-detail-pane" data-turn-key="${key.replace("|", "\\|")}"([^>]*)>`);
    const newestPane = html.match(paneRe(newestKey))?.[0] ?? "";
    const olderPane = html.match(paneRe(olderKey))?.[0] ?? "";
    expect(newestPane).not.toBe("");
    expect(olderPane).not.toBe("");
    // Initially-selected pane is visible pre-hydration; others are cloaked.
    expect(newestPane).not.toContain("x-cloak");
    expect(olderPane).toContain("x-cloak");
  });

  test("rail rows carry the Alpine select handler for fired rows only", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired" },
      { ts: "2026-07-01T11:00:00Z", session: "s2", status: "skipped", skip_reason: "quiet_hours" },
    ]);
    const html = await getHtml("/timeline?status=all");
    // Fired rail row (class="tl-row") carries the select handler.
    const firedRow =
      html.match(/<div class="tl-row" data-turn-key="2026-07-01T10:00:00Z\|s1"[^>]*>/)?.[0] ?? "";
    expect(firedRow).not.toBe("");
    expect(firedRow).toContain("x-on:click");
    // Skipped row renders flat: present in the rail but with NO select handler.
    const skippedRow =
      html.match(/<div data-turn-key="2026-07-01T11:00:00Z\|s2"[^>]*>/)?.[0] ?? "";
    expect(skippedRow).not.toBe("");
    expect(skippedRow).not.toContain("x-on:click");
    expect(html).toContain("quiet_hours");
  });

  test("?sort=oldest pre-selects the FIRST row of the oldest-first order", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", bubble_short: "older turn" },
      { ts: "2026-07-01T11:00:00Z", session: "s2", status: "fired", bubble_short: "newest turn" },
    ]);
    const html = await getHtml("/timeline?sort=oldest");
    // Top of the sorted rail = the OLDEST turn; it is the pre-opened dossier.
    const oldestKey = "2026-07-01T10:00:00Z|s1";
    expect(html).toContain(`selected: ${JSON.stringify(oldestKey).replace(/"/g, "&quot;")}`);
    // And its pane is the one rendered visible (no x-cloak).
    const pane =
      html.match(/<div class="tl-detail-pane" data-turn-key="2026-07-01T10:00:00Z\|s1"[^>]*>/)?.[0] ?? "";
    expect(pane).not.toBe("");
    expect(pane).not.toContain("x-cloak");
  });

  test("skipped-only window shows honest no-fired-detail message", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T11:00:00Z", session: "s2", status: "skipped", skip_reason: "quiet_hours" },
    ]);
    const html = await getHtml("/timeline?status=skipped");
    expect(html).toContain("no fired turn in this window");
  });
});

describe("filter parity with /history", () => {
  test("default (no status param) hides skipped rows, same as /history", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", bubble_short: "fired row" },
      { ts: "2026-07-01T11:00:00Z", session: "s2", status: "skipped", skip_reason: "quiet_hours" },
    ]);
    const html = await getHtml("/timeline");
    expect(html).toContain("fired row");
    expect(html).not.toContain("quiet_hours");
    expect(html).toContain("1 turn ·");
  });

  test("status/kind/q compose (severity=high → critical kind + text query)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", severity: "high", bubble_short: "daemon wedges on hung call" },
      { ts: "2026-07-01T11:00:00Z", session: "s2", status: "fired", severity: "high", bubble_short: "another critical thing" },
      { ts: "2026-07-01T12:00:00Z", session: "s3", status: "fired", severity: "info", bubble_short: "daemon narrative comment" },
    ]);
    const html = await getHtml("/timeline?status=fired&kind=critical&q=daemon");
    expect(html).toContain("daemon wedges on hung call");
    expect(html).not.toContain("another critical thing");
    expect(html).not.toContain("daemon narrative comment");
    expect(html).toContain("1 turn ·");
  });

  test("filter chips point back at /timeline (not /history)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired" },
    ]);
    const html = await getHtml("/timeline");
    expect(html).toContain('href="/timeline?status=all"');
    expect(html).not.toContain('href="/history?');
  });

  test("chips preserve the active q filter (composition)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", bubble_short: "daemon thing" },
    ]);
    const html = await getHtml("/timeline?q=daemon");
    expect(html).toContain('href="/timeline?status=skipped&amp;q=daemon"');
  });

  test("search input renders INSIDE the filter row (same container as chips, before the project select)", async () => {
    // Design (2026-07-02 companion): ONE filter row — chips … [search][project],
    // search inline right-aligned, NOT a separate block floating on its own line.
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired" },
    ]);
    const html = await getHtml("/timeline");
    const barIdx = html.indexOf('class="critic-filter-bar tl-filter-row"');
    const searchIdx = html.indexOf('aria-label="search turns"');
    const selectIdx = html.indexOf('class="critic-project-select"');
    expect(barIdx).toBeGreaterThan(-1);
    expect(searchIdx).toBeGreaterThan(-1);
    expect(selectIdx).toBeGreaterThan(-1);
    // Search sits inside the filter bar, immediately before the project select.
    expect(searchIdx).toBeGreaterThan(barIdx);
    expect(searchIdx).toBeLessThan(selectIdx);
  });
});

describe("design fixup (2nd smoke) — compact filter row", () => {
  test("kind + range render as flat segments (4th smoke round), not selects or chip groups", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired" },
    ]);
    const html = await getHtml("/timeline");
    // Flat segments — every option visible, status-segment box style.
    const kindSeg = html.match(/<div class="tl-filter-seg" data-filter="kind"[\s\S]*?<\/div>/)?.[0] ?? "";
    const rangeSeg = html.match(/<div class="tl-filter-seg" data-filter="range"[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(kindSeg).not.toBe("");
    expect(rangeSeg).not.toBe("");
    expect((kindSeg.match(/data-group="kind"/g) ?? []).length).toBe(4);
    expect((rangeSeg.match(/data-group="range"/g) ?? []).length).toBe(4);
    expect(kindSeg).toContain(">all kinds<");
    expect(rangeSeg).toContain(">all time<");
    // No kind/range dropdowns; the old bordered chip block stays gone too.
    expect(html).not.toContain('<select class="tl-filter-select"');
    expect(html).not.toContain("critic-filter-chip");
    expect(html).not.toContain('data-group="sort"');
    expect(html).toContain('data-group="status"');
    // GET-navigate select mechanism now belongs to ProjectSelect alone.
    const navs = html.match(/location\.href=u\.toString\(\)/g) ?? [];
    expect(navs.length).toBe(1);
  });

  test("segments reflect the active filter state (data-active)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", severity: "medium", bubble_short: "warn row" },
    ]);
    const html = await getHtml("/timeline?kind=warning&range=7d");
    const warning = html.match(/<a[^>]*data-group="kind"[^>]*data-key="warning"[^>]*>/)?.[0] ?? "";
    const sevenD = html.match(/<a[^>]*data-group="range"[^>]*data-key="7d"[^>]*>/)?.[0] ?? "";
    expect(warning).toContain('data-active="true"');
    expect(sevenD).toContain('data-active="true"');
    // The segment defaults read inactive when an explicit value is chosen.
    const allKinds = html.match(/<a[^>]*data-group="kind"[^>]*data-key="all"[^>]*>/)?.[0] ?? "";
    expect(allKinds).toContain('data-active="false"');
  });

  test("kind segment hrefs preserve the other active filters", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", bubble_short: "daemon thing" },
    ]);
    const html = await getHtml("/timeline?q=daemon&range=7d");
    const comment = html.match(/<a[^>]*data-group="kind"[^>]*data-key="comment"[^>]*>/)?.[0] ?? "";
    expect(comment).toContain("kind=comment");
    expect(comment).toContain("q=daemon");
    expect(comment).toContain("range=7d");
  });

  test("kind/range hrefs from an explicit status=all keep status=all (no silent reset to fired)", async () => {
    // A null active status only ever comes from an
    // explicit ?status=all; a kind/range click from that state must carry
    // it forward — omitting the param re-defaults to fired server-side.
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired" },
    ]);
    const html = await getHtml("/timeline?status=all");
    const comment = html.match(/<a[^>]*data-group="kind"[^>]*data-key="comment"[^>]*>/)?.[0] ?? "";
    const today = html.match(/<a[^>]*data-group="range"[^>]*data-key="today"[^>]*>/)?.[0] ?? "";
    expect(comment).toContain("status=all");
    expect(today).toContain("status=all");
  });

  test("sort toggle moved OUT of the filter row into the rail header", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired" },
      { ts: "2026-07-01T11:00:00Z", session: "s2", status: "fired" },
    ]);
    const html = await getHtml("/timeline");
    // Rail header: `turns · N` + `↓ newest first` toggle (design's rail-top sort).
    expect(html).toContain("turns · 2");
    const sortLink = html.match(/<a class="tl-rail-sort"[^>]*>[^<]*</)?.[0] ?? "";
    expect(sortLink).not.toBe("");
    expect(sortLink).toContain("↓ newest first");
    expect(sortLink).toContain("sort=oldest");
    // Flipped state reads back + link flips to newest (default → param omitted).
    const flipped = await getHtml("/timeline?sort=oldest");
    const flippedLink = flipped.match(/<a class="tl-rail-sort"[^>]*>[^<]*</)?.[0] ?? "";
    expect(flippedLink).toContain("↑ oldest first");
    expect(flippedLink).not.toContain("sort=oldest");
  });
});

describe("design fixup (3rd smoke) — filter-row visual parity + errors facet", () => {
  test("status segment: ONE bordered container, 4 FLAT items (all/fired/skipped/errors), no per-item chip borders", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired" },
    ]);
    const html = await getHtml("/timeline");
    // ONE container: the seg div holds all 4 items (no nested divs inside).
    const seg = html.match(/<div class="tl-status-seg"[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(seg).not.toBe("");
    expect((seg.match(/data-group="status"/g) ?? []).length).toBe(4);
    expect(seg).toContain('data-key="errors"');
    expect(seg).toContain('href="/timeline?status=errors"');
    // Flat items — the shared bordered FilterChip is NOT used on this page.
    expect(html).not.toContain("critic-filter-chip");
    expect(seg).toContain("border:none");
    // Active item (default status=fired) = solid ink block, cream text.
    const fired = seg.match(/<a[^>]*data-key="fired"[^>]*>/)?.[0] ?? "";
    expect(fired).toContain('data-active="true"');
    expect(fired).toContain("#1f1b16");
    expect(fired).toContain("#f7f2e4");
    // Inactive item = transparent, muted — no ink block.
    const skipped = seg.match(/<a[^>]*data-key="skipped"[^>]*>/)?.[0] ?? "";
    expect(skipped).toContain('data-active="false"');
    expect(skipped).toContain("background:transparent");
  });

  test("status=errors end-to-end: brain-failure rows surface, hidden from the fired default", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", bubble_short: "healthy turn" },
      { ts: "2026-07-01T11:00:00Z", session: "s2", status: "error", error_message: "BrainError: claude -p timed out" },
    ]);
    // errors facet: ONLY the failure row (rail renders its skip_reason).
    const errHtml = await getHtml("/timeline?status=errors");
    expect(errHtml).toContain("1 turn ·");
    expect(errHtml).toContain("brain_error");
    expect(errHtml).not.toContain("healthy turn");
    // Default (status omitted → fired) hides failures.
    const defHtml = await getHtml("/timeline");
    expect(defHtml).toContain("healthy turn");
    expect(defHtml).not.toContain("brain_error");
    // Explicit all shows both.
    const allHtml = await getHtml("/timeline?status=all");
    expect(allHtml).toContain("2 turns ·");
  });

  test("search input carries the inline decorative magnifier SVG", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired" },
    ]);
    const html = await getHtml("/timeline");
    const form = html.match(/<form[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).toContain('aria-label="search turns"');
    // Reference approach: absolute inline SVG (circle + handle), decorative.
    expect(form).toContain("<svg");
    expect(form).toContain('aria-hidden="true"');
    expect(form).toContain("<circle");
    expect(form).toContain("pointer-events:none");
  });

  test("selects scale up via the row-scoped CSS (chevron + 5px/10px pad + radius 8)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired" },
    ]);
    const html = await getHtml("/timeline");
    // Row-scoped rule covers FilterSelect AND the shared ProjectSelect.
    expect(html).toContain(".tl-filter-row select{");
    expect(html).toContain("padding:5px 26px 5px 10px!important");
    expect(html).toContain("border-radius:8px!important");
    expect(html).toContain("appearance:none");
    // Chevron data-URI present (reference .fsel approach).
    expect(html).toContain("background-image:url(");
  });
});

describe("design fixup (2nd smoke) — styled thin scrollbars", () => {
  test("class-scoped thin scrollbar CSS ships for the rail + dossier panes", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired" },
    ]);
    const html = await getHtml("/timeline");
    // Webkit + Firefox variants, scoped to .tl-scroll (not global).
    expect(html).toContain(".tl-scroll::-webkit-scrollbar");
    expect(html).toContain("scrollbar-width:thin");
    expect(html).toContain("scrollbar-color:");
    // Both scroll containers opt in.
    const scrolls = html.match(/class="[^"]*tl-scroll[^"]*"/g) ?? [];
    expect(scrolls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("contextual summary line", () => {
  test("sums tokens + cost over the filtered window and shows acked/dismissed", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", input_tokens: 100, output_tokens: 50, cost: 0.001 },
      { ts: "2026-07-01T11:00:00Z", session: "s2", status: "fired", input_tokens: 100, output_tokens: 50, cost: 0.001 },
      // Legacy usage-less fire — contributes 0, must not NaN the line.
      { ts: "2026-07-01T12:00:00Z", session: "s3", status: "fired", omit_usage: true },
    ]);
    const html = await getHtml("/timeline");
    expect(html).toContain("3 turns · 300 tok · $0.0020 · 0 acked / 0 dismissed");
  });

  test("summary reacts to the filter (q narrows the sums)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", bubble_short: "alpha", input_tokens: 100, output_tokens: 50, cost: 0.001 },
      { ts: "2026-07-01T11:00:00Z", session: "s2", status: "fired", bubble_short: "beta", input_tokens: 900, output_tokens: 100, cost: 0.02 },
    ]);
    const html = await getHtml("/timeline?q=beta");
    expect(html).toContain("1 turn · 1.0k tok · $0.02 · 0 acked / 0 dismissed");
  });
});

describe("Critic tab content", () => {
  test("renders user raw query + honesty-labeled agent reply from the v2 sidecar + critique body + gate line", async () => {
    const critiqueId = "cq-fixture";
    await writeFixture(homeBase, [
      {
        ts: "2026-07-01T10:00:00Z",
        session: "s1",
        status: "fired",
        critique_id: critiqueId,
        bubble_long: "long narrative about the cache",
        critique: "wrap the fetch in withTimeout()",
      },
    ]);
    const day = "2026-07-01";
    const dir = join(homeBase, "critiques", "archive", day);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${critiqueId}.v2.md`),
      [
        "---",
        "schemaVersion: 2",
        `critique_id: ${critiqueId}`,
        'user_raw_query: "please make the cache retry"',
        'agent_reply: "Opening paragraph of the agent reply about cache retry."',
        "changed_files:",
        "  - src/cache.ts",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );

    const html = await getHtml("/timeline");
    // Block A content.
    expect(html).toContain("please make the cache retry");
    expect(html).toContain("Opening paragraph of the agent reply about cache retry.");
    // Honesty caveat — never claims full-verbatim.
    expect(html).toContain(AGENT_REPLY_LABEL);
    expect(html).not.toContain("agent reply (verbatim)");
    // Critique body + narrative.
    expect(html).toContain("wrap the fetch in withTimeout()");
    expect(html).toContain("long narrative about the cache");
    // Gate/skip context line.
    expect(html).toContain("gate ·");
  });

  test("diff bodies are NOT embedded in the page (stay on-demand)", async () => {
    const snapshotId = "snap-fixture.diff";
    await writeFixture(homeBase, [
      {
        ts: "2026-07-01T10:00:00Z",
        session: "s1",
        status: "fired",
        critique_id: "cq-with-diff",
        diff_snapshot_id: snapshotId,
      },
    ]);
    const snapDir = join(homeBase, "critic-snapshots");
    await mkdir(snapDir, { recursive: true });
    await writeFile(
      join(snapDir, snapshotId),
      "diff --git a/src/x.ts b/src/x.ts\n+SECRET_DIFF_BODY_MARKER\n",
      "utf8",
    );
    const html = await getHtml("/timeline");
    expect(html).not.toContain("SECRET_DIFF_BODY_MARKER");
  });
});

describe("old URLs redirect to /timeline (trace-history merge)", () => {
  function redirectApp(): Hono {
    const app = new Hono();
    mountCriticRoutes(app, { homeBase });
    mountTraceWebRoutes(app, { homeBase });
    mountTimelineRoutes(app, { homeBase });
    return app;
  }

  test("/history redirects to /timeline preserving the query string (filters map 1:1)", async () => {
    const res = await redirectApp().request("/history?status=all&kind=warning&q=daemon");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/timeline?status=all&kind=warning&q=daemon");
  });

  test("/history without a query string redirects to bare /timeline", async () => {
    const res = await redirectApp().request("/history");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/timeline");
  });

  test("/critic redirects DIRECTLY to /timeline (no /history double hop), preserving qs", async () => {
    const res = await redirectApp().request("/critic?range=7d");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/timeline?range=7d");
  });

  test("/traces redirects to /timeline (trace-list filters don't map — dropped)", async () => {
    const res = await redirectApp().request("/traces?status=OK&model=claude-haiku-4-5");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/timeline");
  });

  test("/traces/:id still renders the standalone trace-detail page (graceful fallback; Trace tab links here as span explorer)", async () => {
    const res = await redirectApp().request("/traces/deadbeefdeadbeef");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("trace deadbeef");
  });
});

describe("Load-older pagination", () => {
  // Timestamps are relative to real wall-clock (the route injects new
  // Date()); the day-boundary (range=today) assertions live in the unit
  // suite where `now` is injected. Rows are appended oldest-first — the
  // live writer's chronological invariant.
  const nowMs = Date.now();
  const rowTs = (i: number) => new Date(nowMs - (250 - i) * 1000).toISOString();
  const YDAY_TS = new Date(nowMs - 26 * 3600 * 1000).toISOString();

  function pagedFixture(): FixtureCall[] {
    const calls: FixtureCall[] = [
      { ts: YDAY_TS, session: "yday", status: "fired", bubble_short: "bxdayYe" },
    ];
    for (let i = 0; i < 250; i++) {
      calls.push({ ts: rowTs(i), session: `t${i}`, status: "fired", bubble_short: `bx${i}e` });
    }
    return calls;
  }

  test("(a) window with more rows beyond it renders Load older with before=<oldest window ts>, filters preserved", async () => {
    await writeFixture(homeBase, pagedFixture());
    const html = await getHtml("/timeline?range=7d&status=all");
    expect(html).toContain("bx249e"); // newest window rendered
    const anchor = html.match(/<a class="tl-load-older"[^>]*>/)?.[0] ?? "";
    expect(anchor).not.toBe("");
    expect(anchor).toContain("range=7d");
    expect(anchor).toContain("status=all");
    // Window = newest 20 of 251 rows → oldest window row is t230.
    expect(anchor).toContain(`before=${encodeURIComponent(rowTs(230))}`);
  });

  test("(b) activating older shows the next-older window, reaching the prior day; exhausted → older gone, newer offered", async () => {
    await writeFixture(homeBase, pagedFixture());
    // before=t10 lands the oldest window: rows strictly older than t10 =
    // t9..t0 + yday = 11 rows (< limit), exhausting the range going older.
    const html = await getHtml(
      `/timeline?range=7d&status=all&before=${encodeURIComponent(rowTs(10))}`,
    );
    expect(html).toContain("bx9e"); // next-older window
    expect(html).not.toContain("bx10e"); // exclusive bound — no overlap
    expect(html).toContain("bxdayYe"); // reached a row from the day before
    // 11 rows < limit and the range is exhausted going older…
    expect(html).not.toContain("tl-load-older");
    // …but the pager offers the way BACK (bidirectional cursors): the
    // newer anchor carries after=<newest page row>, filters preserved.
    const newer = html.match(/<a class="tl-load-newer"[^>]*>/)?.[0] ?? "";
    expect(newer).not.toBe("");
    expect(newer).toContain("range=7d");
    expect(newer).toContain("status=all");
    expect(newer).toContain(`after=${encodeURIComponent(rowTs(9))}`);
  });

  test("(b2) following the newer anchor returns to (an equivalent of) the newest window — no dead ends", async () => {
    await writeFixture(homeBase, pagedFixture());
    const page2 = await getHtml(
      `/timeline?range=7d&status=all&before=${encodeURIComponent(rowTs(230))}`,
    );
    const newerHref = (page2.match(/<a class="tl-load-newer"[^>]*href="([^"]+)"/)?.[1] ?? "")
      .replace(/&amp;/g, "&");
    expect(newerHref).not.toBe("");
    const back = await getHtml(newerHref);
    // page2 = t229..t210 (after=t229); following newer → the newest window
    // (the 20 rows strictly newer than t229 = t230..t249).
    expect(back).toContain("bx230e");
    expect(back).toContain("bx249e");
    expect(back).not.toContain("bx229e");
    // At the newest edge again: no newer anchor, older anchor back.
    expect(back).not.toContain("tl-load-newer");
    expect(back).toContain("tl-load-older");
  });

  test("sort=oldest anchors the first page at the range's OLDEST end and pages toward newer", async () => {
    await writeFixture(homeBase, pagedFixture());
    const html = await getHtml("/timeline?status=all&sort=oldest");
    // Oldest 20 of 251: yday + t0..t18; the rest belong to later pages.
    expect(html).toContain("bxdayYe");
    expect(html).toContain("bx0e");
    expect(html).toContain("bx18e");
    expect(html).not.toContain("bx249e");
    // Paging direction is toward newer; nothing exists older than page 1.
    expect(html).toContain("tl-load-newer");
    expect(html).not.toContain("tl-load-older");
    // First row of the rail is the OLDEST row (chronological render).
    const firstKey = html.match(/data-turn-key="([^"]+)"/)?.[1] ?? "";
    expect(firstKey).toContain("|yday");
  });

  test("invalid before param is ignored (renders the newest window)", async () => {
    await writeFixture(homeBase, pagedFixture());
    const html = await getHtml("/timeline?status=all&before=garbage");
    expect(html).toContain("bx249e");
    expect(html).toContain("tl-load-older");
  });

  test("no Load-older control when the window exhausts the range", async () => {
    await writeFixture(homeBase, [
      { ts: rowTs(0), session: "t0", status: "fired", bubble_short: "bx0e" },
      { ts: rowTs(1), session: "t1", status: "fired", bubble_short: "bx1e" },
    ]);
    const html = await getHtml("/timeline");
    expect(html).toContain("bx1e");
    expect(html).not.toContain("tl-load-older");
  });

  test("filter with zero matches anywhere in range: honest empty page, NO pager (window counts what would render)", async () => {
    // Deliberate flip of the old raw-window behavior: with the predicate
    // counted IN the scan, "no rows anywhere pass" is knowable — a pager
    // that walks pages of nothing would be dishonest.
    await writeFixture(homeBase, pagedFixture());
    const html = await getHtml("/timeline?status=skipped");
    expect(html).toContain("no turns match");
    expect(html).not.toContain("tl-load-older");
    expect(html).not.toContain("tl-load-newer");
  });

  test("summary shows range total + page count; tokens/$ follow the visible page", async () => {
    await writeFixture(homeBase, pagedFixture());
    // Fixture default usage: 100 in + 50 out tokens per row; 251 in range.
    const p1 = await getHtml("/timeline");
    expect(p1).toContain(`251 turns in range · showing 20 · ${fmtTokens(20 * 150)} tok`);
    const p2 = await getHtml(`/timeline?before=${encodeURIComponent(rowTs(10))}`);
    expect(p2).toContain(`251 turns in range · showing 11 · ${fmtTokens(11 * 150)} tok`);
  });

  test("single page (total == shown) keeps the plain `N turns` summary — no redundant `showing`", async () => {
    await writeFixture(homeBase, [
      { ts: rowTs(0), session: "t0", status: "fired", bubble_short: "bx0e" },
      { ts: rowTs(1), session: "t1", status: "fired", bubble_short: "bx1e" },
    ]);
    const html = await getHtml("/timeline");
    expect(html).toContain("2 turns · 300 tok");
    expect(html).not.toContain("in range · showing");
  });
});

describe("summaryLine formatting", () => {
  test("large range totals carry thousands separators", async () => {
    const { summaryLine } = await import("../../../src/web/screens/TimelineScreen");
    const telemetry = {
      recent: Array.from({ length: 200 }, () => ({}) ),
      totals: { tokens: 118_200, cost_usd: 3.02 },
      actionStats: { acked: 3, dismissed: 1, untouched_fired: 196, total_fired: 200 },
      totalInRange: 2535,
    } as unknown as Parameters<typeof summaryLine>[0];
    expect(summaryLine(telemetry)).toBe(
      "2,535 turns in range · showing 200 · 118.2k tok · $3.02 · 3 acked / 1 dismissed",
    );
  });
});

describe("format helpers", () => {
  test("fmtTokens", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(1000)).toBe("1.0k");
    expect(fmtTokens(12873)).toBe("12.9k");
  });

  test("fmtCost", () => {
    expect(fmtCost(0)).toBe("$0.00");
    expect(fmtCost(0.0021)).toBe("$0.0021");
    expect(fmtCost(0.25)).toBe("$0.25");
  });
});

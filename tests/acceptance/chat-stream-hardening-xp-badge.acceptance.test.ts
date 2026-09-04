/**
 * chat-stream-hardening-xp-badge.acceptance.test.ts — ACCEPTANCE tests for the
 * Home XP badge / single-price-table hardening.
 *
 *
 * SCOPE:
 *   The Home "+N today" badge reads the AWARDED ledger (action_xp per
 *     day), never the count-based recompute (daily_actions × prices); at the
 *     100/day cap it stops increasing and shows "+100 today · capped".
 *   Badge is correct on BOTH render paths — full Home SSR (GET /) and
 *     the post-action HTMX OOB swap (POST /api/action with HX-Request).
 *   Exactly one price table remains (ACTION_BASE_XP: play 3, tease 0);
 *     XP_PER_ACTION is deleted, xpToday() retired, and vitalsWriter's
 *     xp_awarded comes from the same single table.
 *
 * ACCEPTANCE BOUNDARY — outside-observable behavior only:
 *   • Fixture state is written directly to disk (progression.json in a temp
 *     ~/.siltpoke) — no internal writer function is used to build state.
 *   • Behavior is observed at the ROUTE level: an in-process Hono app with
 *     the REAL mountHomeRoutes / mountDashboardRoutes (same pattern used
 *     elsewhere for a homeApp), asserting on rendered HTML
 *     and on files the routes write as side effects (vitals.jsonl,
 *     progression.json).
 *   • The single-price-table check's structural half is a source-tree scan
 *     (grep-level) plus a check of the exported table's values — this check
 *     is structural by nature; the behavioral half (vitalsWriter pricing) is
 *     observed through the vitals.jsonl file written by POST /api/action,
 *     not by reading vitalsWriter source.
 *
 * Anti-vacuous discipline:
 *   • Every fixture is built so the awarded ledger DIFFERS from the
 *     count-based recompute (counts imply +175 under the OLD XP_PER_ACTION
 *     table / +115 under the new one; ledger says 100 or 40). Each presence
 *     assertion ("+100 today · capped") is paired in the same test with an
 *     absence assertion for the number the retired count-based path would
 *     have shown ("+175 today").
 *   • The capped suffix is asserted PRESENT at-cap and ABSENT below-cap in
 *     paired tests, so " · capped" can't pass vacuously.
 *   • The single-price-table vitals fixture prices to 11 under the new table
 *     and 19 under the old one (play 2× + tease 4× diverge: 3/0 new vs 5/1
 *     old) — the assertion distinguishes the tables, not just "some number
 *     was written".
 *
 * Run: bun test tests/acceptance/chat-stream-hardening-xp-badge.acceptance.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { mountHomeRoutes } from "../../src/web/routes/home";
import { mountDashboardRoutes } from "../../src/daemon/routes/dashboard";
// Single-table value check: the single surviving price table. Importing a
// constant is the agreed structural-check level (see header note).
import { ACTION_BASE_XP } from "../../src/state/progression";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// ── Day keys (same UTC convention the routes use) ─────────────────────────────

const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const YESTERDAY = (() => {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
})();

// ── Fixture helpers ───────────────────────────────────────────────────────────

interface DayCounts {
  day: string;
  feed: number;
  play: number;
  pet: number;
  tease: number;
  clean: number;
  sleep: number;
}

function makeHome(tag: string): { homeBase: string } {
  const tmpHome = mkdtempSync(join(tmpdir(), `sp-acc-${tag}-`));
  tempDirs.push(tmpHome);
  const homeBase = join(tmpHome, ".siltpoke");
  mkdirSync(homeBase, { recursive: true });
  return { homeBase };
}

/**
 * Write a COMPLETE v2 progression.json directly to disk. Must be a full
 * valid v2 shape: a partial shape triggers the reader's migration path,
 * which silently drops action_xp — exactly the field under test.
 */
function writeProgressionFixture(
  homeBase: string,
  opts: {
    daily_actions: DayCounts[];
    action_xp: Array<{ day: string; xp: number }>;
  },
): void {
  const progression = {
    schemaVersion: 2,
    level: 3,
    xp: 50,
    xp_to_next_level: 300,
    unlocked_poses: ["base"],
    unlocked_titles: ["Hatchling"],
    pet_log: [],
    daily_actions: opts.daily_actions,
    stats: { hp: 8, hunger: 5, energy: 7, mood: 6, bond: 2 },
    stats_last_tick_at: NOW.toISOString(),
    streak_days_persistent: 1,
    streak_last_day: TODAY,
    action_xp: opts.action_xp,
  };
  writeFileSync(
    join(homeBase, "progression.json"),
    JSON.stringify(progression, null, 2),
    "utf8",
  );
}

/**
 * Divergent TODAY counts shared by the badge fixtures below:
 *   count-based recompute (the retired lie) = 20·feed + 5·play + 10·pet
 *     = 175 under the OLD XP_PER_ACTION table (feed 5, play 5, pet 5)
 *     = 115 even under the NEW prices (feed 5, play 3, pet 5)
 *   — both differ from every ledger value used below (100 / 40), so a badge
 *   built from counts is caught regardless of which table it multiplies by.
 */
function divergentTodayCounts(): DayCounts {
  return { day: TODAY, feed: 20, play: 5, pet: 10, tease: 0, clean: 0, sleep: 0 };
}

function homeApp(homeBase: string): Hono {
  const app = new Hono();
  mountHomeRoutes(app, { homeBase });
  return app;
}

// POST /api/action is secret-gated (daemon-hardening security audit,
// finding 2) — every request below now carries this header.
const TEST_SECRET = "test-secret";

function dashboardApp(homeBase: string): Hono {
  const app = new Hono();
  mountDashboardRoutes(app, { homeBase, secret: TEST_SECRET });
  return app;
}

/** Extract the badge text from rendered HTML; null when the badge is absent. */
function badgeText(html: string): string | null {
  const m = html.match(/class="stats-panel__xp-today"[^>]*>([^<]*)</);
  return m ? (m[1] ?? null) : null;
}

async function getHomeHtml(homeBase: string): Promise<string> {
  const res = await homeApp(homeBase).request("/");
  expect(res.status).toBe(200);
  return res.text();
}

/** POST /api/action as HTMX would (form-encoded + HX-Request header). */
async function postActionHtmx(
  homeBase: string,
  action: string,
): Promise<Response> {
  return dashboardApp(homeBase).request("/api/action", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "HX-Request": "true",
      "X-Siltpoke-Secret": TEST_SECRET,
    },
    body: `action=${action}`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Badge reads the awarded ledger; capped state at 100/day
// ─────────────────────────────────────────────────────────────────────────────

describe("Home badge reads awarded ledger (actionXpToday) with capped state", () => {
  test("at the 100/day cap, Home SSR shows '+100 today · capped' from the ledger, NOT the count-based recompute (+175)", async () => {
    const { homeBase } = makeHome("ac13-cap");
    // Counts imply +175 (old table) / +115 (new table); ledger says 100.
    writeProgressionFixture(homeBase, {
      daily_actions: [divergentTodayCounts()],
      action_xp: [{ day: TODAY, xp: 100 }],
    });

    const html = await getHomeHtml(homeBase);
    const badge = badgeText(html);

    // Ledger truth, with the capped suffix.
    expect(badge).toBe("+100 today · capped");
    // The count-based lie must be absent (would have rendered under the old
    // xpToday(): 20·5 + 5·5 + 10·5 = 175; even new prices give 115).
    expect(html).not.toContain("+175 today");
    expect(html).not.toContain("+115 today");
  });

  test("(control pairing): below the cap the badge shows the ledger value WITHOUT the capped suffix", async () => {
    const { homeBase } = makeHome("ac13-below");
    writeProgressionFixture(homeBase, {
      daily_actions: [divergentTodayCounts()],
      action_xp: [{ day: TODAY, xp: 40 }],
    });

    const html = await getHomeHtml(homeBase);
    const badge = badgeText(html);

    expect(badge).toBe("+40 today"); // no " · capped" — exact match pins absence
    expect(html).not.toContain("· capped");
    expect(html).not.toContain("+175 today");
    expect(html).not.toContain("+115 today");
  });

  test("once capped, further actions do NOT increase the badge — action awards 0, ledger file stays at 100, badge stays '+100 today · capped'", async () => {
    const { homeBase } = makeHome("ac13-stop");
    writeProgressionFixture(homeBase, {
      daily_actions: [divergentTodayCounts()],
      action_xp: [{ day: TODAY, xp: 100 }],
    });

    // Door-opened check: the action route really processed a feed (which
    // would want +5 XP) and reports it awarded nothing because of the cap.
    const res = await dashboardApp(homeBase).request("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
      body: JSON.stringify({ action: "feed" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      awarded: number;
      capped: boolean;
      action_count: number;
    };
    expect(body.ok).toBe(true);
    expect(body.action_count).toBe(21); // feed really recorded (20 → 21)
    expect(body.awarded).toBe(0);
    expect(body.capped).toBe(true);

    // Observable ledger file: still exactly 100 for today.
    const prog = JSON.parse(
      readFileSync(join(homeBase, "progression.json"), "utf8"),
    ) as { action_xp?: Array<{ day: string; xp: number }> };
    const todayLedger = (prog.action_xp ?? []).find((e) => e.day === TODAY);
    expect(todayLedger?.xp).toBe(100);

    // And the badge has not increased.
    const html = await getHomeHtml(homeBase);
    expect(badgeText(html)).toBe("+100 today · capped");
    expect(html).not.toContain("+105 today"); // what 100 + feed(5) would read
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Badge correct on BOTH render paths (full SSR + HTMX OOB swap)
// ─────────────────────────────────────────────────────────────────────────────

describe("badge correct on full Home SSR AND post-action HTMX OOB swap", () => {
  test("same divergent state renders the SAME ledger value on GET / and in the POST /api/action OOB fragment (tease: 0 XP, ledger unchanged)", async () => {
    const { homeBase } = makeHome("ac14-both");
    // Ledger 40; counts imply 175/115. tease is priced 0 in the single table,
    // so the OOB render after a tease must still say +40 — a count-based OOB
    // would say +176 (old, tease was 1) or +115 (new prices).
    writeProgressionFixture(homeBase, {
      daily_actions: [divergentTodayCounts()],
      action_xp: [{ day: TODAY, xp: 40 }],
    });

    // Path 1 — full Home SSR.
    const ssrHtml = await getHomeHtml(homeBase);
    expect(badgeText(ssrHtml)).toBe("+40 today");

    // Path 2 — HTMX OOB swap from the action route.
    const res = await postActionHtmx(homeBase, "tease");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const oobHtml = await res.text();

    // It really is the OOB stats-panel fragment (not a JSON fallback).
    expect(oobHtml).toContain('id="stats-panel" hx-swap-oob="true"');
    expect(badgeText(oobHtml)).toBe("+40 today");

    // Count-based values absent on both paths (old table 175/176, new 115).
    for (const html of [ssrHtml, oobHtml]) {
      expect(html).not.toContain("+175 today");
      expect(html).not.toContain("+176 today");
      expect(html).not.toContain("+115 today");
    }
  });

  test("OOB fragment reflects a REAL ledger award and flips to capped when the award lands exactly on the cap (97 + feed:5 → grants 3 → '+100 today · capped')", async () => {
    const { homeBase } = makeHome("ac14-oob-cap");
    writeProgressionFixture(homeBase, {
      daily_actions: [divergentTodayCounts()],
      action_xp: [{ day: TODAY, xp: 97 }],
    });

    const res = await postActionHtmx(homeBase, "feed");
    expect(res.status).toBe(200);
    const oobHtml = await res.text();

    expect(oobHtml).toContain('id="stats-panel" hx-swap-oob="true"');
    // Ledger math: min(feed price 5, remaining budget 3) = 3 → 97 + 3 = 100,
    // which IS the cap → capped suffix appears on the OOB path too.
    expect(badgeText(oobHtml)).toBe("+100 today · capped");
    // Neither the uncapped-full-award lie (+102) nor count-based numbers.
    expect(oobHtml).not.toContain("+102 today");
    expect(oobHtml).not.toContain("+175 today");

    // The full SSR path agrees afterwards (both paths read the same ledger).
    const ssrHtml = await getHomeHtml(homeBase);
    expect(badgeText(ssrHtml)).toBe("+100 today · capped");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Single price table; XP_PER_ACTION deleted, xpToday() retired,
//        vitalsWriter prices from the same table
// ─────────────────────────────────────────────────────────────────────────────

/** Recursively list all .ts/.tsx files under a directory. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("exactly one price table (ACTION_BASE_XP); dead symbols gone; vitalsWriter same-table pricing", () => {
  test("XP_PER_ACTION has ZERO references anywhere under src/ (including the vitals-local clone), while ACTION_BASE_XP is declared exactly once", () => {
    const files = listSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(100); // door-opened: the scan really walked src/

    const xpPerActionHits: string[] = [];
    const tableDeclHits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (text.includes("XP_PER_ACTION")) xpPerActionHits.push(f);
      // Any declaration form: `const ACTION_BASE_XP` / `export const ACTION_BASE_XP`.
      const decls = text.match(/const ACTION_BASE_XP\b/g) ?? [];
      for (const _ of decls) tableDeclHits.push(f);
    }

    // Deleted table (and its vitals clone XP_PER_ACTION_VITALS — substring
    // match covers both) must be fully gone.
    expect(xpPerActionHits).toEqual([]);
    // Exactly ONE surviving price table, in progression.ts.
    expect(tableDeclHits).toHaveLength(1);
    expect(tableDeclHits[0]).toBe(join(SRC_ROOT, "state", "progression.ts"));
  });

  test("xpToday() is retired — no call or declaration `xpToday(` remains under src/ (actionXpToday, the ledger reader, is the anti-vacuous presence control)", () => {
    const files = listSourceFiles(SRC_ROOT);
    const xpTodayHits: string[] = [];
    let actionXpTodayCalls = 0;
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      // Case-sensitive `xpToday(` cannot match `actionXpToday(` (capital X)
      // nor the StatsPanel prop `xpToday:` (no paren).
      if (/(?<![A-Za-z])xpToday\s*\(/.test(text)) xpTodayHits.push(f);
      actionXpTodayCalls += (text.match(/\bactionXpToday\(/g) ?? []).length;
    }
    expect(xpTodayHits).toEqual([]);
    // Presence control: the replacement ledger reader is really in use on
    // both render paths (Home.data + dashboard-helpers) — proves the scan
    // isn't passing because it looked at nothing.
    expect(actionXpTodayCalls).toBeGreaterThanOrEqual(2);
  });

  test("the single table prices play=3 and tease=0", () => {
    expect(ACTION_BASE_XP.play).toBe(3);
    expect(ACTION_BASE_XP.tease).toBe(0);
    // Old-table values pinned absent (XP_PER_ACTION had play 5, tease 1).
    expect(ACTION_BASE_XP.play).not.toBe(5);
    expect(ACTION_BASE_XP.tease).not.toBe(1);
  });

  test("vitalsWriter's yesterday snapshot (observed via vitals.jsonl written by POST /api/action) prices from the SAME table — play 3 / tease 0, not the old 5 / 1", async () => {
    const { homeBase } = makeHome("ac15-vitals");
    // Yesterday: feed 1, play 2, tease 4, sleep 3.
    //   new single table → 1·5 + 2·3 + 4·0 + 3·0 = 11
    //   old XP_PER_ACTION(_VITALS) → 1·5 + 2·5 + 4·1 + 3·0 = 19
    writeProgressionFixture(homeBase, {
      daily_actions: [
        { day: YESTERDAY, feed: 1, play: 2, pet: 0, tease: 4, clean: 0, sleep: 3 },
      ],
      action_xp: [],
    });
    expect(existsSync(join(homeBase, "vitals.jsonl"))).toBe(false);

    // First action of the day triggers the yesterday snapshot write.
    const res = await dashboardApp(homeBase).request("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
      body: JSON.stringify({ action: "feed" }),
    });
    expect(res.status).toBe(200);

    const vitalsRaw = readFileSync(join(homeBase, "vitals.jsonl"), "utf8");
    const snapshots = vitalsRaw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { day: string; xp_awarded: number });

    const yesterdaySnap = snapshots.find((s) => s.day === YESTERDAY);
    expect(yesterdaySnap).toBeDefined();
    // Same-table pricing (11), explicitly NOT the old-table figure (19).
    expect(yesterdaySnap?.xp_awarded).toBe(11);
    expect(yesterdaySnap?.xp_awarded).not.toBe(19);
  });
});

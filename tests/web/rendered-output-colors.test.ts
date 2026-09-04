// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Task 11 — prove it from the OUTPUT, not the source.
 *
 * `lint:colors` (scripts/lint-no-hardcoded-color.ts) scans TypeScript source
 * spans in `src/web` + `src/daemon/routes`. That is a real, useful guard, but
 * it is structurally blind to anything that only exists once the server
 * composes it: a literal built from string concatenation across two spans, a
 * literal that comes from data (not source) and gets interpolated into
 * markup, or a literal emitted by code outside the guard's ROOTS. This test
 * fetches the REAL rendered HTML from a REAL running daemon and re-uses the
 * guard's own literal-detector against what actually went over the wire.
 *
 * Deviation from the brief's literal Step-1 code (reported in
 * task-11-report.md): the brief's snippet hits a fixed
 * `http://127.0.0.1:9876` and instructs starting a daemon by hand via bash
 * before running this file. That would leave this test permanently failing
 * under plain `bun test` (the "Unit tests" CI step / `ci:local`'s "test" gate
 * runs `bun test` with no daemon pre-started — confirmed against
 * .github/workflows/ci.yml and scripts/ci-local.ts). The established
 * self-contained pattern in this repo for exactly this situation
 * (tests/daemon/smoke.e2e.test.ts) is `startDaemon({ port: 0, ... })` /
 * `stopDaemon()` around the real Hono app, on an ephemeral port, cleaned up
 * per-suite. This file uses that pattern instead of a fixed port + external
 * process, so it runs unattended in `bun test` — same real-server intent as
 * the brief, no external setup step required. ROUTES / the attribute regex /
 * the allowlist-comparison logic are otherwise verbatim from the brief.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, stopDaemon, type DaemonHandle } from "../../src/daemon/server";
import { resetNavAvailability } from "../../src/web/routes/nav";
import { scanForColorLiterals } from "../../scripts/lint-no-hardcoded-color";
import { cacheKey, explanationPaths, writeExplanation } from "../../src/explain/store";
import { EXPLANATION_SCHEMA_VERSION, type ExplanationMeta } from "../../src/explain/types";

/**
 * The routes rendered by this check. Enumerated explicitly rather than
 * "every route" — an unenumerated sweep silently shrinks when a route moves,
 * and reports success for the routes it forgot.
 *
 * `/explain` joins this list per the coordinator's Task 11 fix-round-1
 * ruling: Task 10a took its 22 literals to zero and wired it to the same
 * `/static/tokens.css`, and a served-output check whose whole purpose is
 * catching what source scanning cannot must not have its one hole exactly
 * where that human decision was made. `/explain/:id` (dynamic — needs a real
 * persisted explanation to hit the "found" 200 branch, not the 400/404 error
 * pages) is covered separately below via a seeded fixture, not in this list.
 *
 * Coverage caveat, UPDATED fix round 1: `<style>…</style>` element bodies
 * (CSS text, not an attribute — layout.tsx / RepoGraph.tsx /
 * TimelineScreen.tsx / explain.tsx all emit one) are now scanned too, via
 * `STYLE_TAG_BODY` below — required once `/explain` joined `ROUTES`, whose
 * pages carry ZERO inline `style=` attributes (all their color lives in a
 * `<style>` body), so leaving that gap unclosed would have made the
 * `/explain` coverage this fix round added scan nothing. `class="..."`
 * (Tailwind arbitrary-value literals) is still NOT scanned — checked live,
 * no route currently emits a dynamic `class={...}` with color content, so
 * this remains a real but dormant gap; see task-11-report.md "Concerns".
 */
const ROUTES = [
  "/", "/timeline", "/memory", "/critic", "/repo-graph", "/repo-memory",
  // "a retired page" dropped 2026-08-06 — the route is no longer mounted, so scanning it
  // would scan a 404 page and quietly report the surface clean.
  "/rubric", "/few-shot", "/preference-log", "/traces", "/chat",
  "/explain",
] as const;

const COLOR_IN_ATTR =
  /(?:style|stroke|fill|stop-color|flood-color|lighting-color)\s*=\s*"([^"]*)"/g;

/**
 * Widened past the brief's verbatim `COLOR_IN_ATTR`-only version (fix round
 * 1): probing `/explain` after adding it to `ROUTES` found its list + detail
 * pages carry ZERO inline `style=` attributes — every color there lives
 * inside a `<style>…</style>` element body (CSS text, not an HTML
 * attribute), which `COLOR_IN_ATTR` structurally cannot see. Shipping
 * `/explain` coverage that scans 0 bytes of its actual color content would
 * be the exact "clean result over a partial/empty set" failure mode this
 * whole task exists to catch — an attribute-only scan reports "clean" on
 * `/explain` whether the check is working or scanning nothing, identically.
 * Each `<style>` body is CSS text throughout (unlike JS/TS, where only
 * quoted strings are CSS-value territory) — mirrors exactly how
 * `scanForColorLiterals`'s own `valueSpans()` treats a `.css` FILE (see
 * scripts/lint-no-hardcoded-color.ts): passing a `.css`-suffixed synthetic
 * path routes through that same whole-body branch instead of the TS
 * string-span parser (which raw CSS text isn't valid input for).
 */
const STYLE_TAG_BODY = /<style[^>]*>([\s\S]*?)<\/style>/g;

/** Every un-allowlisted literal `scanForColorLiterals` finds in `html`'s attribute values AND inline `<style>` bodies. */
function findLeaks(html: string, allowed: Set<string>): string[] {
  const found: string[] = [];
  for (const m of html.matchAll(COLOR_IN_ATTR)) {
    for (const v of scanForColorLiterals(`"${m[1]}"`, "rendered")) {
      if (!allowed.has(v.literal)) found.push(`${v.literal} in ${m[0].slice(0, 80)}`);
    }
  }
  for (const m of html.matchAll(STYLE_TAG_BODY)) {
    for (const v of scanForColorLiterals(m[1], "rendered.css")) {
      if (!allowed.has(v.literal)) found.push(`${v.literal} in <style> body`);
    }
  }
  return found;
}

let handle: DaemonHandle;
let base: string;
// Hoisted (fix round 1, Minor): the allowlist is static for the whole run —
// re-reading + re-parsing it once per route (13+ times) bought nothing.
let allowed: Set<string>;

/**
 * `/explain/:id`'s "found" branch (the one with the `.banner` and
 * `<pre><code>` content — the actual literal-bearing detail page) only
 * renders when a real persisted explanation exists on disk; an unknown id
 * 404s instead. `mountExplainRoutes` resolves the request's project root via
 * `resolveRequestProject`, which — given this test's fresh, pin-less,
 * registry-less `homeBase` and no `?repo=` — falls through to `NONE` and the
 * route's own `cwd` fallback, which `src/daemon/server.ts` hardcodes to
 * `process.cwd()` (the repo root `bun test` runs from). So the fixture is
 * seeded there, through the real `writeExplanation()` writer (not hand-typed
 * JSON — same on-disk shape `readExplanation` actually reads), and removed
 * in `afterAll` (atomic tmp+rename write, force-removed cleanup — a stale
 * leftover from a crashed prior run is silently overwritten, not duplicated
 * or failed, on the next run). Precision note (independent-reviewer finding,
 * fix round 1): `process.cwd()` during `bun test` IS the repo root, so this
 * writes into the repo's own real `.siltpoke/explanations/` (gitignored,
 * machine-local) rather than an isolated scratch directory — "self-contained"
 * means it does not DEPEND on any pre-existing file there (works on a fresh
 * CI checkout with an empty directory), not that it never touches the real
 * one; the sha256-derived key makes collision with a real entry negligible,
 * and cleanup removes exactly the two files this fixture added.
 */
const FIXTURE_TARGET_NODE_ID = "file:tests/web/rendered-output-colors.test.ts:__task11_fixture__";
const FIXTURE_KEY = cacheKey(FIXTURE_TARGET_NODE_ID);

async function seedExplainFixture(): Promise<void> {
  const meta: ExplanationMeta = {
    schemaVersion: EXPLANATION_SCHEMA_VERSION,
    target: "__task11_fixture__",
    target_node_id: FIXTURE_TARGET_NODE_ID,
    target_key_sha256: FIXTURE_KEY,
    graph_indexed_ts: new Date(0).toISOString(),
    brain_usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_cost_usd: 0,
    },
    // low_confidence: true renders the `.banner` block too (color-mix-derived
    // ink2-on-amber/paper text) — more of the detail page's attribute
    // surface actually gets scanned, not just the happy path.
    evidence_score: 0.5,
    low_confidence: true,
    depth: 1,
    created_ts: new Date(0).toISOString(),
  };
  await writeExplanation(process.cwd(), FIXTURE_KEY, "fixture markdown body", meta);
}

async function removeExplainFixture(): Promise<void> {
  const { mdPath, metaPath } = explanationPaths(process.cwd(), FIXTURE_KEY);
  await rm(mdPath, { force: true });
  await rm(metaPath, { force: true });
}

beforeAll(async () => {
  const raw = JSON.parse(await readFile(".lint-colors-allowlist.json", "utf8"));
  allowed = new Set((raw.entries as Array<{ literal: string }>).map((e) => e.literal));

  const dir = mkdtempSync(join(tmpdir(), "rendered-colors-"));
  handle = await startDaemon({
    port: 0,
    hostname: "127.0.0.1",
    lockPath: join(dir, "siltpoked.lock"),
    pidPath: join(dir, "siltpoked.pid"),
    markerDir: join(dir, "markers"),
    secret: "x",
    homeBase: dir,
  });
  base = `http://127.0.0.1:${handle.server.port}`;

  await seedExplainFixture();
});

afterAll(async () => {
  if (handle) await stopDaemon(handle);
  await removeExplainFixture();
  // The `beforeAll` boot above (fresh homeBase, no ROADMAP.md) flips the
  // module-level `unavailable` Set in `src/web/routes/nav.ts` to
  // `{progress: false}` -- a fact about a real daemon boot, not this file's
  // own concern, but `bun test` runs the WHOLE suite in one process sharing
  // that singleton. Without this reset, whichever unrelated Dashboard-
  // rendering test runs next (alphabetically, `tests/web/screens/
  // Critic.golden.test.tsx` / `Home.test.tsx`) inherits a hidden "Progress"
  // nav entry it never asked for. See `src/web/routes/nav.ts`'s
  // `resetNavAvailability` doc comment -- every test file that boots a
  // daemon directly needs this same call in its own teardown.
  resetNavAvailability();
});

describe("rendered output carries no un-allowlisted color literal", () => {
  for (const route of ROUTES) {
    test(route, async () => {
      const res = await fetch(`${base}${route}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(findLeaks(html, allowed), `${route} leaked baked colors`).toEqual([]);
    });
  }

  test(`/explain/${FIXTURE_KEY} (dynamic route, seeded fixture)`, async () => {
    const res = await fetch(`${base}/explain/${FIXTURE_KEY}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Proves the fixture actually hit the "found" branch, not the 404 page —
    // an un-asserted 200 could just as easily be the wrong template.
    expect(html).toContain("fixture markdown body");
    expect(
      findLeaks(html, allowed),
      `/explain/${FIXTURE_KEY} leaked baked colors`,
    ).toEqual([]);
  });
});

describe("both themes actually differ in the served CSS", () => {
  test("tokens.css declares a dark value for the page background", async () => {
    const res = await fetch(`${base}/static/tokens.css`);
    const css = await res.text();
    expect(css).toContain("--color-cream: #151515");
    expect(css).toContain("--color-cream: #faf6ec");
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Timeline screen — the ⏱ review-unit control.
 *
 * WHY THIS FILE EXISTS. `reviewUnit` shipped in #677 with a `<select>`, and
 * four golden fixtures asserted that select's markup, so every layer was
 * green. The select lived in `src/cli/report-artifacts.ts` — the legacy
 * tamagotchi report page, which `src/daemon/server.ts` retired ("its legacy
 * GET /dashboard report page is retired") and which nothing in `src/` renders
 * any more (`buildReport` has no caller outside tests). The obvious second
 * home, `/settings`, is ALSO unmounted (server.ts, 2026-08-06). So no user
 * could reach the control anywhere, while the plan, the close report, and
 * `review-unit-config.ts`'s own doc comment all said "the dashboard writes
 * reviewUnit". The tests could not catch it: they asserted an HTML string,
 * not reachability (memory `signal-decoupled-from-reality`).
 *
 * These assertions are therefore pinned to the LIVE screen — the one
 * `src/web/routes/timeline.tsx` serves at a path that is in the nav — and the
 * e2e counterpart (`tests/e2e/timeline-review-unit.spec.ts`) drives the real
 * page in a real browser, because markup alone is what was green last time.
 */
import { describe, expect, test } from "bun:test";
import type { CriticTelemetry } from "../../src/state/api";
import { TimelineScreen } from "../../src/web/screens/TimelineScreen";
// From the decision module, NOT from the island: the island registers on
// `document` at import time and this is not a DOM test. Same list either way —
// that is the point of moving it there.
import { REVIEW_UNITS } from "../../src/router/review-unit";

const TELEMETRY: CriticTelemetry = {
  recent: [],
  breakdown: { total: 0, counts: {} },
  budget: {
    stage: "ok",
    used_pct: 0,
    remaining_tokens: 1_000_000,
    config: {
      dailyTokenLimit: 1_000_000,
      perCallMaxInputTokens: 100_000,
      softWarnAtPercent: 80,
      hardStopAtPercent: 100,
      softModeOverride: "on_demand",
      resetAtMinutes: 0,
    },
    rollup: null,
  },
  quietConfig: { startMinutes: null, endMinutes: null },
  gateState: { blocking: null, detail: "All gates open.", checks: [] },
  projects: [],
  activeProject: null,
  activeStatus: null,
  activeKind: null,
  activeRange: "all",
  activeSort: "newest",
  preferenceStats: null,
  activeQuery: null,
  actionStats: { dismissed: 0, acked: 0, total: 0 },
  homeBasename: "user",
  totals: { tokens: 0, cost_usd: 0 },
  totalInRange: null,
} as unknown as CriticTelemetry;

function render(reviewUnit: "commit" | "pr"): string {
  return String(TimelineScreen({ telemetry: TELEMETRY, secret: "s3cr3t", reviewUnit }));
}

describe("Timeline screen — review unit", () => {
  test("renders both units and no third", () => {
    const html = render("commit");
    expect(html).toContain('value="commit"');
    expect(html).toContain('value="pr"');
    // The four dead `triggerMode` values must not reappear as choices — they
    // all mean `commit` now, and offering one is how a control goes on
    // promising something it cannot do (spec D8 / AC12).
    for (const dead of ["on_demand", "hybrid", "always", "gates"]) {
      expect(html).not.toContain(`<option value="${dead}"`);
    }
  });

  test("marks the CONFIGURED unit selected, not always the first option", () => {
    const asPr = render("pr");
    // Positive control on the other side: a screen that hardcoded `commit`
    // as selected would pass a `commit`-only assertion.
    expect(asPr).toContain('value="pr" selected');
    expect(asPr).not.toContain('value="commit" selected');

    const asCommit = render("commit");
    expect(asCommit).toContain('value="commit" selected');
    expect(asCommit).not.toContain('value="pr" selected');
  });

  test("changing the selection clears a stale Saved ✓", () => {
    // Without this handler the button keeps reading "Saved ✓" after the user
    // picks the OTHER unit — asserting a save that no longer describes the
    // form. The island's `saved` flag is only ever cleared inside save().
    const html = render("commit");
    const select = html.match(/<select[^>]*data-review-unit-select[^>]*>/);
    expect(select).not.toBeNull();
    expect(select?.[0]).toContain("saved = false");
    expect(select?.[0]).toContain("error = &#39;&#39;");
  });

  test("only the configured unit's hint is painted before Alpine hydrates", () => {
    // `x-show` alone leaves BOTH hints visible until the bundle runs — and
    // permanently with JS off — so the row reads as two contradictory
    // sentences at once. The server-side `display` is what prevents that.
    const html = render("commit");
    expect(html).toContain("every new commit");
    // The other unit's hint must ship hidden, not merely x-show-gated.
    const otherHint = html.match(/<span[^>]*x-show="unit === &#39;pr&#39;"[^>]*>/);
    expect(otherHint).not.toBeNull();
    expect(otherHint?.[0]).toContain("display:none");
  });

  test("the rendered options are exactly the units the island will send", () => {
    // Three lists exist: the server allowlist, the island's literals, and
    // this component's own render list (which carries labels + hints, so it
    // cannot simply import the others). The island↔server pair is asserted in
    // the island test; THIS is the missing third edge. Without it, adding a
    // unit here renders a clickable option that save() refuses as
    // "unknown review unit".
    const html = render("commit");
    const rendered = [...html.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    expect(rendered.length).toBeGreaterThan(0);
    expect(new Set(rendered)).toEqual(new Set(REVIEW_UNITS));
  });

  test("the island's own container carries data-secret", () => {
    // The Save POST reads the secret via closest("[data-secret]"), which
    // includes self. Layout's secret reaches this page as htmx `hx-headers`
    // and as FloatingChat's `data-secret` — a SIBLING, not an ancestor — so
    // an island relying on either resolves "" and every save 401s (memory
    // `dashboard-write-island-secret-closest`).
    const html = render("commit");
    const island = html.match(/<div[^>]*x-data="reviewUnitRow"[^>]*>/);
    expect(island).not.toBeNull();
    expect(island?.[0]).toContain('data-secret="s3cr3t"');
    expect(island?.[0]).toContain('data-review-unit="commit"');
  });
});

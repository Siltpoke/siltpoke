// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * ⏱ Review-unit control — which unit of work closes before a review is
 * considered (`commit` | `pr`, spec D8).
 *
 * It is served at `/timeline` because that page already answers "why is
 * siltpoke talking / not talking right now", and this is the setting that
 * decides when it gets to talk at all.
 *
 * It is that page's FIRST config-writing control — the only `data-secret`
 * under `src/web/screens/timeline/` is this file. An earlier draft of this
 * comment claimed it was the second, "alongside the budget editor": that was
 * false. `BudgetEditor` rides `BudgetGauge`, which only `src/web/screens/
 * Home.tsx:216` renders. The cross-page precedent for a write island is real
 * and is there, on `/`; it is simply not on this page.
 *
 * WHY IT IS NOT WHERE #677 PUT IT. That slice added the `<select>` to
 * `src/cli/report-artifacts.ts` and four golden fixtures asserted its markup,
 * so every layer read green — but the report page is retired
 * (`src/daemon/server.ts`: "its legacy GET /dashboard report page is
 * retired") and `buildReport` has no caller in `src/`. The obvious
 * replacement, `/settings`, is ALSO unreachable: its mount is commented out
 * (2026-08-06, judged not to earn its place). So the control had no reachable home at
 * all while the plan, the close report, and `review-unit-config.ts`'s own doc
 * comment each said the dashboard wrote it. A markup assertion says nothing
 * about reachability (memory `signal-decoupled-from-reality`), which is why
 * the e2e for this drives `/timeline` and not a rendered string.
 *
 * Compact by design: Timeline is a dense observability page, so this is one
 * line — no explanatory paragraph — and the per-unit hint rides inline.
 */
import { REVIEW_UNITS as UNITS, type ReviewUnit } from "../../../router/review-unit";
import { tokens } from "../../tokens/tokens";

/** One line of copy per unit. The VALUES are not restated here — they are
 * derived from `UNITS` (src/router/review-unit.ts), so this list can never
 * offer an option the island would refuse. Only the human-readable hint is
 * local, which is the part the decision module has no business carrying. */
const HINT: Record<ReviewUnit, string> = {
  commit: "every new commit",
  pr: "only once the branch has a PR",
};
const REVIEW_UNITS: ReadonlyArray<{ value: ReviewUnit; label: string; what: string }> = UNITS.map(
  (value) => ({ value, label: value, what: HINT[value] }),
);

export interface ReviewUnitRowProps {
  /** Daemon secret — rendered on the island's OWN container so the Save POST
   * can read it via closest("[data-secret]"), which includes self. Layout's
   * secret reaches the page as htmx `hx-headers` and FloatingChat's
   * `data-secret` sibling, neither of which closest() would find
   * (memory `dashboard-write-island-secret-closest`). */
  secret: string;
  /**
   * Resolved from config.json by the route, NOT defaulted here. A component
   * that picked its own default would render `commit` selected over a config
   * saying `pr` — the failure the `pr`-side assertion in
   * `tests/web/timeline-review-unit.test.tsx` pins.
   */
  reviewUnit: ReviewUnit;
}

export function ReviewUnitRow({ secret, reviewUnit }: ReviewUnitRowProps) {
  return (
    <div
      // No `x-init="init()"`: Alpine already invokes a data object's own
      // `init` (`reactiveData["init"] && evaluate(el, ...)` in its module
      // build), so the explicit directive is a second call. The islands on
      // the unmounted Settings screen carry it, but that screen has never
      // been exercised in a browser, so it is not a precedent.
      x-data="reviewUnitRow"
      data-secret={secret}
      data-review-unit={reviewUnit}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        fontFamily: tokens.font.mono,
        fontSize: 11,
        color: tokens.color.ink3,
      }}
    >
      <span style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>review fires on</span>

      <select
        x-model="unit"
        // Clearing `saved` on change is not cosmetic: without it the button
        // keeps reading "Saved ✓" after the user picks the OTHER unit, i.e.
        // it asserts a save that no longer describes the form — the exact
        // false-green this slice exists to stop.
        x-on:change="saved = false; error = ''"
        aria-label="Review unit"
        data-review-unit-select="true"
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 11,
          color: tokens.color.ink,
          background: tokens.color.paperD,
          border: `1px solid ${tokens.color.edge}`,
          borderRadius: tokens.radius.sm,
          padding: "2px 6px",
        }}
      >
        {REVIEW_UNITS.map((u) => (
          <option value={u.value} selected={u.value === reviewUnit}>
            {u.label}
          </option>
        ))}
      </select>

      {/* The server-side `display` matters: `x-show` alone leaves BOTH hints
          painted until Alpine hydrates — "every new commit only once the
          branch has a PR", two contradictory sentences — and permanently so
          with JS off. */}
      {REVIEW_UNITS.map((u) => (
        <span
          x-show={`unit === '${u.value}'`}
          style={{
            color: tokens.color.ink3,
            display: u.value === reviewUnit ? undefined : "none",
          }}
        >
          {u.what}
        </span>
      ))}

      <button
        type="button"
        x-on:click="save()"
        x-bind:disabled="saving"
        data-review-unit-save="true"
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 10,
          color: tokens.color.paper,
          background: tokens.color.ink2,
          border: "none",
          borderRadius: tokens.radius.sm,
          padding: "2px 8px",
          cursor: "pointer",
        }}
      >
        <span x-text="saving ? 'Saving…' : (saved ? 'Saved ✓' : 'Save')">Save</span>
      </button>
      <span
        x-show="error"
        x-text="error"
        data-review-unit-error="true"
        style={{ color: tokens.color.terra }}
      />
    </div>
  );
}

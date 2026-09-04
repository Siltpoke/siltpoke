// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * reviewUnitRow island — the ⏱ review-unit control served at `/timeline`.
 *
 * Picks the unit of work that closes before a review is considered
 * (`commit` | `pr`, spec D8) and Saves it to POST /api/config, whose
 * allowlist already accepts `reviewUnit` and rejects anything that is not
 * one of the two values (`sanitizeConfigPatch`).
 *
 * WHY `/timeline` AND NOT WHERE #677 PUT IT. That slice put this `<select>`
 * in `src/cli/report-artifacts.ts`. That page is the retired tamagotchi
 * report: `src/daemon/server.ts` says "its legacy GET /dashboard report page
 * is retired", and `buildReport` has no caller anywhere in `src/`. Four
 * golden fixtures asserted the select's HTML, so every layer read green while
 * no user could reach the control. `/settings` — the obvious second home — is
 * unmounted too (`src/daemon/server.ts`, 2026-08-06). The lesson is not "add
 * a test", since the old tests passed: it is that a markup assertion says
 * nothing about reachability (memory `signal-decoupled-from-reality`), and
 * that a page NAME is not a checkable destination — only a mounted route is.
 * So this comment names the route, `/timeline`, not "the dashboard".
 *
 * The secret is read from the row's OWN `data-secret` container (closest()
 * includes self) — FloatingChat's data-secret is a sibling, not an ancestor,
 * so a bare closest() would miss (memory `dashboard-write-island-secret-closest`).
 *
 * Registration: document.addEventListener("alpine:init", ...) before
 * Alpine.start(). Imported by src/web/client/index.ts. Never addEventListener
 * on island DOM (hx-boost morph drops direct listeners) — bind via x-on:* .
 */

/** The units come from `src/router/review-unit.ts` — the decision module,
 * which has no imports of its own, so the browser bundle pays nothing for
 * sharing it. An earlier version restated them here "to avoid pulling a
 * server module in"; that bought nothing and left the `<select>`'s list and
 * this one free to drift apart. `tests/web/client/islands/review-unit.test.ts`
 * still asserts the shared list against the SERVER's allowlist, which is
 * spelled out separately on purpose. */
import { REVIEW_UNITS, isReviewUnit } from "../../../router/review-unit";

export { REVIEW_UNITS, isReviewUnit };

export interface ReviewUnitRowData {
  unit: string;
  saving: boolean;
  saved: boolean;
  error: string;
  init(): void;
  save(): Promise<void>;
}


/**
 * Read the server's answer and return the reason this save did NOT land, or
 * `null` if it did. Split out of `save()` to give each one job — `save()`
 * owns the request and the flags, this owns the interpretation.
 *
 * Deliberately NOT exported: nothing outside this module needs it, and the
 * tests reach every branch through `save()`, which is the path a user
 * actually takes. Exporting it "so it can be tested directly" would add a
 * public symbol no caller wants.
 *
 * Every branch returns a reason; none of them guesses one. That is the whole
 * point: this is the layer where a wrong answer becomes a green checkmark
 * over a write that never happened.
 */
async function readSaveFailure(res: Response, wanted: string): Promise<string | null> {
  let body: { ok?: boolean; error?: string; config?: Record<string, unknown> };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // The response arrived but was not JSON — say so, do not blame the
    // network (see the fetch-only catch in `save()`).
    return `save failed — unreadable response (HTTP ${res.status})`;
  }
  if (!res.ok || !body.ok) return body.error ?? `save failed (HTTP ${res.status})`;
  // Confirm from the SERVER's merged config, not from the fact that the
  // request returned 200. The route sanitises before merging, so a value it
  // declined comes back as the old one — reporting "Saved ✓" off the status
  // code alone would be a green light for a write that did not happen
  // (memory `stubbed-writer-proves-nothing-about-disk`).
  const persisted = body.config?.reviewUnit;
  if (persisted === undefined) {
    // Not `?? "commit"`. A response without `config` (an older daemon, a
    // proxy-rewritten body) would then be reported as the specific, invented
    // fact "server kept commit" while the write may well have landed — a
    // guard inventing a fresh falsehood on the input it was not written for
    // (memory `guard-becomes-the-new-distortion`).
    return "saved, but the server did not report the stored value";
  }
  if (persisted !== wanted) return `not saved — server kept ${String(persisted)}`;
  return null;
}

export function makeReviewUnitRow(): ReviewUnitRowData {
  return {
    unit: "commit",
    saving: false,
    saved: false,
    error: "",

    init(): void {
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      const fromDom = (el?.dataset.reviewUnit ?? "").trim();
      // An unrecognised attribute falls back to `commit` rather than being
      // carried into state: `save()` would then POST a value the server
      // silently drops, and the row would show "Saved ✓" over a config that
      // never changed. Same direction as `loadReviewUnit`'s unreadable-config
      // fallback — the more talkative unit wins.
      this.unit = isReviewUnit(fromDom) ? fromDom : "commit";
    },

    async save(): Promise<void> {
      if (this.saving) return;
      if (!isReviewUnit(this.unit)) {
        this.error = `unknown review unit: ${this.unit}`;
        return;
      }
      const wanted = this.unit;
      this.saving = true;
      this.saved = false;
      this.error = "";
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      const secret = el?.closest("[data-secret]")?.getAttribute("data-secret") ?? "";
      let res: Response;
      try {
        res = await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": secret },
          body: JSON.stringify({ reviewUnit: wanted }),
        });
      } catch {
        // ONLY the fetch is guarded here. An earlier version wrapped the JSON
        // parse too, so a 500 with a non-JSON body (a failed `saveConfig` —
        // EACCES, disk full) was reported as "is the daemon running?" while
        // the daemon was answering. Never a false green, but a misdirected
        // diagnosis is still a wrong answer.
        this.error = "network error — is the daemon running?";
        this.saving = false;
        return;
      }
      const failure = await readSaveFailure(res, wanted);
      this.error = failure ?? "";
      this.saved = failure === null;
      this.saving = false;
    },
  };
}

document.addEventListener("alpine:init", () => {
  (globalThis as { Alpine?: { data: (name: string, factory: () => unknown) => void } }).Alpine?.data(
    "reviewUnitRow",
    () => makeReviewUnitRow(),
  );
});

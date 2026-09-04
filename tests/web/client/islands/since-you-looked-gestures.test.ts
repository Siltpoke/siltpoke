// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * since-you-looked tests, part 3/3 — the gesture-only advance/mark-all
 * contract (the binding correction this task was built against). See
 * `since-you-looked.test.ts` for the split rationale and
 * `_since-you-looked-harness.ts` for the shared fixtures/mount helper.
 *
 * e/f. The advance POST fires ONLY from a real `click` or
 *      `keydown`(Enter|Space) dispatched on a row's disclosure control —
 *      never from mount. A successful advance triggers a re-fetch (C13):
 *      the second GET's response no longer contains the advanced path, and
 *      the row disappears from the DOM.
 * g.   "mark all seen" — same click-bound + re-fetch contract, repo-level.
 * h.   In-flight guard: a second click while the first advance is still
 *      in-flight does not fire a second POST.
 *
 * Run: bun test tests/web/client/islands/since-you-looked-gestures.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { deferred, registerDom, unregisterDom } from "./_dom-harness";
import { DELTA_A, DELTA_B, REPO, SECRET, apiData, mockFetch, mountSinceYouLooked, rows, tick } from "./_since-you-looked-harness";

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data, error: null }), {
    headers: { "content-type": "application/json" },
  });
}

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});
afterEach(() => {
  document.body.innerHTML = "";
});

// ── (e/f) advance — click/keydown ONLY, then re-fetch (C13) ────────────────

describe("advance — bound exclusively to click/keydown(Enter|Space), then re-fetches", () => {
  test("click on the disclosure control fires exactly one POST /seen/advance with {repo,path}", async () => {
    let getCalls = 0;
    let advanceCalls = 0;
    const advanceBodies: unknown[] = [];
    const advanceHeaders: Array<Record<string, string>> = [];
    mockFetch([
      [
        "/api/repo-graph/seen?repo=",
        () => {
          getCalls += 1;
          const data = getCalls === 1 ? apiData({ deltas: [DELTA_A, DELTA_B] }) : apiData({ deltas: [DELTA_B] });
          return Promise.resolve(jsonOk(data));
        },
      ],
      [
        "/seen/advance",
        (_url, init) => {
          advanceCalls += 1;
          advanceBodies.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")));
          advanceHeaders.push((init as RequestInit)?.headers as Record<string, string>);
          return Promise.resolve(jsonOk({ advanced: true }));
        },
      ],
    ]);

    const root = await mountSinceYouLooked();
    await tick();
    await tick();
    expect(rows(root).length).toBe(2);

    const disclosureA = root.querySelector<HTMLElement>('.syl-row-disclosure[data-path="src/alpha/a.ts"]');
    expect(disclosureA).not.toBeNull();
    disclosureA!.click();
    await tick();
    await tick();
    await tick();

    expect(advanceCalls).toBe(1);
    expect(advanceBodies[0]).toEqual({ repo: REPO, path: "src/alpha/a.ts" });
    expect(advanceHeaders[0]?.["X-Siltpoke-Secret"]).toBe(SECRET);

    // C13: the successful advance triggered a re-fetch (2nd GET), and the
    // advanced row is gone from the DOM.
    expect(getCalls).toBe(2);
    expect(rows(root).length).toBe(1);
    expect(root.querySelector('.syl-row[data-path="src/alpha/a.ts"]')).toBeNull();
  });

  test("keydown Enter on the disclosure fires the same advance POST", async () => {
    let advanceCalls = 0;
    mockFetch([
      ["/api/repo-graph/seen?repo=", () => Promise.resolve(jsonOk(apiData({ deltas: [DELTA_A] })))],
      [
        "/seen/advance",
        () => {
          advanceCalls += 1;
          return Promise.resolve(jsonOk({ advanced: true }));
        },
      ],
    ]);

    const root = await mountSinceYouLooked();
    await tick();
    await tick();

    const disclosure = root.querySelector<HTMLElement>(".syl-row-disclosure");
    expect(disclosure).not.toBeNull();
    disclosure!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    await tick();

    expect(advanceCalls).toBe(1);
  });

  test("keydown Space on the disclosure fires the same advance POST", async () => {
    let advanceCalls = 0;
    mockFetch([
      ["/api/repo-graph/seen?repo=", () => Promise.resolve(jsonOk(apiData({ deltas: [DELTA_A] })))],
      [
        "/seen/advance",
        () => {
          advanceCalls += 1;
          return Promise.resolve(jsonOk({ advanced: true }));
        },
      ],
    ]);

    const root = await mountSinceYouLooked();
    await tick();
    await tick();

    const disclosure = root.querySelector<HTMLElement>(".syl-row-disclosure");
    disclosure!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await tick();
    await tick();

    expect(advanceCalls).toBe(1);
  });

  test("an unrelated keydown (e.g. 'a') does NOT fire advance", async () => {
    let advanceCalls = 0;
    mockFetch([
      ["/api/repo-graph/seen?repo=", () => Promise.resolve(jsonOk(apiData({ deltas: [DELTA_A] })))],
      [
        "/seen/advance",
        () => {
          advanceCalls += 1;
          return Promise.resolve(jsonOk({ advanced: true }));
        },
      ],
    ]);

    const root = await mountSinceYouLooked();
    await tick();
    await tick();

    const disclosure = root.querySelector<HTMLElement>(".syl-row-disclosure");
    disclosure!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await tick();

    expect(advanceCalls).toBe(0);
  });

  test("in-flight guard: a second click while the first advance is still in flight fires only one POST", async () => {
    let advanceCalls = 0;
    const hold = deferred<Response>();
    mockFetch([
      ["/api/repo-graph/seen?repo=", () => Promise.resolve(jsonOk(apiData({ deltas: [DELTA_A] })))],
      [
        "/seen/advance",
        () => {
          advanceCalls += 1;
          return hold.promise;
        },
      ],
    ]);

    const root = await mountSinceYouLooked();
    await tick();
    await tick();

    const disclosure = root.querySelector<HTMLElement>(".syl-row-disclosure");
    disclosure!.click();
    disclosure!.click();
    await tick();

    expect(advanceCalls).toBe(1);

    hold.resolve(jsonOk({ advanced: true }));
    await tick();
    await tick();
  });
});

// ── (g) mark-all — click-bound, then re-fetches ─────────────────────────────

describe("mark all seen — click-bound, then re-fetches", () => {
  test("clicking #syl-mark-all fires POST /seen/mark-all with {repo}, then re-fetches", async () => {
    let getCalls = 0;
    let markAllCalls = 0;
    const markAllBodies: unknown[] = [];
    mockFetch([
      [
        "/api/repo-graph/seen?repo=",
        () => {
          getCalls += 1;
          const data = getCalls === 1 ? apiData({ deltas: [DELTA_A, DELTA_B] }) : apiData({ deltas: [] });
          return Promise.resolve(jsonOk(data));
        },
      ],
      [
        "/seen/mark-all",
        (_url, init) => {
          markAllCalls += 1;
          markAllBodies.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")));
          return Promise.resolve(jsonOk({ marked: true }));
        },
      ],
    ]);

    const root = await mountSinceYouLooked();
    await tick();
    await tick();
    expect(rows(root).length).toBe(2);

    const markAllBtn = root.querySelector<HTMLButtonElement>("#syl-mark-all");
    expect(markAllBtn).not.toBeNull();
    expect(markAllBtn!.hidden).toBe(false);
    markAllBtn!.click();
    await tick();
    await tick();
    await tick();

    expect(markAllCalls).toBe(1);
    expect(markAllBodies[0]).toEqual({ repo: REPO });
    expect(getCalls).toBe(2);
    expect(rows(root).length).toBe(0);
    expect(root.querySelector("#syl-empty")?.hasAttribute("hidden")).toBe(false);
  });
});

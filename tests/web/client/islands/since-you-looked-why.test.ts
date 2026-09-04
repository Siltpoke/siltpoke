// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * since-you-looked WHY cell tests (slice ④, task 6). The panel is
 * client-rendered (Alpine island, imperative DOM) — there is no SSR delta
 * row to test, so this is the display-side coverage for the `why:
 * WhyAnchor` the real `GET /seen` route now attaches per delta
 * (`src/daemon/routes/seen-why.ts`). See `since-you-looked.test.ts` for the
 * split rationale + shared fixtures.
 *
 * Run: bun test tests/web/client/islands/since-you-looked-why.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { whyCopy } from "../../../../src/web/client/islands/since-you-looked";
import { registerDom, unregisterDom } from "./_dom-harness";
import { DELTA_A, DELTA_B, apiData, mockFetch, mountSinceYouLooked, rows, tick } from "./_since-you-looked-harness";

// ═══════════════════════════════════════════════════════════════════════════
// 1. PURE whyCopy() — honest anchor prose, no causal claims
// ═══════════════════════════════════════════════════════════════════════════

describe("whyCopy — honest anchor prose per rung, never a causal claim", () => {
  test("rung U — uncommitted", () => {
    expect(whyCopy({ rung: "U", anchor_scope: "uncommitted" })).toBe("changed on disk · not yet committed");
  });

  test("rung 1 — quotes the user's ask", () => {
    expect(whyCopy({ rung: 1, anchor_scope: "turn", user_ask: "add login validation" })).toBe(
      'you asked: "add login validation"',
    );
  });

  test("rung 2 — points at the session/transcript, not a specific turn", () => {
    expect(whyCopy({ rung: 2, anchor_scope: "session", session_id: "s9" })).toBe(
      "changed in session s9 · open transcript",
    );
  });

  test("rung 3 — no WHY recorded", () => {
    expect(whyCopy({ rung: 3, anchor_scope: "none" })).toBe("no WHY recorded");
  });

  test("undefined why (defensive) — degrades to the same rung-3 copy", () => {
    expect(whyCopy(undefined)).toBe("no WHY recorded");
  });

  test("no forbidden causal vocabulary in any state", () => {
    const forbidden = ["because", "the reason", "caused", "due to"];
    const all = [
      whyCopy({ rung: "U", anchor_scope: "uncommitted" }),
      whyCopy({ rung: 1, anchor_scope: "turn", user_ask: "x" }),
      whyCopy({ rung: 2, anchor_scope: "session", session_id: "s1" }),
      whyCopy({ rung: 3, anchor_scope: "none" }),
    ];
    for (const copy of all) {
      for (const bad of forbidden) {
        expect(copy.toLowerCase()).not.toContain(bad);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. DOM-MOUNT — each row renders its WHY cell from the fetched payload
// ═══════════════════════════════════════════════════════════════════════════

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

describe("WHY cell renders per row from the real response shape", () => {
  test("rung 1 row renders a <span> with the quoted ask; rung absent (older payload) degrades to 'no WHY recorded'", async () => {
    const withWhy = { ...DELTA_A, why: { rung: 1 as const, anchor_scope: "turn" as const, user_ask: "fix the login bug" } };
    mockFetch([
      ["/api/repo-graph/seen?repo=", () => Promise.resolve(jsonOk(apiData({ deltas: [withWhy, DELTA_B] })))],
    ]);

    const root = await mountSinceYouLooked();
    await tick();
    await tick();

    const rowEls = rows(root);
    expect(rowEls.length).toBe(2);

    const rowA = rowEls.find((r) => r.dataset.path === DELTA_A.path);
    const whyA = rowA?.querySelector(".syl-row-why");
    expect(whyA?.tagName).toBe("SPAN");
    expect(whyA?.textContent).toBe('you asked: "fix the login bug"');

    // DELTA_B carries no `why` at all (defensive/older-payload shape) — the
    // row must still render, degraded to the rung-3 copy, never crash.
    const rowB = rowEls.find((r) => r.dataset.path === DELTA_B.path);
    const whyB = rowB?.querySelector(".syl-row-why");
    expect(whyB?.textContent).toBe("no WHY recorded");
  });

  test("rung 2 row renders an <a> pointing at the transcript file", async () => {
    const withWhy = {
      ...DELTA_A,
      why: { rung: 2 as const, anchor_scope: "session" as const, session_id: "sess-7", transcript_path: "/tmp/t.jsonl" },
    };
    mockFetch([["/api/repo-graph/seen?repo=", () => Promise.resolve(jsonOk(apiData({ deltas: [withWhy] })))]]);

    const root = await mountSinceYouLooked();
    await tick();
    await tick();

    const whyEl = rows(root)[0]?.querySelector(".syl-row-why");
    expect(whyEl?.tagName).toBe("A");
    expect((whyEl as HTMLAnchorElement).getAttribute("href")).toBe("file:///tmp/t.jsonl");
    expect(whyEl?.textContent).toBe("changed in session sess-7 · open transcript");
  });

  test("rung U row renders a plain <span>, not a link", async () => {
    const withWhy = { ...DELTA_A, why: { rung: "U" as const, anchor_scope: "uncommitted" as const } };
    mockFetch([["/api/repo-graph/seen?repo=", () => Promise.resolve(jsonOk(apiData({ deltas: [withWhy] })))]]);

    const root = await mountSinceYouLooked();
    await tick();
    await tick();

    const whyEl = rows(root)[0]?.querySelector(".syl-row-why");
    expect(whyEl?.tagName).toBe("SPAN");
    expect(whyEl?.textContent).toBe("changed on disk · not yet committed");
  });
});

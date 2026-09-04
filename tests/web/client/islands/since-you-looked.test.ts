// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * since-you-looked tests, part 1/3 — slice ③ task 6 ("since you last looked"
 * panel). Split across three sibling files (this one, `-baseline.test.ts`,
 * `-gestures.test.ts`) to stay under the `lint:files` 400 LOC ratchet; shared
 * fixtures/mount-helper live in `_since-you-looked-harness.ts`.
 *
 * This file:
 * 1. Pure-function tests (no DOM) — dirOf / baseNameOf / statusTag /
 *    groupByDirectory. Neutral-tag + grouping contract, in isolation.
 * 2. DOM-mount tests (real happy-dom + mocked fetch, per the
 *    `_dom-harness.ts` pattern `repo-graph-regen-affordance.test.ts` uses):
 *    a. init() fires exactly ONE GET (`/api/repo-graph/seen`) and ZERO
 *       POSTs — proven even after a scroll dispatch, since nothing in this
 *       island is bound to scroll/IntersectionObserver.
 *    b. Rendered rows are grouped by directory with neutral status tags;
 *       none of the forbidden score/urgency vocabulary appears anywhere in
 *       the panel.
 *
 * Run: bun test tests/web/client/islands/since-you-looked.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { SeenFileDelta } from "../../../../src/repo-graph/types";
import { baseNameOf, dirOf, groupByDirectory, statusTag } from "../../../../src/web/client/islands/since-you-looked";
import { registerDom, unregisterDom } from "./_dom-harness";
import { DELTA_A, DELTA_B, apiData, mockFetch, mountSinceYouLooked, rows, tick } from "./_since-you-looked-harness";

// ═══════════════════════════════════════════════════════════════════════════
// 1. PURE-FUNCTION TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("dirOf / baseNameOf", () => {
  test("nested path splits into dir (trailing slash) + basename", () => {
    expect(dirOf("src/alpha/a.ts")).toBe("src/alpha/");
    expect(baseNameOf("src/alpha/a.ts")).toBe("a.ts");
  });

  test("root-level path has empty dir", () => {
    expect(dirOf("root.ts")).toBe("");
    expect(baseNameOf("root.ts")).toBe("root.ts");
  });
});

describe("statusTag — neutral prose only, no score/urgency vocabulary", () => {
  function delta(overrides: Partial<SeenFileDelta>): SeenFileDelta {
    return {
      path: "src/x.ts",
      baseline_status: "tracked",
      signature_changed: false,
      body_changed: false,
      unparseable: false,
      ...overrides,
    };
  }

  test("tracked + signature + body → composed tag", () => {
    expect(statusTag(delta({ signature_changed: true, body_changed: true }))).toBe(
      "signature changed · body changed",
    );
  });

  test("tracked + signature only", () => {
    expect(statusTag(delta({ signature_changed: true }))).toBe("signature changed");
  });

  test("tracked + body only", () => {
    expect(statusTag(delta({ body_changed: true }))).toBe("body changed");
  });

  test("new_to_you", () => {
    expect(statusTag(delta({ baseline_status: "new_to_you" }))).toBe("new to you");
  });

  test("deleted", () => {
    expect(statusTag(delta({ baseline_status: "deleted" }))).toBe("deleted");
  });

  test("unparseable appends a plain caveat, not a color/exclamation", () => {
    expect(statusTag(delta({ baseline_status: "new_to_you", unparseable: true }))).toBe(
      "new to you · unparseable",
    );
  });

  test("no forbidden vocabulary in any tag", () => {
    const forbidden = ["missed", "unreviewed", "unseen", "score", "!"];
    const all = [
      delta({ signature_changed: true }),
      delta({ body_changed: true }),
      delta({ baseline_status: "new_to_you" }),
      delta({ baseline_status: "deleted" }),
    ].map(statusTag);
    for (const tag of all) {
      for (const bad of forbidden) {
        expect(tag.toLowerCase()).not.toContain(bad);
      }
    }
  });
});

describe("groupByDirectory — grouping/order is the ONLY rule, no severity sort", () => {
  test("groups by directory, root ('') sorts first, files sorted within a group", () => {
    const deltas: SeenFileDelta[] = [
      { path: "src/beta/c.ts", baseline_status: "tracked", signature_changed: true, body_changed: false, unparseable: false },
      { path: "root.ts", baseline_status: "new_to_you", signature_changed: false, body_changed: false, unparseable: false },
      { path: "src/alpha/b.ts", baseline_status: "tracked", signature_changed: false, body_changed: true, unparseable: false },
      { path: "src/alpha/a.ts", baseline_status: "deleted", signature_changed: false, body_changed: false, unparseable: false },
    ];
    const groups = groupByDirectory(deltas);
    expect(groups.map((g) => g.dir)).toEqual(["", "src/alpha/", "src/beta/"]);
    expect(groups[1]!.files.map((f) => f.path)).toEqual(["src/alpha/a.ts", "src/alpha/b.ts"]);
    expect(groups[2]!.files.map((f) => f.path)).toEqual(["src/beta/c.ts"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. DOM-MOUNT TESTS
// ═══════════════════════════════════════════════════════════════════════════

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});
afterEach(() => {
  document.body.innerHTML = "";
});

// ── (a) init() fires exactly one GET, zero POSTs — even across a scroll ────

describe("init() — lazy GET only, never a mutating call, never from scroll", () => {
  test("mounting fires exactly one GET to /seen and zero POSTs", async () => {
    let getCalls = 0;
    let postCalls = 0;
    mockFetch([
      [
        "/api/repo-graph/seen?repo=",
        () => {
          getCalls += 1;
          return Promise.resolve(jsonOk(apiData()));
        },
      ],
      [
        "/seen/advance",
        () => {
          postCalls += 1;
          return Promise.resolve(jsonOk({ advanced: true }));
        },
      ],
      [
        "/seen/mark-all",
        () => {
          postCalls += 1;
          return Promise.resolve(jsonOk({ marked: true }));
        },
      ],
    ]);

    const root = await mountSinceYouLooked();
    await tick();
    await tick();

    expect(getCalls).toBe(1);
    expect(postCalls).toBe(0);

    // Dispatch a scroll event at both window and panel level — this island
    // binds no IntersectionObserver/scroll listener, so nothing should fire.
    window.dispatchEvent(new Event("scroll"));
    root.dispatchEvent(new Event("scroll", { bubbles: true }));
    await tick();

    expect(getCalls).toBe(1);
    expect(postCalls).toBe(0);
  });
});

// ── (b) grouped rows + neutral tags, no forbidden vocabulary ────────────────

describe("render — grouped rows, neutral tags, no forbidden vocabulary", () => {
  test("renders one .syl-dir-group per directory with neutral tags", async () => {
    mockFetch([
      [
        "/api/repo-graph/seen?repo=",
        () => Promise.resolve(jsonOk(apiData({ deltas: [DELTA_A, DELTA_B] }))),
      ],
    ]);

    const root = await mountSinceYouLooked();
    await tick();
    await tick();

    const groups = root.querySelectorAll(".syl-dir-group");
    expect(groups.length).toBe(2);

    const rowEls = rows(root);
    expect(rowEls.length).toBe(2);
    const tags = rowEls.map((r) => r.querySelector(".syl-row-tag")?.textContent);
    expect(tags).toContain("signature changed");
    expect(tags).toContain("new to you");

    const forbidden = ["Unseen:", "missed", "unreviewed", "score"];
    const panelText = root.textContent ?? "";
    for (const bad of forbidden) {
      expect(panelText).not.toContain(bad);
    }
  });

  test("zero deltas (known baseline, nothing changed) → empty state, no rows", async () => {
    mockFetch([
      ["/api/repo-graph/seen?repo=", () => Promise.resolve(jsonOk(apiData({ deltas: [] })))],
    ]);

    const root = await mountSinceYouLooked();
    await tick();
    await tick();

    expect(root.querySelector("#syl-empty")?.hasAttribute("hidden")).toBe(false);
    expect(rows(root).length).toBe(0);
  });
});

// Local helper — wraps a data payload in the `{success:true,data,error:null}`
// envelope every repo-graph route uses. Uses the real `Response` ctor
// directly (not `_dom-harness.jsonResponse`) to keep this file's import
// surface small; behavior is identical (JSON body + content-type header).
function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data, error: null }), {
    headers: { "content-type": "application/json" },
  });
}

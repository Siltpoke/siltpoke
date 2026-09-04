// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * reviewUnitRow island — the ⏱ review-unit control's write path.
 *
 * The fixture DOM is the REAL SSR output of `TimelineScreen` — the screen
 * served at `/timeline` — not a hand-written `<div data-secret=…>`. A
 * hand-written fixture would keep passing after the screen stopped rendering
 * the island at all, which is exactly how #677's `<select>` stayed green on a
 * page nobody serves (memory `signal-decoupled-from-reality`).
 *
 * Per-file DOM scope: registerDom in beforeAll, unregisterDom in afterAll —
 * never a bunfig preload (see `_dom-harness.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { CriticTelemetry } from "../../../../src/state/api";
import { sanitizeConfigPatch } from "../../../../src/daemon/routes/dashboard";
import type { ReviewUnitRowData } from "../../../../src/web/client/islands/review-unit";
import { registerDom, unregisterDom } from "./_dom-harness";

/** The island self-registers on `document` at import time, so it must be
 * imported AFTER registerDom() — a static import evaluates first and dies on
 * `document is not defined` (same reason the harness imports RepoGraph
 * dynamically). Populated in beforeAll. */
let island: typeof import("../../../../src/web/client/islands/review-unit");

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

const SECRET = "s3cr3t";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Each call builds its OWN Response — a shared one is consumable exactly
 * once, and from the second test the island reads an empty body and the
 * failure presents as a bad assertion rather than a spent fixture
 * (memory `shared-response-in-fetch-mock-reads-empty`). */
function installConfigMock(
  reply: (patch: Record<string, unknown>) => { status: number; body: unknown },
): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const patch = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: patch });
    const { status, body } = reply(patch);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return sent;
}

/** Same shape, but the handler returns a RAW Response — for the paths where
 * the body is not JSON at all, which the JSON-only mock cannot express. */
function installRawMock(make: () => Response | Promise<never>): void {
  globalThis.fetch = (async () => make()) as unknown as typeof fetch;
}

/** Mount the island on the real SERVED screen's own markup. */
async function mount(reviewUnit: "commit" | "pr"): Promise<ReviewUnitRowData> {
  const { TimelineScreen } = await import("../../../../src/web/screens/TimelineScreen");
  document.body.innerHTML = String(
    TimelineScreen({ telemetry: TELEMETRY, secret: SECRET, reviewUnit }),
  );
  const el = document.querySelector<HTMLElement>('[x-data="reviewUnitRow"]');
  if (!el) throw new Error("TimelineScreen rendered no [x-data=reviewUnitRow] island");
  const row = island.makeReviewUnitRow();
  (row as unknown as { $el: HTMLElement }).$el = el;
  row.init();
  return row;
}

describe("reviewUnitRow island", () => {
  beforeAll(async () => {
    registerDom();
    island = await import("../../../../src/web/client/islands/review-unit");
  });
  afterAll(async () => {
    await unregisterDom();
  });
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("init reads the unit the server rendered, both ways", async () => {
    expect((await mount("pr")).unit).toBe("pr");
    // Negative control: a hardcoded `commit` would pass a `commit`-only test.
    expect((await mount("commit")).unit).toBe("commit");
  });

  test("save POSTs the unit to /api/config with the secret header", async () => {
    const row = await mount("commit");
    const sent = installConfigMock((p) => ({ status: 200, body: { ok: true, config: p } }));
    row.unit = "pr";
    await row.save();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain("/api/config");
    expect(sent[0]?.headers["X-Siltpoke-Secret"]).toBe(SECRET);
    expect(sent[0]?.body).toEqual({ reviewUnit: "pr" });
    expect(row.saved).toBe(true);
    expect(row.error).toBe("");
    expect(row.saving).toBe(false);
  });

  test("a 200 whose merged config kept the OLD unit is an error, not Saved ✓", async () => {
    // The route sanitises before merging, so a declined value comes back as
    // the old one under a perfectly good 200. Trusting the status code would
    // light "Saved ✓" over a write that never happened.
    const row = await mount("commit");
    installConfigMock(() => ({ status: 200, body: { ok: true, config: { reviewUnit: "commit" } } }));
    row.unit = "pr";
    await row.save();

    expect(row.saved).toBe(false);
    expect(row.error).toContain("not saved");
    expect(row.error).toContain("commit");
  });

  test("401 surfaces the server's error and does not claim success", async () => {
    const row = await mount("commit");
    installConfigMock(() => ({ status: 401, body: { error: "unauthorized" } }));
    row.unit = "pr";
    await row.save();

    expect(row.saved).toBe(false);
    expect(row.error).toBe("unauthorized");
    expect(row.saving).toBe(false);
  });

  test("a value outside the allowlist is refused before any request goes out", async () => {
    const row = await mount("commit");
    const sent = installConfigMock(() => ({ status: 200, body: { ok: true, config: {} } }));
    (row as { unit: string }).unit = "on_demand"; // one of the four dead trigger modes
    await row.save();

    expect(sent).toHaveLength(0);
    expect(row.saved).toBe(false);
    expect(row.error).toContain("on_demand");
  });

  test("a 200 that omits `config` says so instead of inventing a stored value", async () => {
    // `?? "commit"` here would report the specific, invented fact "server kept
    // commit" about a write that may well have landed — a guard manufacturing
    // a new falsehood on input it was not written for.
    const row = await mount("commit");
    installConfigMock(() => ({ status: 200, body: { ok: true } }));
    row.unit = "pr";
    await row.save();

    expect(row.saved).toBe(false);
    expect(row.error).toContain("did not report");
    expect(row.error).not.toContain("kept commit");
  });

  test("a non-JSON 500 is a save failure, not a network error", async () => {
    // The daemon IS answering; blaming the network sends the reader to the
    // wrong place. `saveConfig` failing on EACCES / a full disk lands here.
    const row = await mount("commit");
    installRawMock(() => new Response("<html>500</html>", { status: 500 }));
    row.unit = "pr";
    await row.save();

    expect(row.saved).toBe(false);
    expect(row.error).toContain("500");
    expect(row.error).not.toContain("network");
    expect(row.saving).toBe(false);
  });

  test("a genuine network failure still reads as one", async () => {
    // Negative control for the test above: with the fetch itself rejecting,
    // the network wording is the CORRECT answer, so the split must keep it.
    const row = await mount("commit");
    installRawMock(() => Promise.reject(new Error("ECONNREFUSED")));
    row.unit = "pr";
    await row.save();

    expect(row.saved).toBe(false);
    expect(row.error).toContain("network");
    expect(row.saving).toBe(false);
  });

  test("the island's unit list is exactly what the server accepts", () => {
    // Drift guard in both directions: a unit the island offers but the server
    // drops would "save" into nothing; one the server takes but the island
    // omits would be unreachable — the defect this whole slice fixes.
    for (const u of island.REVIEW_UNITS) {
      expect(sanitizeConfigPatch({ reviewUnit: u })).toEqual({ reviewUnit: u });
    }
    expect(sanitizeConfigPatch({ reviewUnit: "on_demand" })).toEqual({});
  });
});

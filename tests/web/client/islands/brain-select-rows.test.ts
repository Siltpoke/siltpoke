// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The two Settings write-islands, `roleRow` and `builderRow`.
 *
 * Neither had ANY test before 2026-09-12 — the functions they call were covered
 * and the wiring that sends the request was not, which is how a `family ===
 * "claude"` literal sat in the browser half for months contradicting the server
 * (spec brain-select-four-gaps §2.5 / §3.1).
 *
 * These drive the islands directly with a stub `$el` and a capturing `fetch`, so
 * they assert what actually goes over the wire: method, URL, and body.
 *
 * DOM setup is top-level, not in beforeAll: both modules call
 * `document.addEventListener` at import time, and imports run before any hook.
 * Same per-file scope rule as `_dom-harness.ts` — never preload this globally.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Captured BEFORE register(), which swaps globalThis.fetch for happy-dom's.
const realFetch = globalThis.fetch;
GlobalRegistrator.register({ url: "http://127.0.0.1:9876/settings" });

const { makeRoleRow } = await import("../../../../src/web/client/islands/role-row");
const { makeBuilderRow } = await import("../../../../src/web/client/islands/brain-settings");

interface Sent {
  url: string;
  method: string;
  body: unknown;
  secret: string | null;
}

let sent: Sent[] = [];

function stubFetch(ok = true): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      secret: headers["X-Siltpoke-Secret"] ?? null,
    });
    return new Response(JSON.stringify(ok ? { ok: true } : { error: "nope" }), {
      status: ok ? 200 : 400,
    });
  }) as unknown as typeof fetch;
}

/** A stand-in for Alpine's `$el`: dataset plus a closest() that finds a secret. */
function fakeEl(dataset: Record<string, string>): HTMLElement {
  return {
    dataset,
    closest: (_sel: string) => ({ getAttribute: (_a: string) => "s3cret" }),
  } as unknown as HTMLElement;
}

function bind<T>(island: T, el: HTMLElement): T {
  (island as unknown as { $el: HTMLElement }).$el = el;
  return island;
}

beforeEach(() => {
  sent = [];
  stubFetch();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
});

const CAPABLE = "claude,agy,qoder,codebuddy";

describe("roleRow", () => {
  test("an UNPINNED role opens on 'follow the building agent', not its resolved family", () => {
    // The row renders the family the role resolved TO. If the select opened on
    // that, pressing Save would pin what had only ever been a default.
    const row = bind(makeRoleRow(), fakeEl({ role: "review", family: "codex", model: "" }));
    row.init();
    expect(row.family).toBe("");
  });

  // Found in review: `data-pinned` was `source === "pinned here"`, but a review
  // pinned through `reviewer_provider` or SILTPOKE_REVIEWER_PROVIDER reports a
  // different source. The select opened on "(follow the building agent)", and an
  // untouched Save then sent DELETE — which removes `brain.roles.review`, a key
  // that pin never used — so the call succeeded, the UI said "saved", and the
  // reviewer stayed pinned. The page now sets data-pinned for ANY explicit pin.
  test("a role pinned by any mechanism opens on its family, not on 'follow'", () => {
    for (const family of ["agy", "qoder"]) {
      const row = bind(
        makeRoleRow(),
        fakeEl({ role: "review", family, model: "", pinned: "1" }),
      );
      row.init();
      expect(row.family).toBe(family);
    }
  });

  test("a PINNED role opens on its pinned family", () => {
    const row = bind(
      makeRoleRow(),
      fakeEl({ role: "review", family: "qoder", model: "qwen3-max", pinned: "1" }),
    );
    row.init();
    expect(row.family).toBe("qoder");
    expect(row.model).toBe("qwen3-max");
  });

  test("saving with no family DELETEs the pin", async () => {
    const row = bind(makeRoleRow(), fakeEl({ role: "review", family: "qoder", model: "" }));
    row.init();
    await row.save();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("DELETE");
    expect(sent[0]!.url).toBe("/api/brain/roles/review");
    expect(sent[0]!.secret).toBe("s3cret");
  });

  test("sends the model for every family whose CLI takes one", async () => {
    for (const family of ["claude", "agy", "qoder", "codebuddy"]) {
      sent = [];
      const row = bind(
        makeRoleRow(),
        fakeEl({
          role: "review",
          family,
          model: "picked-model",
          pinned: "1",
          modelCapable: CAPABLE,
        }),
      );
      row.init();
      expect(row.acceptsModel()).toBe(true);
      await row.save();
      expect(sent[0]!.method).toBe("POST");
      expect(sent[0]!.body).toEqual({ family, model: "picked-model" });
    }
  });

  test("drops the model for a family whose CLI cannot take one (codex)", async () => {
    const row = bind(
      makeRoleRow(),
      fakeEl({
        role: "review",
        family: "codex",
        model: "gpt-5.5",
        pinned: "1",
        modelCapable: CAPABLE,
      }),
    );
    row.init();
    expect(row.acceptsModel()).toBe(false);
    await row.save();
    expect(sent[0]!.body).toEqual({ family: "codex" });
  });

  test("a failed save surfaces the server's message and does not claim success", async () => {
    stubFetch(false);
    const row = bind(
      makeRoleRow(),
      fakeEl({ role: "review", family: "codex", model: "", pinned: "1" }),
    );
    row.init();
    await row.save();
    expect(row.saved).toBe(false);
    expect(row.error).toBe("nope");
  });
});

describe("builderRow", () => {
  test("sends the model for a non-claude reviewer whose CLI takes one", async () => {
    const row = bind(
      makeBuilderRow(),
      fakeEl({
        builder: "codex",
        reviewer: "agy",
        model: "gemini-3-pro",
        modelCapable: CAPABLE,
      }),
    );
    row.init();
    expect(row.acceptsModel()).toBe(true);
    await row.save();
    expect(sent[0]!.url).toBe("/api/brain/review-by-builder/codex");
    expect(sent[0]!.body).toEqual({ reviewer: "agy", model: "gemini-3-pro" });
  });

  test("drops the model for codex, which never receives one", async () => {
    const row = bind(
      makeBuilderRow(),
      fakeEl({
        builder: "agy",
        reviewer: "codex",
        model: "gpt-5.5",
        modelCapable: CAPABLE,
      }),
    );
    row.init();
    expect(row.acceptsModel()).toBe(false);
    await row.save();
    expect(sent[0]!.body).toEqual({ reviewer: "codex" });
  });
});

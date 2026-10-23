// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The `dailyCaps` Settings island (spec §12.1, §12.3): one cap field per role
 * (Chat / Critic / Summarizer). A field saves when you leave it or press Enter
 * — there is no Save button — and every save sends all three caps, the other
 * two at their last saved value. Driven with a stub `$el` and a capturing
 * `fetch`, like the other Settings islands.
 *
 * DOM setup is top-level: the module calls `document.addEventListener` at
 * import time, and imports run before any hook.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const realFetch = globalThis.fetch;
GlobalRegistrator.register({ url: "http://127.0.0.1:9876/settings" });

const { makeDailyCaps } = await import("../../../../src/web/client/islands/daily-caps");

interface Sent {
  url: string;
  method: string;
  body: unknown;
  secret: string | null;
}
let sent: Sent[] = [];

function stubFetch(reply: () => Response): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      secret: headers["X-Siltpoke-Secret"] ?? null,
    });
    return reply();
  }) as unknown as typeof fetch;
}

function island(review = "50", chat = "50", extract = "50"): ReturnType<typeof makeDailyCaps> {
  const caps = makeDailyCaps();
  (caps as unknown as { $el: unknown }).$el = {
    dataset: { review, chat, extract },
    closest: () => ({ getAttribute: () => "s3cret" }),
  };
  caps.init();
  return caps;
}

const okReply = (): Response => new Response(JSON.stringify({ ok: true }), { status: 200 });

beforeEach(() => {
  sent = [];
  stubFetch(okReply);
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
});

describe("dailyCaps — one field per role, saved on leave", () => {
  test("opens on the three numbers the page rendered", () => {
    const caps = island("12", "0", "7");
    expect(caps.values).toEqual({ review: "12", chat: "0", extract: "7" });
  });

  test("leaving a field with an unchanged value sends nothing", async () => {
    const caps = island();
    await caps.saveOne("chat");
    expect(sent).toEqual([]);
    expect(caps.flash.chat).toBe(false);
  });

  test("leaving a changed field sends all three, the other two unchanged, with the secret", async () => {
    const caps = island("50", "50", "50");
    caps.values.chat = "30";
    await caps.saveOne("chat");
    expect(sent).toEqual([
      {
        url: "/api/brain/daily-caps",
        method: "POST",
        body: { review: 50, chat: 30, extract: 50 },
        secret: "s3cret",
      },
    ]);
    expect(caps.flash.chat).toBe(true);
    expect(caps.flash.review).toBe(false);
    expect(caps.errors.chat).toBe("");
  });

  test("an unsaved edit in another field is not sent with this one", async () => {
    const caps = island("50", "50", "50");
    caps.values.review = "-5";
    caps.values.extract = "9";
    await caps.saveOne("extract");
    expect(sent[0]?.body).toEqual({ review: 50, chat: 50, extract: 9 });
  });

  test("after a save, leaving the field again with the same value sends nothing", async () => {
    const caps = island();
    caps.values.review = "70";
    await caps.saveOne("review");
    await caps.saveOne("review");
    expect(sent.length).toBe(1);
  });

  test("✓ saved goes away after flashMs", async () => {
    const caps = island();
    caps.flashMs = 5;
    caps.values.chat = "1";
    await caps.saveOne("chat");
    expect(caps.flash.chat).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(caps.flash.chat).toBe(false);
  });

  test("anything not a whole number of 0 or more is not sent; the error is under that field only", async () => {
    for (const bad of ["", " ", "-1", "1.5", "1e3", "abc", "0x10", "99999999999999999999"]) {
      const caps = island();
      caps.values.extract = bad;
      await caps.saveOne("extract");
      expect(caps.errors.extract).toContain("whole number");
      expect(caps.errors.chat).toBe("");
      expect(caps.flash.extract).toBe(false);
    }
    expect(sent).toEqual([]);
  });

  test("a refusal from the server is shown under the field, and nothing counts as saved", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "summarizer cap must be a whole number" }), { status: 400 }));
    const caps = island();
    caps.values.extract = "5";
    await caps.saveOne("extract");
    expect(caps.errors.extract).toBe("summarizer cap must be a whole number");
    expect(caps.flash.extract).toBe(false);
    // Not marked saved: leaving again retries.
    stubFetch(okReply);
    await caps.saveOne("extract");
    expect(sent.length).toBe(2);
  });

  test("a 200 without ok:true is not reported as saved", async () => {
    stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    const caps = island();
    caps.values.review = "3";
    await caps.saveOne("review");
    expect(caps.flash.review).toBe(false);
    expect(caps.errors.review).not.toBe("");
  });

  test("a network failure says so", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const caps = island();
    caps.values.chat = "3";
    await caps.saveOne("chat");
    expect(caps.errors.chat).toContain("daemon");
  });

  test("a reply that is not JSON reports the HTTP status", async () => {
    stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const caps = island();
    caps.values.chat = "3";
    await caps.saveOne("chat");
    expect(caps.errors.chat).toContain("502");
  });

  test("typing in a field clears its own error only", async () => {
    const caps = island();
    caps.values.chat = "-1";
    await caps.saveOne("chat");
    caps.values.review = "-1";
    await caps.saveOne("review");
    caps.touched("chat");
    expect(caps.errors.chat).toBe("");
    expect(caps.errors.review).not.toBe("");
  });

  // Review 1, finding [1]: a role whose number the page did not render must
  // never be sent as 0 — 0 means "no cap".
  test("another role's cap missing from the page: nothing is sent, the field says why", async () => {
    const caps = makeDailyCaps();
    (caps as unknown as { $el: unknown }).$el = {
      dataset: { review: "50", chat: "50" },
      closest: () => ({ getAttribute: () => "s3cret" }),
    };
    caps.init();
    caps.values.chat = "10";
    await caps.saveOne("chat");
    expect(sent).toEqual([]);
    expect(caps.errors.chat).toContain("reload");
  });

  test("a value that is already a number is accepted", async () => {
    const caps = island();
    (caps.values as unknown as { chat: unknown }).chat = 75;
    await caps.saveOne("chat");
    expect(sent[0]?.body).toEqual({ review: 50, chat: 75, extract: 50 });
  });
});

// a chat just sent did not move "0 used today".
describe("dailyCaps — today's counts stay fresh", () => {
  const usageReply = (usage: Record<string, number>) => () =>
    new Response(JSON.stringify({ caps: { chat: 50, review: 50, extract: 0 }, usage }), { status: 200 });
  const withUsed = () => {
    const caps = makeDailyCaps();
    (caps as unknown as { $el: unknown }).$el = {
      dataset: { chat: "50", review: "50", extract: "0", chatUsed: "1", reviewUsed: "2", extractUsed: "3" },
      closest: () => ({ getAttribute: () => "s3cret" }),
    };
    caps.init();
    return caps;
  };

  test("starts from the page's counts", () => {
    const caps = withUsed();
    expect(caps.used).toEqual({ chat: 1, review: 2, extract: 3 });
    expect(caps.usedText("chat")).toBe("1 used today");
    expect(caps.usedText("extract")).toBe("no cap · 3 used today");
  });

  test("refreshUsage reads /api/brain and takes its counts", async () => {
    stubFetch(usageReply({ chat: 4, review: 7, extract: 9 }));
    const caps = withUsed();
    await caps.refreshUsage();
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /api/brain"]);
    expect(caps.used).toEqual({ chat: 4, review: 7, extract: 9 });
    expect(caps.usedText("chat")).toBe("4 used today");
  });

  test("the cap shown follows a save: 0 saved reads no cap", async () => {
    const caps = withUsed();
    caps.values.chat = "0";
    await caps.saveOne("chat");
    expect(caps.usedText("chat")).toBe("no cap · 1 used today");
  });

  test("a hidden tab asks nothing", async () => {
    const caps = withUsed();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      await caps.refreshUsage();
    } finally {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    }
    expect(sent).toEqual([]);
  });

  test("a failed or odd reply keeps the numbers", async () => {
    const caps = withUsed();
    stubFetch(() => new Response("nope", { status: 500 }));
    await caps.refreshUsage();
    stubFetch(usageReply({ chat: -1, review: Number.NaN, extract: 2.5 }));
    await caps.refreshUsage();
    stubFetch(() => {
      throw new Error("offline");
    });
    await caps.refreshUsage();
    expect(caps.used).toEqual({ chat: 1, review: 2, extract: 3 });
  });

  test("a reply without usage keeps the numbers", async () => {
    stubFetch(() => new Response(JSON.stringify({ caps: {} }), { status: 200 }));
    const caps = withUsed();
    await caps.refreshUsage();
    expect(caps.used).toEqual({ chat: 1, review: 2, extract: 3 });
  });

  // Review 5, [2]: replies can arrive out of order; an older one must not win.
  test("a slower, older reply does not overwrite a newer one", async () => {
    let release: (r: Response) => void = () => {};
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) return new Promise<Response>((res) => (release = res));
      return usageReply({ chat: 9, review: 9, extract: 9 })();
    }) as unknown as typeof fetch;
    const caps = withUsed();
    const older = caps.refreshUsage();
    await caps.refreshUsage();
    release(usageReply({ chat: 4, review: 4, extract: 4 })());
    await older;
    expect(caps.used).toEqual({ chat: 9, review: 9, extract: 9 });
  });

  test("startPolling twice leaves one timer; destroy stops it", async () => {
    stubFetch(usageReply({ chat: 5, review: 5, extract: 5 }));
    const caps = withUsed();
    caps.pollMs = 10;
    caps.startPolling();
    caps.startPolling();
    caps.destroy();
    const n = sent.length;
    await new Promise((r) => setTimeout(r, 35));
    expect(sent.length).toBe(n);
  });

  test("startPolling re-reads on its own until destroy", async () => {
    stubFetch(usageReply({ chat: 5, review: 5, extract: 5 }));
    const caps = withUsed();
    caps.pollMs = 10;
    caps.startPolling();
    await new Promise((r) => setTimeout(r, 45));
    caps.destroy();
    const n = sent.length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(caps.used.chat).toBe(5);
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.length).toBe(n);
  });
});

// Small item [10]: two fields left in quick succession. The second save used to
// go out before the first came back, carrying the first field's OLD number; if
// it landed second, it put that old cap back while the page said ✓ saved.
describe("dailyCaps — two saves in flight", () => {
  test("the second save waits for the first and carries its new number", async () => {
    const release: Array<() => void> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)), secret: null });
      await new Promise<void>((r) => release.push(r));
      return okReply();
    }) as unknown as typeof fetch;
    const caps = island("50", "50", "50");
    caps.values.chat = "10";
    const first = caps.saveOne("chat");
    caps.values.review = "20";
    const second = caps.saveOne("review");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1); // the second has not gone out yet
    release[0]!();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toEqual({ chat: 10, review: 20, extract: 50 });
    release[1]!();
    await second;
    expect(caps.saved).toEqual({ chat: "10", review: "20", extract: "50" });
  });

  test("a failed save does not block the next one", async () => {
    let n = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)), secret: null });
      n++;
      if (n === 1) throw new Error("network");
      return okReply();
    }) as unknown as typeof fetch;
    const caps = island("50", "50", "50");
    caps.values.chat = "10";
    const first = caps.saveOne("chat");
    caps.values.review = "20";
    const second = caps.saveOne("review");
    await first;
    await second;
    expect(caps.errors.chat).toContain("network error");
    expect(sent[1]!.body).toEqual({ chat: 50, review: 20, extract: 50 });
    expect(caps.saved.review).toBe("20");
  });

  test("the number sent is the one in the field when it was left; later typing is kept", async () => {
    const release: Array<() => void> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)), secret: null });
      await new Promise<void>((r) => release.push(r));
      return okReply();
    }) as unknown as typeof fetch;
    const caps = island("50", "50", "50");
    caps.values.review = "20";
    const first = caps.saveOne("review");
    caps.values.chat = "10";
    const second = caps.saveOne("chat");
    caps.values.chat = "12"; // typed again before the queued save went out
    await new Promise((r) => setTimeout(r, 0));
    release[0]!();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[1]!.body).toEqual({ chat: 10, review: 20, extract: 50 });
    release[1]!();
    await second;
    expect(caps.saved.chat).toBe("10");
    expect(caps.values.chat).toBe("12");
  });

  test("Enter then leave on the same field sends once", async () => {
    const caps = island("50", "50", "50");
    caps.values.chat = "10";
    const a = caps.saveOne("chat");
    const b = caps.saveOne("chat");
    await a;
    await b;
    expect(sent).toHaveLength(1);
  });
});

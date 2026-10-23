// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * GET /settings shows the two daily caps that are in effect, and a save through
 * the real route shows on the next load (defect [49], AC13). This is the wiring
 * between the page, the write route and the readers the guarded call uses —
 * the screen test alone is handed its numbers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  loadChatQuotaDailyCapSync,
  loadQuotaDailyCapSync,
} from "../../../src/config/brain-quota-cap-config";
import { mountBrainRoutes } from "../../../src/daemon/routes/brain";
import { mountSettingsRoutes } from "../../../src/web/routes/settings";

const SECRET = "s3cret";
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "settings-caps-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function app(): Hono {
  const a = new Hono();
  mountSettingsRoutes(a, { homeBase: home, secret: SECRET });
  mountBrainRoutes(a, { homeBase: home, secret: SECRET });
  return a;
}

async function shown(a: Hono): Promise<{ review: string | undefined; chat: string | undefined }> {
  const html = await (await a.request("/settings")).text();
  const attrs = html.match(/<div x-data="dailyCaps"[^>]*>/)?.[0] ?? "";
  return {
    review: attrs.match(/data-review="([^"]*)"/)?.[1],
    chat: attrs.match(/data-chat="([^"]*)"/)?.[1],
  };
}

// The delivery half of codex's model on the page row: the route reads codex's
// own config.
test("GET /settings: a codex row names the model in codex's own config", async () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ brain: { roles: { review: { provider: "codex" } } } }));
  const codexHome = join(home, "user-home");
  mkdirSync(join(codexHome, ".codex"), { recursive: true });
  writeFileSync(join(codexHome, ".codex", "config.toml"), 'model = "gpt-5.6-sol"\n');
  const a = new Hono();
  mountSettingsRoutes(a, { homeBase: home, secret: SECRET, codexHome });
  const html = await (await a.request("/settings")).text();
  const row = html.match(/data-role-row="review"[\s\S]*?Change model/)?.[0] ?? "";
  expect(row).toContain("gpt-5.6-sol, from codex&#39;s config");
});

describe("GET /settings — daily caps", () => {
  test("no config: both show the default, 50", async () => {
    expect(await shown(app())).toEqual({ review: "50", chat: "50" });
  });

  test("each box shows its own key", async () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ brain: { quota_daily_cap: 12, chat_quota_daily_cap: 0 } }),
    );
    expect(await shown(app())).toEqual({ review: "12", chat: "0" });
  });

  test("a save through the route shows on the next load and is what the guarded call reads", async () => {
    const a = app();
    const res = await a.request("/api/brain/daily-caps", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": SECRET },
      body: JSON.stringify({ review: 200, chat: 3, extract: 5 }),
    });
    expect(res.status).toBe(200);
    expect(await shown(a)).toEqual({ review: "200", chat: "3" });
    expect(loadQuotaDailyCapSync(home)).toBe(200);
    expect(loadChatQuotaDailyCapSync(home)).toBe(3);
  });
});

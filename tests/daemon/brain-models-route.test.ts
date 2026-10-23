// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The Settings page v2 reads on /api/brain (spec §12): the Change-model
// window's lists and each role's cap and use today. Split out of
// brain-route.test.ts, which holds the writes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { ModelListRunner } from "../../src/brain/model-lists";
import type { ModelWindowView } from "../../src/brain/model-window";
import { mountBrainRoutes } from "../../src/daemon/routes/brain";
import { freshBrainHealth, writeBrainHealth } from "../../src/state/brain-health";
import { dayKey } from "../../src/state/usage";

let home: string;
const TEST_SECRET = "test-secret";
const AUTH = { headers: { "X-Siltpoke-Secret": TEST_SECRET } };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-brain-models-route-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function buildApp(): Hono {
  const app = new Hono();
  mountBrainRoutes(app, { homeBase: home, secret: TEST_SECRET, codexHome: home });
  return app;
}


// Spec §11.3 / §12.2 — the Change-model window: the saved copy at once, a
// fresh one (every CLI + models.dev) with ?refresh=1.
describe("GET /api/brain/models", () => {
  let fetched = 0;
  const modelsDev = {
    openai: { models: {} },
    anthropic: {
      models: { "claude-haiku-4-5": { cost: { input: 1, output: 5 }, canonical_model_id: "anthropic/claude-haiku-4-5" } },
    },
  };
  const appWith = (runner: ModelListRunner) => {
    fetched = 0;
    const app = new Hono();
    mountBrainRoutes(app, {
      homeBase: home,
      secret: TEST_SECRET,
      codexHome: home,
      modelListRunner: runner,
      modelsDevFetch: async () => {
        fetched++;
        return new Response(JSON.stringify(modelsDev), { status: 200 });
      },
      openRouterFetch: async () => {
        guidesFetched++;
        return new Response(JSON.stringify(openRouter), { status: 200 });
      },
    });
    return app;
  };
  let guidesFetched = 0;
  const openRouter = {
    data: [{ id: "anthropic/claude-haiku-4.5", description: "Anthropic's small, fast model.", knowledge_cutoff: "2025-02-01" }],
  };

  // each row says what the model is for, from
  // OpenRouter; the first read uses the saved copy, a refresh asks OpenRouter.
  test("a refresh asks OpenRouter and rows carry its guide; the saved read asks nothing", async () => {
    guidesFetched = 0;
    const app = appWith(async () => ({ stdout: "", code: 1 }));
    const first = (await (await app.request("/api/brain/models")).json()) as ModelWindowView;
    expect(guidesFetched).toBe(0);
    expect(first.sources.find((s) => s.name === "openrouter.ai")?.text).toBe("openrouter.ai — not checked yet");
    const fresh = (await (await app.request("/api/brain/models?refresh=1", AUTH)).json()) as ModelWindowView;
    expect(guidesFetched).toBe(1);
    expect(fresh.rows.find((r) => r.id === "claude-haiku-4-5")?.guide).toEqual({
      text: "Anthropic's small, fast model.",
      tags: ["fast"],
      short: "Anthropic's small, fast model.",
      knowsUpTo: "2025-02",
      retiresOn: null,
      url: "https://openrouter.ai/anthropic/claude-haiku-4.5",
    });
    const saved = (await (await app.request("/api/brain/models")).json()) as ModelWindowView;
    expect(saved.rows.find((r) => r.id === "claude-haiku-4-5")?.guide?.text).toBe("Anthropic's small, fast model.");
  });
  const agyOut = "gemini-x\tGemini X\nclaude-y\tClaude Y\n";

  test("without refresh: the saved copy — no CLI run, no models.dev fetch", async () => {
    let ran = 0;
    const res = await appWith(async () => {
      ran++;
      return { stdout: agyOut, code: 0 };
    }).request("/api/brain/models");
    expect(res.status).toBe(200);
    const json = (await res.json()) as ModelWindowView;
    expect(ran).toBe(0);
    expect(fetched).toBe(0);
    expect(json.savedOn).toBeNull();
    expect(json.rows.some((r) => r.family === "claude")).toBe(true);
    expect(json.sources.find((s) => s.name === "agy")?.text).toBe("agy — not asked yet");
  });

  // The delivery half: the route reads codex's own config and the codex row
  // names that model. It stays now that codex takes -m:
  // it is the way back to no model chosen.
  test("the codex row names the model codex's own config sets", async () => {
    const codexHome = join(home, "user-home");
    mkdirSync(join(codexHome, ".codex"), { recursive: true });
    writeFileSync(join(codexHome, ".codex", "config.toml"), 'model = "gpt-5.6-sol"\n');
    const app = new Hono();
    mountBrainRoutes(app, { homeBase: home, secret: TEST_SECRET, codexHome });
    const json = (await (await app.request("/api/brain/models")).json()) as ModelWindowView;
    expect(json.rows.find((r) => r.family === "codex" && r.id === "")?.description).toBe(
      "gpt-5.6-sol, from codex's config",
    );
  });

  // claude showed a hand list of 3. After a refresh its
  // rows are Anthropic's own list on models.dev, and a later saved read keeps it.
  test("claude's rows come from Anthropic's list on models.dev once it has been fetched", async () => {
    const app = appWith(async () => ({ stdout: "", code: 1 }));
    const fresh = (await (await app.request("/api/brain/models?refresh=1", AUTH)).json()) as ModelWindowView;
    expect(fresh.rows.filter((r) => r.family === "claude").map((r) => r.id)).toEqual(["claude-haiku-4-5"]);
    expect(fresh.sources.find((s) => s.name === "claude")?.text).toBe("claude — 1 model");
    const saved = (await (await app.request("/api/brain/models")).json()) as ModelWindowView;
    expect(saved.rows.filter((r) => r.family === "claude").map((r) => r.id)).toEqual(["claude-haiku-4-5"]);
  });

  // Small item [8]: the refresh runs five CLIs and rewrites the saved lists — a
  // bare GET from any web page must not start it.
  test("?refresh=1 without the secret, or with a wrong one: 401, no CLI asked, no site fetched", async () => {
    let ran = 0;
    const app = appWith(async () => {
      ran++;
      return { ok: true, stdout: "", stderr: "" } as never;
    });
    for (const init of [undefined, { headers: { "X-Siltpoke-Secret": "nope" } }, { headers: { "X-Siltpoke-Secret": "test-secreT" } }]) {
      const res = await app.request("/api/brain/models?refresh=1", init);
      expect(res.status).toBe(401);
    }
    expect(ran).toBe(0);
    expect(fetched).toBe(0);
    // The plain read stays open.
    expect((await app.request("/api/brain/models")).status).toBe(200);
  });

  test("?refresh=1 asks every CLI and models.dev; rows carry prices; it is saved", async () => {
    const app = appWith(async (argv) => (argv[0] === "agy" ? { stdout: agyOut, code: 0 } : { stdout: "", code: 1 }));
    const json = (await (await app.request("/api/brain/models?refresh=1", AUTH)).json()) as ModelWindowView;
    expect(fetched).toBe(1);
    expect(json.rows.filter((r) => r.family === "agy").map((r) => r.id)).toEqual(["gemini-x", "claude-y"]);
    expect(json.rows.find((r) => r.id === "claude-haiku-4-5")?.input).toBe(1);
    expect(json.sources.find((s) => s.name === "qoder")?.text).toContain("exit 1");
    const again = (await (await app.request("/api/brain/models")).json()) as ModelWindowView;
    expect(again.rows.filter((r) => r.family === "agy")).toHaveLength(2);
    expect(again.rows.find((r) => r.id === "claude-haiku-4-5")?.input).toBe(1);
  });
});

// Spec §12.1 / §12.3 — each role row shows its cap and "<n> used today".
describe("GET /api/brain — caps and today's use per role", () => {
  const get = async () =>
    (await (await buildApp().request("/api/brain")).json()) as { caps: unknown; usage: unknown };

  test("no config, no calls yet: three caps of 50, nothing used", async () => {
    const json = await get();
    expect(json.caps).toEqual({ chat: 50, review: 50, extract: 50 });
    expect(json.usage).toEqual({ chat: 0, review: 0, extract: 0 });
  });

  test("reads the configured caps and today's role counts; old per-agent keys do not count", async () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ brain: { quota_daily_cap: 9, chat_quota_daily_cap: 0, extract_quota_daily_cap: 4 } }),
    );
    const today = dayKey(new Date());
    writeBrainHealth(home, {
      ...freshBrainHealth(),
      quota_calls_today: {
        chat: { date: today, count: 3 },
        review: { date: "2020-01-01", count: 40 },
        codex: { date: today, count: 11 },
      },
    });
    const json = await get();
    expect(json.caps).toEqual({ chat: 0, review: 9, extract: 4 });
    expect(json.usage).toEqual({ chat: 3, review: 0, extract: 0 });
  });
});

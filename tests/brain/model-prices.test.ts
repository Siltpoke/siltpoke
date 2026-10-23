// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFactsIndex, claudeModelsOf, loadModelFacts, lookupFacts } from "../../src/brain/model-prices";

// Spec §12.2 / §12.5: the window sorts by models.dev prices and shows only
// sourced capability tags. The fixture is real models.dev data (fetched
// 2026-10-14), cut to nine entries and the fields read here.

const API = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "models-dev", "api.json"), "utf8"),
) as Record<string, unknown>;

describe("lookupFacts", () => {
  const index = buildFactsIndex(API);

  test("matches case-insensitively, ignoring a vendor/ prefix", () => {
    expect(lookupFacts(index, "Qwen3.8-Max")).toMatchObject({ input: 2, output: 6 });
  });

  // "What it's for" read "reasoning" on every row. Tags
  // keep what tells models apart; the maker's one-line description says what
  // a model is for.
  test("tags tell models apart: context size and open weights — not reasoning, tools, images or PDF", () => {
    const haiku = lookupFacts(index, "claude-haiku-4-5");
    expect(haiku?.tags).toEqual(["200K"]);
    for (const id of ["Qwen3.8-Max", "gpt-5.6-sol", "claude-sonnet-4-6", "MiniMax-M3"]) {
      const tags = lookupFacts(index, id)?.tags ?? [];
      expect(tags).not.toContain("reasoning");
      expect(tags).not.toContain("tools");
    }
  });

  test("the maker's own description, word for word", () => {
    expect(lookupFacts(index, "claude-haiku-4-5")?.description).toBe(
      "Fast Claude lane for lightweight agents, office tasks, and responsive chat",
    );
    expect(lookupFacts(index, "gpt-5.6-sol")?.description).toBe(
      "Frontier GPT-5.6 model for complex professional work, coding, and agentic workflows",
    );
  });

  test("Anthropic's own models, newest first, a dated copy of a listed model left out", () => {
    const ids = claudeModelsOf(API);
    expect(ids).toEqual(["claude-opus-5-5", "claude-sonnet-4-6", "claude-haiku-4-5"]);
    expect(claudeModelsOf(null)).toEqual([]);
  });

  test("the model maker's own price wins over a reseller's, in any order", () => {
    expect(lookupFacts(index, "gpt-5.6-sol")?.input).toBe(4);
    const reversed = Object.fromEntries(Object.entries(API).reverse());
    expect(lookupFacts(buildFactsIndex(reversed), "gpt-5.6-sol")?.input).toBe(4);
    // Review 6, minor [1]: the maker's description wins in any order too.
    expect(lookupFacts(buildFactsIndex(reversed), "gpt-5.6-sol")?.description).toBe(
      lookupFacts(index, "gpt-5.6-sol")?.description,
    );
  });

  // Review 6, minor [2]: a maker with no description lets a reseller's stand.
  test("the maker wrote no description: a reseller's stands, in any order", () => {
    const api = {
      maker: { models: { "m-1": { canonical_model_id: "maker/m-1", cost: { input: 1, output: 2 }, description: "" } } },
      reseller: { models: { "m-1": { cost: { input: 9, output: 9 }, description: "Reseller words" } } },
    };
    expect(lookupFacts(buildFactsIndex(api), "m-1")).toMatchObject({ input: 1, description: "Reseller words" });
    const reversed = Object.fromEntries(Object.entries(api).reverse());
    expect(lookupFacts(buildFactsIndex(reversed), "m-1")).toMatchObject({ input: 1, description: "Reseller words" });
  });

  // Real data: anthropic's own claude-sonnet-4-6 entry has no canonical_model_id;
  // only a reseller's copy says the maker is anthropic.
  test("the maker's entry is found even when it does not name itself", () => {
    expect(lookupFacts(index, "claude-sonnet-4-6")).toMatchObject({ input: 3, output: 15 });
  });

  test("only resellers list it: tags are kept, no price", () => {
    const facts = lookupFacts(index, "MiniMax-M3");
    expect(facts?.input).toBeNull();
    expect(facts?.output).toBeNull();
    expect(facts?.tags.length).toBeGreaterThan(0);
  });

  test("an agy id with a reasoning-effort suffix finds the model", () => {
    expect(lookupFacts(index, "gemini-3.8-flash-high")?.input).toBe(0.75);
  });

  test("a tier name never matches; an unknown id is null", () => {
    expect(lookupFacts(index, "Auto", { tier: true })).toBeNull();
    expect(lookupFacts(index, "no-such-model")).toBeNull();
  });

  test("context length reads as 200K / 1M", () => {
    expect(lookupFacts(index, "claude-haiku-4-5")?.tags).toContain("200K");
  });
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "model-prices-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const ok = async () => new Response(JSON.stringify(API), { status: 200 });
const down = async (): Promise<Response> => {
  throw new Error("offline");
};

describe("loadModelFacts — fetch, save, fall back (Review Focus 3)", () => {
  test("fetched: facts, a date, online", async () => {
    const now = new Date("2026-10-15T09:00:00.000Z");
    const r = await loadModelFacts(home, ok, now);
    expect(r.offline).toBe(false);
    expect(r.fetchedAt).toBe(now.toISOString());
    expect(lookupFacts(r.index, "claude-haiku-4-5")?.input).toBe(1);
    expect(r.claudeModels).toEqual(["claude-opus-5-5", "claude-sonnet-4-6", "claude-haiku-4-5"]);
  });

  test("the claude list is saved with the facts and read back offline", async () => {
    await loadModelFacts(home, ok, new Date("2026-10-14T00:00:00.000Z"));
    const r = await loadModelFacts(home, down);
    expect(r.claudeModels).toEqual(["claude-opus-5-5", "claude-sonnet-4-6", "claude-haiku-4-5"]);
    const cached = await loadModelFacts(home, ok, new Date(), { cachedOnly: true });
    expect(cached.claudeModels).toHaveLength(3);
  });

  test("a copy saved before the claude list existed reads as no list", async () => {
    writeFileSync(join(home, "models-dev.json"), JSON.stringify({ fetchedAt: "2026-10-14T00:00:00.000Z", index: {} }));
    const r = await loadModelFacts(home, down);
    expect(r.claudeModels).toEqual([]);
  });

  test("offline with a saved copy: the saved facts, offline, the old date", async () => {
    await loadModelFacts(home, ok, new Date("2026-10-14T00:00:00.000Z"));
    const r = await loadModelFacts(home, down);
    expect(r.offline).toBe(true);
    expect(r.fetchedAt).toBe("2026-10-14T00:00:00.000Z");
    expect(lookupFacts(r.index, "claude-haiku-4-5")?.input).toBe(1);
  });

  test("never fetched and offline: empty facts, no throw", async () => {
    const r = await loadModelFacts(home, down);
    expect(r.offline).toBe(true);
    expect(r.fetchedAt).toBeNull();
    expect(lookupFacts(r.index, "claude-haiku-4-5")).toBeNull();
  });

  test("a reply that is not models.dev's shape counts as a failure", async () => {
    await loadModelFacts(home, ok, new Date("2026-10-14T00:00:00.000Z"));
    const r = await loadModelFacts(home, async () => new Response("<html>", { status: 200 }));
    expect(r.offline).toBe(true);
    expect(lookupFacts(r.index, "claude-haiku-4-5")?.input).toBe(1);
  });

  test("cached only: no fetch at all", async () => {
    await loadModelFacts(home, ok, new Date("2026-10-14T00:00:00.000Z"));
    let fetched = 0;
    const r = await loadModelFacts(home, async () => {
      fetched++;
      return ok();
    }, new Date(), { cachedOnly: true });
    expect(fetched).toBe(0);
    expect(r.fetchedAt).toBe("2026-10-14T00:00:00.000Z");
  });
});

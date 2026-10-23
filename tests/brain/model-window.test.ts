// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { describe, expect, test } from "bun:test";
import type { FamilyModelList, ModelEntry, ModelLists } from "../../src/brain/model-lists";
import type { LoadedFacts } from "../../src/brain/model-prices";
import type { GuideIndex, LoadedGuides, ModelGuide } from "../../src/brain/model-guides";
import { modelWindowView } from "../../src/brain/model-window";

// Spec §12.2: the window's rows (every agent's models with models.dev facts)
// and one line per source — models.dev and each agent — saying whether it was
// reached, without one failure stopping the rest.

const e = (family: ModelEntry["family"], id: string, tier = false, description: string | null = null): ModelEntry => ({
  id,
  family,
  description,
  tier,
});
const never: FamilyModelList = { entries: [], error: null, fetchedAt: null };

function lists(over: Partial<ModelLists["families"]>): ModelLists {
  return {
    fetchedAt: "2026-10-14T10:00:00.000Z",
    families: {
      claude: { entries: [e("claude", "claude-haiku-4-5")], error: null, fetchedAt: "2026-10-14" },
      codex: never,
      agy: never,
      qoder: never,
      codebuddy: never,
      ...over,
    },
  };
}

const facts: LoadedFacts = {
  fetchedAt: "2026-10-14T10:00:00.000Z",
  offline: false,
  claudeModels: [],
  index: {
    "claude-haiku-4-5": { input: 1, output: 5, tags: ["200K"], description: "Fast Claude lane" },
    "qwen3.8-max": { input: 2, output: 6, tags: ["1M"] },
    // A public model that happens to share a tier's name: a tier must still get nothing.
    auto: { input: 9, output: 9, tags: ["images"], description: "should never show" },
  },
};

// claude had only a hand list of 3, and "What it's for"
// was the same tags on every row. claude's list now comes from Anthropic's own
// models on models.dev, and every row carries the maker's one-line description.
describe("modelWindowView — claude's list and each model's description", () => {
  const withClaude: LoadedFacts = {
    ...facts,
    claudeModels: ["claude-opus-5-5", "claude-haiku-4-5"],
    index: { ...facts.index, "claude-opus-5-5": { input: 4, output: 20, tags: ["1M"], description: "Top Claude" } },
  };

  test("claude's rows are Anthropic's models from models.dev, with prices and descriptions", () => {
    const v = modelWindowView(lists({}), withClaude);
    const claude = v.rows.filter((r) => r.family === "claude");
    expect(claude.map((r) => [r.id, r.input, r.about])).toEqual([
      ["claude-opus-5-5", 4, "Top Claude"],
      ["claude-haiku-4-5", 1, "Fast Claude lane"],
    ]);
    expect(v.sources.find((s) => s.name === "claude")).toEqual({
      name: "claude",
      ok: true,
      text: "claude — 2 models",
    });
  });

  test("models.dev never reached: the hand list, as before", () => {
    const v = modelWindowView(lists({}), facts);
    expect(v.rows.filter((r) => r.family === "claude").map((r) => r.id)).toEqual(["claude-haiku-4-5"]);
    expect(v.sources.find((s) => s.name === "claude")?.text).toBe("claude — 1 model (hand list, 2026-10-14)");
  });

  test("any agent's model carries the maker's description; a tier and an unknown model carry none", () => {
    const v = modelWindowView(
      lists({ qoder: { entries: [e("qoder", "Auto", true), e("qoder", "Mystery-1")], error: null, fetchedAt: "x" } }),
      facts,
    );
    expect(v.rows.find((r) => r.id === "claude-haiku-4-5")?.about).toBe("Fast Claude lane");
    expect(v.rows.find((r) => r.id === "Auto")?.about).toBeNull();
    expect(v.rows.find((r) => r.id === "Mystery-1")?.about).toBeNull();
  });
});

// what each model is for, from OpenRouter.
describe("modelWindowView — OpenRouter's guide per model", () => {
  const guide = (text: string, over: Partial<ModelGuide> = {}): ModelGuide => ({
    text,
    tags: [],
    short: text,
    knowsUpTo: null,
    retiresOn: null,
    url: "https://openrouter.ai/x/y",
    ...over,
  });
  const guides = (index: GuideIndex, over: Partial<LoadedGuides> = {}): LoadedGuides => ({
    index,
    fetchedAt: "2026-10-15T09:00:00.000Z",
    offline: false,
    ...over,
  });
  const now = new Date("2026-10-15T12:00:00.000Z");

  test("a row carries its guide; a model OpenRouter does not list carries none", () => {
    const v = modelWindowView(
      lists({ qoder: { entries: [e("qoder", "Qwen3.8-Max"), e("qoder", "Mystery-1")], error: null, fetchedAt: "x" } }),
      facts,
      { guides: guides({ "qwen3-8-max": guide("Qwen's flagship") }), now },
    );
    expect(v.rows.find((r) => r.id === "Qwen3.8-Max")?.guide?.text).toBe("Qwen's flagship");
    expect(v.rows.find((r) => r.id === "Mystery-1")?.guide).toBeNull();
  });

  test("a model past its retirement day is left out; one retiring later stays and says when", () => {
    const v = modelWindowView(
      lists({ qoder: { entries: [e("qoder", "Old-1"), e("qoder", "Soon-1")], error: null, fetchedAt: "x" } }),
      facts,
      {
        guides: guides({
          "old-1": guide("old", { retiresOn: "2026-10-14" }),
          "soon-1": guide("soon", { retiresOn: "2026-12-31" }),
        }),
        now,
      },
    );
    expect(v.rows.some((r) => r.id === "Old-1")).toBe(false);
    expect(v.rows.find((r) => r.id === "Soon-1")?.guide?.retiresOn).toBe("2026-12-31");
  });

  test("a saved day given as a bare date stays as it is; an unreadable one shows no day", () => {
    expect(modelWindowView({ ...lists({}), fetchedAt: "2026-10-14" }, facts).savedOn).toBe("2026-10-14");
    expect(modelWindowView({ ...lists({}), fetchedAt: "junk" }, facts).savedOn).toBeNull();
  });

  // Review 7, [1]: the day is this machine's, not UTC's — 8 pm on Oct 14 in
  // California is already Oct 15 in UTC, and the model still works on its last day.
  test("a model on its last day stays, judged by this machine's date", () => {
    const evening = new Date(2026, 9, 14, 20, 0); // local Oct 14, 8 pm
    const v = modelWindowView(
      lists({ qoder: { entries: [e("qoder", "Last-1")], error: null, fetchedAt: "x" } }),
      facts,
      { guides: guides({ "last-1": guide("last", { retiresOn: "2026-10-14" }) }), now: evening },
    );
    expect(v.rows.some((r) => r.id === "Last-1")).toBe(true);
  });

  // Review 8, [1]: no time to give — the line ends at "updated", no trailing space.
  test("updated with no known time: just 'updated'", () => {
    const v = modelWindowView(lists({}), { ...facts, fetchedAt: null }, { guides: guides({}, { fetchedAt: "junk" }), now });
    expect(v.sources.find((s) => s.name === "models.dev")?.text).toBe("models.dev — prices updated");
    expect(v.sources.find((s) => s.name === "openrouter.ai")?.text).toBe("openrouter.ai — descriptions updated");
  });

  test("a codex model's row carries its guide like any other agent's", () => {
    const v = modelWindowView(
      lists({ codex: { entries: [e("codex", "gpt-5.6-sol")], error: null, fetchedAt: "x" } }),
      facts,
      { codexConfigModel: "gpt-5.6-sol", guides: guides({ "gpt-5-6-sol": guide("OpenAI's frontier") }), now },
    );
    expect(v.rows.find((r) => r.family === "codex" && r.id === "gpt-5.6-sol")?.guide?.text).toBe("OpenAI's frontier");
  });

  test("an openrouter.ai source line: updated, saved, not reached", () => {
    const line = (g: LoadedGuides) =>
      modelWindowView(lists({}), facts, { guides: g, now }).sources.find((s) => s.name === "openrouter.ai");
    // "updated" says when, in this machine's time.
    const at = new Date(2026, 9, 15, 9, 12).toISOString();
    expect(line(guides({}, { fetchedAt: at }))).toEqual({
      name: "openrouter.ai",
      ok: true,
      text: "openrouter.ai — descriptions updated 2026-10-15 09:12",
    });
    expect(line(guides({}, { checked: false }))?.text).toBe("openrouter.ai — descriptions saved 2026-10-15");
    expect(line(guides({}, { offline: true, fetchedAt: null }))).toEqual({
      name: "openrouter.ai",
      ok: false,
      text: "openrouter.ai — not reached; no descriptions yet",
    });
  });

  test("no guides passed: every row's guide is null and there is no openrouter.ai line", () => {
    const v = modelWindowView(lists({}), facts);
    expect(v.rows.every((r) => r.guide === null)).toBe(true);
    expect(v.sources.some((s) => s.name === "openrouter.ai")).toBe(false);
  });
});

describe("modelWindowView — rows", () => {
  test("each entry carries its models.dev price and tags; a tier gets none", () => {
    const v = modelWindowView(
      lists({ qoder: { entries: [e("qoder", "Qwen3.8-Max"), e("qoder", "Auto", true)], error: null, fetchedAt: "x" } }),
      facts,
    );
    expect(v.rows.find((r) => r.id === "Qwen3.8-Max")).toEqual({
      id: "Qwen3.8-Max",
      family: "qoder",
      description: null,
      tier: false,
      input: 2,
      output: 6,
      tags: ["1M"],
      about: null,
      guide: null,
      choosable: true,
    });
    expect(v.rows.find((r) => r.id === "Auto")).toMatchObject({ tier: true, input: null, tags: [] });
  });

  // codex listed 6 models that could not be chosen.
  // Siltpoke now hands codex its
  // model with -m (a listed model is accepted under ChatGPT auth, probed
  // 2026-10-16), so its rows are choosable like every other agent's and the
  // first row — "codex's own config" — stays as the way back to no model chosen.
  test("codex: the own-config row first, then every listed model, all choosable", () => {
    const v = modelWindowView(
      lists({ codex: { entries: [e("codex", "gpt-6-astra", false, "Frontier")], error: null, fetchedAt: "x" } }),
      { ...facts, index: { ...facts.index, "gpt-6-astra": { input: 5, output: 20, tags: ["reasoning"] } } },
      { codexConfigModel: "gpt-5.6-sol" },
    );
    expect(v.rows.filter((r) => r.family === "codex")).toEqual([
      {
        id: "",
        family: "codex",
        description: "gpt-5.6-sol, from codex's config",
        tier: false,
        input: null,
        output: null,
        tags: [],
        about: null,
        guide: null,
        choosable: true,
      },
      {
        id: "gpt-6-astra",
        family: "codex",
        description: "Frontier",
        tier: false,
        input: 5,
        output: 20,
        tags: ["reasoning"],
        about: null,
        guide: null,
        choosable: true,
      },
    ]);
  });

  test("codex with no model in its config and none listed: only the own-config row, saying so", () => {
    const v = modelWindowView(lists({}), facts);
    expect(v.rows.filter((r) => r.family === "codex")).toEqual([
      expect.objectContaining({ id: "", description: "model set in codex's own config", choosable: true }),
    ]);
  });

  test("every other agent's rows are choosable", () => {
    const v = modelWindowView(
      lists({ qoder: { entries: [e("qoder", "Qwen3.8-Max"), e("qoder", "Auto", true)], error: null, fetchedAt: "x" } }),
      facts,
    );
    const others = v.rows.filter((r) => r.family !== "codex");
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((r) => r.choosable)).toBe(true);
  });
});

describe("modelWindowView — one line per source", () => {
  test("reached, failed with a saved list, failed with nothing, never asked", () => {
    const v = modelWindowView(
      lists({
        agy: { entries: [e("agy", "a"), e("agy", "b")], error: null, fetchedAt: "x" },
        codex: { entries: [e("codex", "c")], error: "no answer in 10s", fetchedAt: "2026-10-13T00:00:00.000Z" },
        qoder: { entries: [], error: "could not run qodercli", fetchedAt: null },
      }),
      facts,
    );
    const line = (name: string) => v.sources.find((s) => s.name === name);
    expect(line("models.dev")?.ok).toBe(true);
    expect(line("models.dev")?.text).toMatch(/^models\.dev — prices updated \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(line("claude")).toEqual({ name: "claude", ok: true, text: "claude — 1 model (hand list, 2026-10-14)" });
    expect(line("agy")).toEqual({ name: "agy", ok: true, text: "agy — 2 models" });
    expect(line("codex")).toEqual({
      name: "codex",
      ok: false,
      text: "codex — no answer in 10s; showing the list saved 2026-10-13",
    });
    expect(line("qoder")).toEqual({ name: "qoder", ok: false, text: "qoder — could not run qodercli" });
    expect(line("codebuddy")).toEqual({ name: "codebuddy", ok: false, text: "codebuddy — not asked yet" });
  });

  test("models.dev offline: saved prices with their date, or none at all", () => {
    const saved = modelWindowView(lists({}), { ...facts, offline: true });
    expect(saved.sources[0]).toEqual({
      name: "models.dev",
      ok: false,
      text: "models.dev — not reached; showing prices saved 2026-10-14",
    });
    const none = modelWindowView(lists({}), { index: {}, fetchedAt: null, offline: true, claudeModels: [] });
    expect(none.sources[0]?.text).toBe("models.dev — not reached; no prices yet");
    expect(none.rows.find((r) => r.id === "claude-haiku-4-5")?.input).toBeNull();
  });

  // Review 2, [2]: the window's first, instant read does not ask models.dev,
  // so it must not say models.dev answered.
  test("a saved-copy read says the prices are saved, never that they were updated", () => {
    const v = modelWindowView(lists({}), { ...facts, checked: false });
    expect(v.sources[0]).toEqual({ name: "models.dev", ok: true, text: "models.dev — prices saved 2026-10-14" });
    const never = modelWindowView(lists({}), { index: {}, fetchedAt: null, offline: false, checked: false, claudeModels: [] });
    expect(never.sources[0]).toEqual({ name: "models.dev", ok: false, text: "models.dev — not checked yet" });
  });

  // Review 2, [3]: a failed agent's saved list carries its own date.
  test("a failed agent's line gives the date of the list it falls back to", () => {
    const v = modelWindowView(
      lists({ codex: { entries: [e("codex", "c")], error: "no answer in 10s", fetchedAt: "2026-10-12T08:00:00.000Z" } }),
      facts,
    );
    expect(v.sources.find((s) => s.name === "codex")?.text).toBe(
      "codex — no answer in 10s; showing the list saved 2026-10-12",
    );
  });

  test("savedOn is the lists' date, or null when nothing was ever fetched", () => {
    expect(modelWindowView(lists({}), facts).savedOn).toBe("2026-10-14");
    expect(modelWindowView({ ...lists({}), fetchedAt: null }, facts).savedOn).toBeNull();
  });
});

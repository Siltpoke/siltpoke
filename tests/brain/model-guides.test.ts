// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * What each model is for, from OpenRouter's public model list (the maintainer,
 * 2026-10-15: models.dev's one line read alike for every model, and the tags
 * were all the same or nothing). The fixture is real data from
 * https://openrouter.ai/api/v1/models (fetched 2026-10-15), cut to five entries.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGuideIndex, type GuideIndex, guideTags, loadModelGuides, lookupGuide, shortLine } from "../../src/brain/model-guides";

const API = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "openrouter", "models.json"), "utf8"));

describe("lookupGuide", () => {
  const index = buildGuideIndex(API);

  test("our id finds OpenRouter's: case, vendor prefix and . vs - do not matter", () => {
    const g = lookupGuide(index, "claude-haiku-5-5");
    expect(g?.text).toStartWith("Claude Haiku 5.5 is Anthropic's small, fast model");
    expect(g?.url).toBe("https://openrouter.ai/anthropic/claude-haiku-5.5");
    expect(lookupGuide(index, "GPT-5.6-Sol")?.url).toBe("https://openrouter.ai/openai/gpt-5.6-sol");
  });

  test("the knowledge cutoff when OpenRouter has one; null when it does not", () => {
    expect(lookupGuide(index, "gpt-5.6-sol")?.knowsUpTo).toBe("2026-02");
    expect(lookupGuide(index, "claude-haiku-5-5")?.knowsUpTo).toBeNull();
  });

  test("markdown links in a description read as their words", () => {
    const g = lookupGuide(index, "gpt-6.1-sol-pro");
    expect(g?.text).not.toContain("](");
    expect(g?.text).not.toContain("https://");
  });

  test("a :free copy or a ~ alias is not the model's own entry", () => {
    expect(lookupGuide(index, "gpt-terra-latest")).toBeNull();
    expect(lookupGuide(index, "dots-3-note-preview")?.url).toBe("https://openrouter.ai/dots-studio/dots-3-note-preview:free");
  });

  // Review 7, [3]: Siltpoke's default `claude-haiku-4-5-20251001` is OpenRouter's `claude-haiku-4.5`.
  test("a dated id finds the undated model", () => {
    const idx = buildGuideIndex({ data: [{ id: "anthropic/claude-haiku-4.5", description: "Haiku." }] });
    expect(lookupGuide(idx, "claude-haiku-4-5-20251001")?.text).toBe("Haiku.");
  });

  // Review 7, [5] and [7]: a saved copy is read back defensively — a link off
  // openrouter.ai is dropped, and a copy from before tags existed still works.
  test("a saved guide: a url off openrouter.ai is not a guide; missing tags and short are filled", () => {
    const saved = {
      a: { text: "A.", knowsUpTo: null, retiresOn: null, url: "https://evil.example/a" },
      b: { text: "Bee is fast.", knowsUpTo: null, retiresOn: null, url: "https://openrouter.ai/x/b" },
    } as unknown as GuideIndex;
    expect(lookupGuide(saved, "a")).toBeNull();
    expect(lookupGuide(saved, "b")).toMatchObject({ tags: ["fast"], short: "Fast." });
  });

  test("the retirement date when there is one", () => {
    expect(lookupGuide(index, "dots-3-note-preview")?.retiresOn).toBe("2026-12-31");
    expect(lookupGuide(index, "claude-haiku-5-5")?.retiresOn).toBeNull();
  });

  test("an agy effort suffix finds the model; an unknown id or a tier is null", () => {
    expect(lookupGuide(index, "claude-haiku-5-5-thinking")?.url).toBe("https://openrouter.ai/anthropic/claude-haiku-5.5");
    expect(lookupGuide(index, "no-such-model")).toBeNull();
    expect(lookupGuide(index, "claude-haiku-5-5", { tier: true })).toBeNull();
  });

  test("junk in: an empty index, no throw", () => {
    expect(buildGuideIndex(null)).toEqual({});
    expect(buildGuideIndex({ data: "x" })).toEqual({});
    expect(buildGuideIndex({ data: [null, 3, { id: 5 }] })).toEqual({});
  });
});

// "tag + a short line + details on hover". Tags are words
// found in OpenRouter's own description — not our judgment of the model. The
// texts below are real OpenRouter descriptions (2026-10-15).
describe("guideTags, shortLine", () => {
  const HAIKU_55 =
    "Claude Haiku 5.5 is Anthropic's small, fast model for high-volume, cost-sensitive work such as summarization, subagents, and browser use. It succeeds Claude Haiku 4.5 with stronger coding, computer use, and...";
  const OPUS_55 =
    "Claude Opus 5.5 is Anthropic's flagship model for demanding reasoning, coding, and long-horizon agentic work, succeeding Claude Opus 5. It is particularly strong at multi-step changes in large codebases, code...";
  const SONNET_55 =
    "Claude Sonnet 5.5 is Anthropic's Sonnet-class model for well-scoped everyday work, succeeding Claude Sonnet 5 as a direct upgrade. It is especially strong at building features, fixing bugs, and producing...";
  const GPT6_SOL =
    "GPT-6 Sol is the cost-efficient high-end model in OpenAI's GPT-6 series, positioned below the flagship GPT-6 Astra and above the fast GPT-6 Luna tier. It is suited for demanding professional...";
  const HAIKU_45 =
    "Claude Haiku 4.5 is Anthropic’s fastest and most efficient model, delivering near-frontier intelligence at a fraction of the cost and latency of larger Claude models. Matching Claude Sonnet 4’s performance...";

  test("what a model's own description says it is for, at most four, in a fixed order", () => {
    expect(guideTags(HAIKU_55)).toEqual(["fast", "low cost", "high volume", "summaries"]);
    expect(guideTags(OPUS_55)).toEqual(["deep reasoning", "long tasks", "coding", "agents"]);
    expect(guideTags(SONNET_55)).toEqual(["everyday", "coding"]);
  });

  test("words about another model do not count: 'above the fast GPT-6 Luna' is not 'fast'", () => {
    expect(guideTags(GPT6_SOL)).not.toContain("fast");
    expect(guideTags(GPT6_SOL)).toContain("low cost");
  });

  test("no 'flagship' tag at all — it fired on 'near-frontier' and on comparisons", () => {
    for (const t of [HAIKU_55, OPUS_55, SONNET_55, GPT6_SOL, HAIKU_45]) expect(guideTags(t)).not.toContain("flagship");
    expect(guideTags(HAIKU_45)).toEqual(["fast", "low cost"]);
  });

  test("a short line: the first sentence without the model's own name, cut at a word", () => {
    expect(shortLine(HAIKU_55)).toBe("Anthropic's small, fast model for high-volume, cost-sensitive work such as…");
    expect(shortLine("Tiny model. More.")).toBe("Tiny model.");
    expect(shortLine("")).toBe("");
  });

  // Review 7, [2]: only a name before " is " goes; a sentence that merely
  // contains " is " keeps its words. A long single word is not cut mid-way.
  test("short line edge cases: no name to drop, a late ' is ', one long word", () => {
    expect(shortLine("A fast model that is cheap to run.")).toBe("A fast model that is cheap to run.");
    expect(shortLine("DeepSeek V4.1 Flash is a sparse mixture-of-experts model from DeepSeek.")).toBe(
      "A sparse mixture-of-experts model from DeepSeek.",
    );
    expect(shortLine("x".repeat(90))).toBe(`${"x".repeat(75)}…`);
  });

  test("a built guide carries its tags and short line", () => {
    const g = lookupGuide(buildGuideIndex({ data: [{ id: "anthropic/claude-haiku-5.5", description: HAIKU_55 }] }), "claude-haiku-5-5");
    expect(g?.tags).toEqual(["fast", "low cost", "high volume", "summaries"]);
    expect(g?.short).toStartWith("Anthropic's small, fast model");
    expect(g?.text).toBe(HAIKU_55);
  });
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "model-guides-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const ok = async () => new Response(JSON.stringify(API), { status: 200 });
const down = async (): Promise<Response> => {
  throw new Error("offline");
};

describe("loadModelGuides — fetch, save, fall back", () => {
  test("fetched: guides, a date, online", async () => {
    const r = await loadModelGuides(home, ok, new Date("2026-10-15T09:00:00.000Z"));
    expect(r.offline).toBe(false);
    expect(r.fetchedAt).toBe("2026-10-15T09:00:00.000Z");
    expect(lookupGuide(r.index, "claude-haiku-5-5")).not.toBeNull();
  });

  test("offline: the saved copy, marked offline", async () => {
    await loadModelGuides(home, ok, new Date("2026-10-14T00:00:00.000Z"));
    const r = await loadModelGuides(home, down);
    expect(r.offline).toBe(true);
    expect(r.fetchedAt).toBe("2026-10-14T00:00:00.000Z");
    expect(lookupGuide(r.index, "claude-haiku-5-5")).not.toBeNull();
  });

  test("a reply with no models counts as a failure and keeps the saved copy", async () => {
    await loadModelGuides(home, ok, new Date("2026-10-14T00:00:00.000Z"));
    const r = await loadModelGuides(home, async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    expect(r.offline).toBe(true);
    expect(lookupGuide(r.index, "claude-haiku-5-5")).not.toBeNull();
  });

  test("cached only: no fetch; never fetched and offline: empty, no throw", async () => {
    let fetched = 0;
    const r = await loadModelGuides(home, async () => {
      fetched++;
      return ok();
    }, new Date(), { cachedOnly: true });
    expect(fetched).toBe(0);
    expect(r.index).toEqual({});
    writeFileSync(join(home, "openrouter-models.json"), "not json");
    expect((await loadModelGuides(home, down)).index).toEqual({});
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The `modelPicker` island — the Change-model window (spec §12.2). Driven with
 * a stub `$el` and a capturing `fetch`.
 *
 * DOM setup is top-level: the module calls `document.addEventListener` at
 * import time, and imports run before any hook.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ModelRow, ModelWindowView } from "../../../../src/brain/model-window";

const realFetch = globalThis.fetch;
GlobalRegistrator.register({ url: "http://127.0.0.1:9876/settings" });

const { makeModelPicker } = await import("../../../../src/web/client/islands/model-picker");

const row = (family: ModelRow["family"], id: string, input: number | null, tier = false): ModelRow => ({
  id,
  family,
  description: null,
  tier,
  input,
  output: input === null ? null : input * 5,
  tags: [],
  about: null,
  guide: null,
  choosable: true,
});

const VIEW: ModelWindowView = {
  savedOn: "2026-10-14",
  sources: [{ name: "models.dev", ok: true, text: "models.dev — prices updated" }],
  rows: [
    row("claude", "claude-sonnet-4-6", 3),
    row("claude", "claude-haiku-4-5", 1),
    row("qoder", "Auto", null, true),
    row("qoder", "Sonus", null),
    row("qoder", "Qwen3.8-Max", 2),
    row("qoder", "GLM-5.3", 1.4),
    { ...row("codex", "", null), description: "gpt-5.6-sol, from codex's config" },
    // Listed, priced and the cheapest of all; choosable since codex takes -m.
    { ...row("codex", "gpt-6-luna", 0.5), description: "Fast and affordable" },
  ],
};

const ROLES = {
  chat: { family: "qoder", model: "Qwen3.8-Max", why: "you chose it", isDefault: false },
  review: { family: "codex", model: "", why: "you chose it", isDefault: false },
  extract: { family: "claude", model: "claude-haiku-4-5", why: "Siltpoke's default", isDefault: true },
};

interface Sent {
  url: string;
  method: string;
  body: unknown;
  secret: string | null;
}
let sent: Sent[] = [];
let postReply: () => Response;

beforeEach(() => {
  sent = [];
  postReply = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      secret: headers["X-Siltpoke-Secret"] ?? null,
    });
    if ((init?.method ?? "GET") === "POST") return postReply();
    return new Response(JSON.stringify(VIEW), { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
});

function picker(roles: unknown = ROLES) {
  const p = makeModelPicker();
  (p as unknown as { $el: unknown }).$el = {
    dataset: { roles: JSON.stringify(roles) },
    closest: () => ({ getAttribute: () => "s3cret" }),
  };
  p.init();
  let reloads = 0;
  p.reload = () => {
    reloads++;
  };
  return { p, reloads: () => reloads };
}

describe("modelPicker — opening", () => {
  test("openFor shows the role's title and what it uses now; loads the saved list, then a fresh one", async () => {
    const { p } = picker();
    await p.openFor("chat");
    expect(p.open).toBe(true);
    expect(p.title()).toBe("Choose Chat's agent and model");
    expect(p.inUse).toEqual(ROLES.chat);
    expect(sent.map((s) => s.url)).toEqual(["/api/brain/models", "/api/brain/models?refresh=1"]);
    // The refresh runs every agent's CLI: it carries the secret (small item [8]).
    expect(sent[1]?.secret).toBe("s3cret");
    expect(p.refreshing).toBe(false);
  });
});

// the two sites on one line, the agents on the next.
describe("modelPicker — sources(kind)", () => {
  test("sites are models.dev and openrouter.ai; agents are the five; all of them with no kind", async () => {
    const { p } = picker();
    await p.openFor("chat");
    p.view = {
      ...VIEW,
      sources: [
        { name: "models.dev", ok: true, text: "m" },
        { name: "openrouter.ai", ok: true, text: "o" },
        { name: "claude", ok: true, text: "c" },
        { name: "codebuddy", ok: false, text: "b" },
      ],
    };
    expect(p.sources("sites").map((s) => s.name)).toEqual(["models.dev", "openrouter.ai"]);
    expect(p.sources("agents").map((s) => s.name)).toEqual(["claude", "codebuddy"]);
    expect(p.sources()).toHaveLength(4);
  });
  // Review 8, [2]: the sites are named; anything else — a sixth agent one day — is an agent.
  test("a source that is not a known site goes on the agents line", async () => {
    const { p } = picker();
    await p.openFor("chat");
    p.view = { ...VIEW, sources: [{ name: "newagent", ok: true, text: "n" }] };
    expect(p.sources("agents").map((s) => s.name)).toEqual(["newagent"]);
    expect(p.sources("sites")).toEqual([]);
  });
});

describe("modelPicker — rows()", () => {
  test("in use first; then priced cheapest to dearest; then unpriced; tiers; models that cannot be chosen last", async () => {
    const { p } = picker();
    await p.openFor("chat");
    expect(p.rows().map((r) => r.id)).toEqual([
      "Qwen3.8-Max",
      "gpt-6-luna",
      "claude-haiku-4-5",
      "GLM-5.3",
      "claude-sonnet-4-6",
      "Sonus",
      "",
      "Auto",
    ]);
  });

  test("the codex tab: its priced models, then its own-config row (unpriced)", async () => {
    const { p } = picker();
    await p.openFor("chat");
    p.tab = "codex";
    expect(p.rows().map((r) => r.id)).toEqual(["gpt-6-luna", ""]);
  });

  test("a model that cannot be chosen is never marked cheapest", async () => {
    const { p } = picker();
    await p.openFor("chat");
    expect(p.isCheapest({ ...row("codex", "gpt-6-luna", 0.5), choosable: false })).toBe(false);
  });

  test("a tab shows one agent's rows only — the in-use row is still first when it is in that tab", async () => {
    const { p } = picker();
    await p.openFor("chat");
    p.tab = "qoder";
    expect(p.rows().map((r) => r.id)).toEqual(["Qwen3.8-Max", "GLM-5.3", "Sonus", "Auto"]);
    p.tab = "claude";
    expect(p.rows().map((r) => r.id)).toEqual(["claude-haiku-4-5", "claude-sonnet-4-6"]);
  });

  test("cheapest marks the cheapest priced, non-tier row of each agent", async () => {
    const { p } = picker();
    await p.openFor("chat");
    expect(p.isCheapest(row("qoder", "GLM-5.3", 1.4))).toBe(true);
    expect(p.isCheapest(row("qoder", "Qwen3.8-Max", 2))).toBe(false);
    expect(p.isCheapest(row("claude", "claude-haiku-4-5", 1))).toBe(true);
  });

  // codex takes -m now: a chosen
  // model's row is the one in use, and codex's own-config row keeps Use as
  // the way back to no model chosen.
  test("codex with a model chosen: that model's row is marked, codex's own row is not", async () => {
    const { p } = picker({ ...ROLES, review: { family: "codex", model: "gpt-6-luna", why: "you chose it", isDefault: false } });
    await p.openFor("review");
    const marked = p.rows().filter((r) => p.isInUse(r));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ family: "codex", id: "gpt-6-luna" });
    const own = p.rows().find((r) => r.family === "codex" && r.id === "") as ModelRow;
    expect(p.isInUse(own)).toBe(false);
    sent = [];
    await p.use(own);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ family: "codex" }); // no model: back to codex's own
  });

  test("codex with no model chosen: codex's own row is marked, no listed model is", async () => {
    const { p } = picker();
    await p.openFor("review");
    const marked = p.rows().filter((r) => p.isInUse(r));
    expect(marked).toEqual([expect.objectContaining({ family: "codex", id: "" })]);
  });

  // Review 4, [3]: a row from an older daemon has no `choosable`; it stays choosable.
  test("a row without the choosable field keeps Use", async () => {
    const { p } = picker();
    await p.openFor("chat");
    const old = { ...row("claude", "claude-haiku-4-5", 1) } as Partial<ModelRow>;
    delete old.choosable;
    sent = [];
    await p.use(old as ModelRow);
    expect(sent).toHaveLength(1);
    expect(p.isCheapest(old as ModelRow)).toBe(true);
  });

  test("codex in use: its single row is the one marked", async () => {
    const { p } = picker();
    await p.openFor("review");
    expect(p.rows()[0]).toMatchObject({ family: "codex", id: "" });
    expect(p.isInUse(p.rows()[0] as ModelRow)).toBe(true);
  });

  // Review Focus 4: the agent dropped the model the user picked.
  test("a model in use that is not in the fresh list stays first, marked, and says so", async () => {
    const { p } = picker({ ...ROLES, chat: { family: "qoder", model: "Qwen3.6-Old", why: "you chose it", isDefault: false } });
    await p.openFor("chat");
    const first = p.rows()[0] as ModelRow;
    expect(first).toMatchObject({ family: "qoder", id: "Qwen3.6-Old" });
    expect(p.isInUse(first)).toBe(true);
    expect(p.missingNote(first)).toBe("not in qoder's current list");
    expect(p.missingNote(p.rows()[1] as ModelRow)).toBe("");
  });

  // Review 6, [2]: Siltpoke's own default is the dated `claude-haiku-4-5-20251001`;
  // Anthropic's list names it `claude-haiku-4-5`. Same model: one row, marked, no warning.
  test("a dated id in use matches its undated listed row", async () => {
    const { p } = picker({ ...ROLES, extract: { family: "claude", model: "claude-haiku-4-5-20251001", why: "x", isDefault: true } });
    await p.openFor("extract");
    const first = p.rows()[0] as ModelRow;
    expect(first.id).toBe("claude-haiku-4-5");
    expect(p.isInUse(first)).toBe(true);
    expect(p.missingNote(first)).toBe("");
    expect(p.rows().filter((r) => p.isInUse(r))).toHaveLength(1);
    expect(p.rows()).toHaveLength(VIEW.rows.length);
  });

  // Review 2, [4]: config may hold the id in another case than the CLI lists it.
  test("the in-use model matches its listed row whatever the case", async () => {
    const { p } = picker({ ...ROLES, chat: { family: "qoder", model: "qwen3.8-max", why: "you chose it", isDefault: false } });
    await p.openFor("chat");
    const first = p.rows()[0] as ModelRow;
    expect(first.id).toBe("Qwen3.8-Max");
    expect(p.isInUse(first)).toBe(true);
    expect(p.missingNote(first)).toBe("");
    expect(p.rows().filter((r) => p.isInUse(r))).toHaveLength(1);
  });

  // Review 3, [1]: an unpinned critic follows the building agent — no single
  // row is in use, so none is marked and none is made up.
  test("no single agent in use: no row marked, none invented, every row offers Use", async () => {
    const { p } = picker({
      ...ROLES,
      review: { family: "", model: "", why: "Siltpoke's default", isDefault: true, label: "the agent you build with" },
    });
    await p.openFor("review");
    expect(p.rows()).toHaveLength(VIEW.rows.length);
    expect(p.rows().some((r) => p.isInUse(r))).toBe(false);
  });

  test("an agent on its own default model: a first row says so", async () => {
    const { p } = picker({ ...ROLES, chat: { family: "agy", model: "", why: "you chose it", isDefault: false } });
    await p.openFor("chat");
    expect(p.rows()[0]).toMatchObject({ family: "agy", id: "", description: "agy's own default model" });
  });
});

// what a model is for, from OpenRouter first.
// "tag + a short line + details on hover".
describe("modelPicker — whatFor(row), hoverFor(row)", () => {
  const { p } = picker();
  const g = {
    text: "Full OpenRouter words.",
    tags: ["fast"],
    short: "Short line",
    knowsUpTo: "2026-02",
    retiresOn: null,
    url: "https://openrouter.ai/a/b",
  };
  test("the short line when OpenRouter has one; models.dev's line when not; else nothing", () => {
    expect(p.whatFor({ ...row("claude", "a", 1), about: "models.dev line", guide: g })).toBe("Short line");
    expect(p.whatFor({ ...row("claude", "a", 1), about: "models.dev line" })).toBe("models.dev line");
    expect(p.whatFor(row("claude", "a", 1))).toBe("");
  });
  test("hover: the full words and the cutoff, when known", () => {
    expect(p.hoverFor({ ...row("claude", "a", 1), guide: g })).toBe("Full OpenRouter words.\nKnows up to 2026-02.");
    expect(p.hoverFor({ ...row("claude", "a", 1), guide: { ...g, knowsUpTo: null } })).toBe("Full OpenRouter words.");
    expect(p.hoverFor({ ...row("claude", "a", 1), about: "models.dev line" })).toBe("models.dev line");
  });
});

// every claude row read "images · PDF" — a tag every
// model of an agent has tells its rows apart no better than "reasoning" did.
describe("modelPicker — tagsFor(row)", () => {
  const tagged = (family: ModelRow["family"], id: string, tags: string[]): ModelRow => ({ ...row(family, id, 1), tags });
  test("a tag every model of that agent has is left out; one that differs stays", () => {
    const { p } = picker();
    p.view = {
      ...VIEW,
      rows: [
        tagged("claude", "a", ["1M", "images", "PDF"]),
        tagged("claude", "b", ["200K", "images", "PDF"]),
        tagged("qoder", "q1", ["1M", "images"]),
        tagged("qoder", "q2", ["1M"]),
      ],
    };
    expect(p.tagsFor(p.view.rows[0] as ModelRow)).toEqual(["1M"]);
    expect(p.tagsFor(p.view.rows[1] as ModelRow)).toEqual(["200K"]);
    expect(p.tagsFor(p.view.rows[2] as ModelRow)).toEqual(["images"]);
    expect(p.tagsFor(p.view.rows[3] as ModelRow)).toEqual([]);
  });
  test("the description's tags first, then models.dev's, then when it retires; shared ones still left out", () => {
    const { p } = picker();
    const g = (tags: string[], retiresOn: string | null = null) => ({
      text: "t",
      tags,
      short: "s",
      knowsUpTo: null,
      retiresOn,
      url: "https://openrouter.ai/a/b",
    });
    p.view = {
      ...VIEW,
      rows: [
        { ...tagged("claude", "a", ["1M"]), guide: g(["fast", "coding"], "2026-12-31") },
        { ...tagged("claude", "b", ["200K"]), guide: g(["deep reasoning", "coding"]) },
      ],
    };
    expect(p.tagsFor(p.view.rows[0] as ModelRow)).toEqual(["fast", "1M", "retires 2026-12-31"]);
    expect(p.tagsFor(p.view.rows[1] as ModelRow)).toEqual(["deep reasoning", "200K"]);
  });
  test("an agent with one model keeps its tags", () => {
    const { p } = picker();
    p.view = { ...VIEW, rows: [tagged("agy", "only", ["1M", "images"])] };
    expect(p.tagsFor(p.view.rows[0] as ModelRow)).toEqual(["1M", "images"]);
  });
  test("an agent's own row and its unchoosable models do not change what the others share", () => {
    const { p } = picker();
    p.view = {
      ...VIEW,
      rows: [
        { ...tagged("codex", "", ["1M"]), description: "x" },
        { ...tagged("codex", "c1", ["1M", "images"]), choosable: false },
        { ...tagged("codex", "c2", ["1M", "images"]), choosable: false },
      ],
    };
    expect(p.tagsFor(p.view.rows[1] as ModelRow)).toEqual([]);
  });
});

// Spec §12.2 / §12.5: "What it's for" says only what has a source.
// The In use now bar: an agent on its own model says what that model is when
// the list knows (codex's config), the same words as its row.
describe("modelPicker — inUseModelText()", () => {
  test("codex in use: its own row's words", async () => {
    const { p } = picker();
    await p.openFor("review");
    expect(p.inUseModelText()).toBe("gpt-5.6-sol, from codex's config");
  });
  test("a model in use: the model", async () => {
    const { p } = picker();
    await p.openFor("chat");
    expect(p.inUseModelText()).toBe("Qwen3.8-Max");
  });
  test("an agent on its own default with no row for it: its own default model", async () => {
    const { p } = picker({ ...ROLES, chat: { family: "agy", model: "", why: "you chose it", isDefault: false } });
    await p.openFor("chat");
    expect(p.inUseModelText()).toBe("its own default model");
  });
  // Review 5, [1]: before the list arrives the bar must already say what the
  // page row says — the page hands its own words over in `modelText`.
  test("before the list loads: the page's own words for the model", () => {
    const { p } = picker({
      ...ROLES,
      review: { family: "codex", model: "", why: "you chose it", isDefault: false, modelText: "gpt-5.6-sol, from codex's config" },
    });
    p.role = "review";
    p.inUse = p.roles.review ?? null;
    expect(p.view).toBeNull();
    expect(p.inUseModelText()).toBe("gpt-5.6-sol, from codex's config");
  });

  test("no single agent in use: nothing", async () => {
    const { p } = picker({ ...ROLES, review: { family: "", model: "", why: "x", isDefault: true, label: "the agent you build with" } });
    await p.openFor("review");
    expect(p.inUseModelText()).toBe("");
  });
});

describe("modelPicker — note(row)", () => {
  const { p } = picker();
  test("a tier: what the agent's tier is, or the generic tier line", () => {
    expect(p.note(row("qoder", "Auto", null, true))).toBe("qoder picks a model for each request");
    expect(p.note(row("codebuddy", "fast-model", null, true))).toBe(
      "codebuddy's own tier — not a public model, so no price or details",
    );
  });
  test("the agent's own words, quoted", () => {
    expect(p.note({ ...row("agy", "gemini-3.8-flash-high", 0.75), description: "Gemini 3.8 Flash (High)" })).toBe(
      "agy: “Gemini 3.8 Flash (High)”",
    );
  });
  // "through qoder" repeated the Family column on every row.
  test("a public model an agent resells: no note — the Family column already says whose", () => {
    expect(p.note(row("qoder", "Qwen3.8-Max", 2))).toBe("");
    expect(p.note(row("codebuddy", "glm-5.3", 1.4))).toBe("");
  });
  test("claude's own models: nothing beyond the tags", () => {
    expect(p.note(row("claude", "claude-haiku-4-5", 1))).toBe("");
  });
  // the note repeated the model name the Model column shows.
  test("codex's own row: what it means, not its name again", () => {
    expect(p.note({ ...row("codex", "", 4), description: "gpt-5.6-sol, from codex's config" })).toBe(
      "Siltpoke uses whatever codex's own config sets",
    );
  });
  test("an agent's own row is never marked cheapest", async () => {
    const { p: q } = picker();
    q.view = { ...VIEW, rows: [{ ...row("codex", "", 0.01), description: "x" }, ...VIEW.rows] };
    expect(q.isCheapest({ ...row("codex", "", 0.01), description: "x" })).toBe(false);
  });
  test("a model that cannot be chosen: codex's own words, then why it has no Use", () => {
    expect(p.note({ ...row("codex", "gpt-6-luna", 0.5), description: "Fast and affordable", choosable: false })).toBe(
      "codex: “Fast and affordable” — Siltpoke can't pick codex's model yet",
    );
    expect(p.note({ ...row("codex", "gpt-6-luna", 0.5), choosable: false })).toBe(
      "Siltpoke can't pick codex's model yet",
    );
  });
});

describe("modelPicker — Use", () => {
  test("posts the role's family and model once; the window stays open; the bar says Saved", async () => {
    const { p } = picker();
    await p.openFor("chat");
    sent = [];
    await p.use(row("claude", "claude-haiku-4-5", 1));
    expect(sent).toEqual([
      {
        url: "/api/brain/roles/chat",
        method: "POST",
        body: { family: "claude", model: "claude-haiku-4-5" },
        secret: "s3cret",
      },
    ]);
    expect(p.open).toBe(true);
    expect(p.saved).toBe(true);
    expect(p.inUse).toEqual({ family: "claude", model: "claude-haiku-4-5", why: "you chose it", isDefault: false });
    expect(p.rows()[0]?.id).toBe("claude-haiku-4-5");
  });

  test("codex: posts the family alone", async () => {
    const { p } = picker();
    await p.openFor("chat");
    sent = [];
    await p.use({ ...row("codex", "", null) });
    expect(sent[0]?.body).toEqual({ family: "codex" });
  });

  test("a model that cannot be chosen: Use sends nothing and changes nothing", async () => {
    const { p } = picker();
    await p.openFor("chat");
    sent = [];
    await p.use({ ...row("codex", "gpt-6-luna", 0.5), choosable: false });
    expect(sent).toEqual([]);
    expect(p.inUse).toEqual(ROLES.chat);
  });

  test("a refused save shows the error in the bar and changes nothing", async () => {
    postReply = () => new Response(JSON.stringify({ error: "unknown family" }), { status: 400 });
    const { p } = picker();
    await p.openFor("chat");
    await p.use(row("claude", "claude-haiku-4-5", 1));
    expect(p.error).toBe("unknown family");
    expect(p.saved).toBe(false);
    expect(p.inUse).toEqual(ROLES.chat);
  });
});

describe("modelPicker — closing", () => {
  test("close hides it; after a Use the page reloads so the table shows the new choice", async () => {
    const { p, reloads } = picker();
    await p.openFor("chat");
    p.close();
    expect(p.open).toBe(false);
    expect(reloads()).toBe(0);
    await p.openFor("chat");
    await p.use(row("claude", "claude-haiku-4-5", 1));
    p.close();
    expect(reloads()).toBe(1);
  });

  test("the list could not be loaded at all: the error is shown, nothing throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const { p } = picker();
    await p.openFor("chat");
    expect(p.error).toContain("daemon");
    expect(p.rows()[0]).toMatchObject({ family: "qoder", id: "Qwen3.8-Max" });
  });
});

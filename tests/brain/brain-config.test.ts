import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrainConfig,
  loadBrainConfig,
  loadBrainConfigSync,
  parseBrainConfig,
} from "../../src/brain/brain-config";

describe("parseBrainConfig — pure core", () => {
  test("null (absent file) -> all roles claude, main/author claude", () => {
    const c = parseBrainConfig(null);
    expect(c.main).toBe("claude");
    expect(c.authorFamily).toBe("claude");
    expect(c.roles.chat).toEqual({ provider: "claude" });
    expect(c.roles.review).toEqual({ provider: "claude" });
    expect(c.roles.extract).toEqual({ provider: "claude" });
  });

  test("unset roles fall back to main", () => {
    const c = parseBrainConfig(JSON.stringify({ brain: { main: "qoder" } }));
    expect(c.roles.chat).toEqual({ provider: "qoder" });
    expect(c.roles.review).toEqual({ provider: "qoder" });
    expect(c.roles.extract).toEqual({ provider: "qoder" });
  });

  test("explicit role with model wins over main", () => {
    const c = parseBrainConfig(
      JSON.stringify({
        brain: {
          main: "claude",
          roles: { chat: { provider: "codex", model: "gpt-5.5" } },
        },
      }),
    );
    expect(c.roles.chat).toEqual({ provider: "codex", model: "gpt-5.5" });
    expect(c.roles.review).toEqual({ provider: "claude" }); // still fallback
  });

  test("author_family parsed, defaults claude", () => {
    expect(parseBrainConfig(JSON.stringify({ brain: { author_family: "codex" } })).authorFamily).toBe("codex");
    expect(parseBrainConfig(JSON.stringify({ brain: {} })).authorFamily).toBe("claude");
  });

  test("back-compat: top-level reviewer_provider -> roles.review", () => {
    const c = parseBrainConfig(JSON.stringify({ reviewer_provider: "qoder" }));
    expect(c.roles.review).toEqual({ provider: "qoder" });
    expect(c.roles.chat).toEqual({ provider: "claude" }); // untouched by alias
  });

  test("explicit brain.roles.review beats the reviewer_provider alias", () => {
    const c = parseBrainConfig(
      JSON.stringify({ reviewer_provider: "qoder", brain: { roles: { review: { provider: "agy" } } } }),
    );
    expect(c.roles.review).toEqual({ provider: "agy" });
  });

  test("env override forces review provider, drops model, beats config", () => {
    const c = parseBrainConfig(
      JSON.stringify({ brain: { roles: { review: { provider: "agy", model: "x" } } } }),
      { reviewerProvider: "codex" },
    );
    expect(c.roles.review).toEqual({ provider: "codex" });
  });

  // ── reviewer_model shorthand (reviewer_model plumbing, single-brain #10) ──

  test("reviewer_model shorthand attaches to the reviewer_provider alias", () => {
    const c = parseBrainConfig(
      JSON.stringify({ reviewer_provider: "agy", reviewer_model: "gemini-3-pro" }),
    );
    expect(c.roles.review).toEqual({ provider: "agy", model: "gemini-3-pro" });
    // shorthand touches ONLY review — chat/extract stay on main.
    expect(c.roles.chat).toEqual({ provider: "claude" });
    expect(c.roles.extract).toEqual({ provider: "claude" });
  });

  test("verbose brain.roles.review.model beats the reviewer_model shorthand when BOTH set", () => {
    const c = parseBrainConfig(
      JSON.stringify({
        reviewer_provider: "agy",
        reviewer_model: "gemini-3-pro",
        brain: { roles: { review: { provider: "codex", model: "gpt-5.5" } } },
      }),
    );
    expect(c.roles.review).toEqual({ provider: "codex", model: "gpt-5.5" });
  });

  test("reviewer_model is ignored when no reviewer_provider alias is present (nothing to attach to)", () => {
    const c = parseBrainConfig(JSON.stringify({ reviewer_model: "gemini-3-pro" }));
    expect(c.roles.review).toEqual({ provider: "claude" });
  });

  test("non-string / empty reviewer_model is dropped (provider-only shorthand survives)", () => {
    expect(
      parseBrainConfig(JSON.stringify({ reviewer_provider: "agy", reviewer_model: 42 })).roles.review,
    ).toEqual({ provider: "agy" });
    expect(
      parseBrainConfig(JSON.stringify({ reviewer_provider: "agy", reviewer_model: "" })).roles.review,
    ).toEqual({ provider: "agy" });
  });

  test("env override still wins over the reviewer_model shorthand (provider-only, model dropped)", () => {
    const c = parseBrainConfig(
      JSON.stringify({ reviewer_provider: "agy", reviewer_model: "gemini-3-pro" }),
      { reviewerProvider: "codex" },
    );
    expect(c.roles.review).toEqual({ provider: "codex" });
  });

  test("invalid env value is ignored (config wins)", () => {
    const c = parseBrainConfig(JSON.stringify({ reviewer_provider: "qoder" }), { reviewerProvider: "bogus" });
    expect(c.roles.review).toEqual({ provider: "qoder" });
  });

  // ── builder-family default (Slice A, T1): review follows the running host ──

  test("hostFamily makes review default to the builder family (no override)", () => {
    const c = parseBrainConfig(null, { hostFamily: "codebuddy" });
    expect(c.roles.review).toEqual({ provider: "codebuddy" });
    // only review follows the builder — chat/extract stay on main(claude).
    expect(c.roles.chat).toEqual({ provider: "claude" });
    expect(c.roles.extract).toEqual({ provider: "claude" });
  });

  test("host=claude keeps review on claude (ZERO REGRESSION guard)", () => {
    const c = parseBrainConfig(null, { hostFamily: "claude" });
    expect(c.roles.review).toEqual({ provider: "claude" });
  });

  test("explicit reviewer_provider beats the hostFamily default", () => {
    const c = parseBrainConfig(JSON.stringify({ reviewer_provider: "codex" }), { hostFamily: "codebuddy" });
    expect(c.roles.review).toEqual({ provider: "codex" });
  });

  test("env reviewerProvider still beats the hostFamily default", () => {
    const c = parseBrainConfig(null, { hostFamily: "codebuddy", reviewerProvider: "agy" });
    expect(c.roles.review).toEqual({ provider: "agy" });
  });

  test("hostFamily beats main as the review fallback, but not chat/extract", () => {
    const c = parseBrainConfig(JSON.stringify({ brain: { main: "qoder" } }), { hostFamily: "codebuddy" });
    expect(c.roles.review).toEqual({ provider: "codebuddy" }); // review follows builder
    expect(c.roles.chat).toEqual({ provider: "qoder" }); // chat/extract still main
    expect(c.roles.extract).toEqual({ provider: "qoder" });
  });

  test("runtime hostFamily wins over config author_family for authorFamily (true builder)", () => {
    expect(parseBrainConfig(null, { hostFamily: "codebuddy" }).authorFamily).toBe("codebuddy");
    expect(
      parseBrainConfig(JSON.stringify({ brain: { author_family: "codex" } }), { hostFamily: "codebuddy" })
        .authorFamily,
    ).toBe("codebuddy");
  });

  test("invalid hostFamily is ignored (falls back to main/config)", () => {
    const c = parseBrainConfig(null, { hostFamily: "bogus" });
    expect(c.roles.review).toEqual({ provider: "claude" });
    expect(c.authorFamily).toBe("claude");
  });

  test("garbage json -> defaults (never throws)", () => {
    const c: BrainConfig = parseBrainConfig("{ not json");
    expect(c.roles.review).toEqual({ provider: "claude" });
  });

  test("unknown family strings are ignored -> fall back", () => {
    const c = parseBrainConfig(JSON.stringify({ brain: { main: "gpt", roles: { chat: { provider: "nope" } } } }));
    expect(c.main).toBe("claude");
    expect(c.roles.chat).toEqual({ provider: "claude" });
  });
});

describe("loadBrainConfig / loadBrainConfigSync — IO wrappers", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "brain-cfg-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  test("absent config.json -> defaults (async + sync agree)", async () => {
    expect((await loadBrainConfig(home)).roles.review).toEqual({ provider: "claude" });
    expect(loadBrainConfigSync(home).roles.review).toEqual({ provider: "claude" });
  });

  test("reads brain.roles from disk (async + sync agree)", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ brain: { roles: { review: { provider: "qoder" } } } }));
    expect((await loadBrainConfig(home)).roles.review).toEqual({ provider: "qoder" });
    expect(loadBrainConfigSync(home).roles.review).toEqual({ provider: "qoder" });
  });
});

describe("parseBrainConfig — review_by_builder (Brain select v2 T1)", () => {
  const cfg = (obj: unknown, hostFamily?: string) =>
    parseBrainConfig(JSON.stringify(obj), hostFamily ? { hostFamily } : undefined);

  test("① review_by_builder[host].provider selects the reviewer for that builder", () => {
    const c = cfg({ brain: { review_by_builder: { codex: { provider: "claude" } } } }, "codex");
    expect(c.roles.review.provider).toBe("claude");
  });

  test("② model honored only when the resolved reviewer is claude", () => {
    const claudeReviewer = cfg(
      { brain: { review_by_builder: { codex: { provider: "claude", model: "claude-sonnet-4-6" } } } },
      "codex",
    );
    expect(claudeReviewer.roles.review).toEqual({ provider: "claude", model: "claude-sonnet-4-6" });

    // quota reviewer (agy) with a model → model DROPPED (auth-fixed, silent no-op)
    const quotaReviewer = cfg(
      { brain: { review_by_builder: { codex: { provider: "agy", model: "whatever" } } } },
      "codex",
    );
    expect(quotaReviewer.roles.review).toEqual({ provider: "agy" });
    expect("model" in quotaReviewer.roles.review).toBe(false);
  });

  test("② absent provider → same-family default (the builder reviews itself), model still claude-gated", () => {
    // builder=codex, entry has only a model → provider defaults to hostFamily (codex, quota) → model dropped
    const c = cfg({ brain: { review_by_builder: { codex: { model: "x" } } } }, "codex");
    expect(c.roles.review).toEqual({ provider: "codex" });
  });

  test("③ global roles.review pin beats review_by_builder", () => {
    const c = cfg(
      {
        brain: {
          roles: { review: { provider: "qoder" } },
          review_by_builder: { codex: { provider: "claude" } },
        },
      },
      "codex",
    );
    expect(c.roles.review.provider).toBe("qoder");
  });

  test("③ review_by_builder[host] beats the bare hostFamily same-family default", () => {
    // no rbb → hostFamily default = codex
    expect(cfg({ brain: {} }, "codex").roles.review.provider).toBe("codex");
    // with rbb → claude
    expect(
      cfg({ brain: { review_by_builder: { codex: { provider: "claude" } } } }, "codex").roles.review
        .provider,
    ).toBe("claude");
  });

  test("③ review_by_builder only fires for the matching host (other builders unaffected)", () => {
    // entry keyed to codex, but host=claude → entry ignored, claude default
    const c = cfg({ brain: { review_by_builder: { codex: { provider: "agy" } } } }, "claude");
    expect(c.roles.review.provider).toBe("claude");
  });

  test("④ absent review_by_builder → identical to today (back-compat)", () => {
    const withKey = cfg({ brain: { review_by_builder: {} } }, "codex");
    const without = cfg({ brain: {} }, "codex");
    expect(withKey.roles.review).toEqual(without.roles.review);
    expect(without.roles.review.provider).toBe("codex");
  });

  test("parsed review_by_builder is exposed on the returned config (for UI/CLI read-back)", () => {
    const c = cfg({ brain: { review_by_builder: { codex: { provider: "claude", model: "claude-sonnet-4-6" } } } });
    expect(c.review_by_builder?.codex).toEqual({ provider: "claude", model: "claude-sonnet-4-6" });
  });
});

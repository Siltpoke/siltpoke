// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainView, formatBrainShow, runBrainCli, runBrainSet, setReviewByBuilder } from "../../src/cli/brain-cli";
import { loadBrainConfigSync } from "../../src/brain/brain-config";

/**
 * Slice C / Task 7 — the `/siltpoke-brain` model-select surface.
 *
 * The command reads + writes the SAME `brain.roles.review` config the daemon
 * settings screen (T8) writes: one source of truth. It is args-driven (no TTY),
 * validates family/role against the local lists, and merges into config.json
 * without clobbering the rest of the file.
 */

let home: string;

// SILTPOKE_HOST leaks the builder family into loadBrainConfigSync via envForRead;
// clear it so the show path resolves purely from the on-disk config under test.
const SAVED_HOST = process.env.SILTPOKE_HOST;
const SAVED_REVIEWER = process.env.SILTPOKE_REVIEWER_PROVIDER;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-brain-cli-"));
  delete process.env.SILTPOKE_HOST;
  delete process.env.SILTPOKE_REVIEWER_PROVIDER;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (SAVED_HOST === undefined) delete process.env.SILTPOKE_HOST;
  else process.env.SILTPOKE_HOST = SAVED_HOST;
  if (SAVED_REVIEWER === undefined) delete process.env.SILTPOKE_REVIEWER_PROVIDER;
  else process.env.SILTPOKE_REVIEWER_PROVIDER = SAVED_REVIEWER;
});

function writeConfig(obj: unknown): void {
  writeFileSync(join(home, "config.json"), `${JSON.stringify(obj, null, 2)}\n`);
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
}

describe("runBrainSet — writes brain.roles.review, preserves everything else", () => {
  test("round-trips a family + model into an existing config without clobbering other keys", () => {
    writeConfig({
      pet: { name: "Rex", level: 3 },
      brain: { main: "claude", author_family: "codebuddy", roles: { chat: { provider: "claude" } } },
    });

    const res = runBrainSet(home, "review", "qoder", "qoder-turbo");
    expect(res.ok).toBe(true);

    const cfg = readConfig();
    // the review role landed
    expect((cfg.brain as any).roles.review).toEqual({ provider: "qoder", model: "qoder-turbo" });
    // siblings survived
    expect(cfg.pet).toEqual({ name: "Rex", level: 3 });
    expect((cfg.brain as any).main).toBe("claude");
    expect((cfg.brain as any).author_family).toBe("codebuddy");
    expect((cfg.brain as any).roles.chat).toEqual({ provider: "claude" });
  });

  test("creates config.json from nothing when the file is absent", () => {
    expect(existsSync(join(home, "config.json"))).toBe(false);
    const res = runBrainSet(home, "review", "codex");
    expect(res.ok).toBe(true);
    expect((readConfig().brain as any).roles.review).toEqual({ provider: "codex" });
  });

  test("omits model when not given (CLI account default)", () => {
    runBrainSet(home, "review", "agy");
    const review = (readConfig().brain as any).roles.review;
    expect(review).toEqual({ provider: "agy" });
    expect("model" in review).toBe(false);
  });

  test("rejects an unknown family and writes nothing", () => {
    const res = runBrainSet(home, "review", "gpt5" as never);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/family/i);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("rejects an unknown role and writes nothing", () => {
    const res = runBrainSet(home, "banana" as never, "claude");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/role/i);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  // AC1 / AC9 (spec brain-select-four-gaps): this writer had NO model check at
  // all, while setReviewByBuilder refused one and the dashboard hid the control.
  // The dashboard's half was client-side only (role-row.ts drops the field), so
  // POST /api/brain/roles/:role — which calls straight into here — was the way
  // past every guard. The check belongs here, where all four entry points land.
  test("rejects a model for codex — its spawn argv never carries one", () => {
    const res = runBrainSet(home, "review", "codex", "gpt-5.5");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/model|codex|config/i);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("accepts a model for every family whose argv carries one", () => {
    for (const family of ["claude", "agy", "qoder", "codebuddy"] as const) {
      rmSync(join(home, "config.json"), { force: true });
      const res = runBrainSet(home, "review", family, "some-model");
      expect(res.ok).toBe(true);
      expect((readConfig().brain as any).roles.review).toEqual({
        provider: family,
        model: "some-model",
      });
    }
  });
});

describe("formatBrainShow — prints the resolved brain per role + builder", () => {
  test("shows the review family+model that was just set", () => {
    runBrainSet(home, "review", "qoder", "qoder-turbo");
    const out = formatBrainShow(home);
    expect(out).toMatch(/review/i);
    expect(out).toContain("qoder");
    expect(out).toContain("qoder-turbo");
  });

  test("shows the builder author family from config", () => {
    writeConfig({ brain: { author_family: "codebuddy" } });
    const out = formatBrainShow(home);
    expect(out).toContain("codebuddy");
  });

  test("marks a role that falls back to the CLI account default", () => {
    runBrainSet(home, "review", "codex");
    const out = formatBrainShow(home);
    // codex has no pinned default model -> shown as the CLI's own default, not a blank
    expect(out).toMatch(/CLI default|account default|default/i);
  });

  test("labels a user-pinned review as pinned (source column, RED ①)", () => {
    runBrainSet(home, "review", "qoder", "qoder-turbo");
    const out = formatBrainShow(home);
    expect(out).toMatch(/pinned/i);
  });

  test("labels an unpinned review that follows the builder host", () => {
    process.env.SILTPOKE_HOST = "codebuddy";
    try {
      const out = formatBrainShow(home);
      // resolves to the builder family AND says so — not a bare family name
      expect(out).toContain("codebuddy");
      expect(out).toMatch(/builder/i);
    } finally {
      delete process.env.SILTPOKE_HOST;
    }
  });

  test("labels a plain default review (no pin, no host) as default", () => {
    const out = formatBrainShow(home);
    expect(out).toMatch(/\breview\b.*\[default\]/i);
  });
});

describe("runBrainCli — the args-driven dispatch", () => {
  test("no verb -> show (never prompts)", () => {
    runBrainSet(home, "review", "qoder", "qoder-turbo");
    const res = runBrainCli([], home);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("qoder");
  });

  test('"show" verb -> show', () => {
    const res = runBrainCli(["show"], home);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/review/i);
  });

  test('"set review <family> <model>" -> writes config', () => {
    const res = runBrainCli(["set", "review", "qoder", "qoder-turbo"], home);
    expect(res.ok).toBe(true);
    expect((readConfig().brain as any).roles.review).toEqual({
      provider: "qoder",
      model: "qoder-turbo",
    });
  });

  test('"set review <family>" (no model) -> writes provider only', () => {
    const res = runBrainCli(["set", "review", "agy"], home);
    expect(res.ok).toBe(true);
    expect((readConfig().brain as any).roles.review).toEqual({ provider: "agy" });
  });

  test("set with a bad family -> ok:false, no write", () => {
    const res = runBrainCli(["set", "review", "gpt5"], home);
    expect(res.ok).toBe(false);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("an unrecognized verb -> usage error, no write", () => {
    const res = runBrainCli(["frobnicate"], home);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/usage|set|show/i);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });
});

describe("setReviewByBuilder — per-builder review overrides (Brain select v2 T2)", () => {
  test("round-trips brain.review_by_builder[builder] preserving other keys", () => {
    writeConfig({ pet: { name: "Rex" }, brain: { main: "claude", roles: { chat: { provider: "claude" } } } });
    const res = setReviewByBuilder(home, "codex", "claude", "claude-sonnet-4-6");
    expect(res.ok).toBe(true);
    const cfg = readConfig();
    expect((cfg.brain as any).review_by_builder.codex).toEqual({
      provider: "claude",
      model: "claude-sonnet-4-6",
    });
    // siblings survive
    expect(cfg.pet).toEqual({ name: "Rex" });
    expect((cfg.brain as any).main).toBe("claude");
    expect((cfg.brain as any).roles.chat).toEqual({ provider: "claude" });
  });

  test("omits model when not given", () => {
    setReviewByBuilder(home, "codex", "codex");
    expect((readConfig().brain as any).review_by_builder.codex).toEqual({ provider: "codex" });
  });

  test("rejects an unknown builder family, writes nothing", () => {
    const res = setReviewByBuilder(home, "gpt5", "claude");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/builder|family/i);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("rejects an unknown reviewer family, writes nothing", () => {
    const res = setReviewByBuilder(home, "codex", "gpt5");
    expect(res.ok).toBe(false);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  // Spec 2026-09-12-brain-select-four-gaps §3.1: the rejection follows the
  // provider's real argv capability, not "is it claude". agy pushes --model, so
  // this is now a legal pin; codex never passes -m, so that one still refuses.
  test("accepts a model on a reviewer whose argv carries one (agy)", () => {
    const res = setReviewByBuilder(home, "codex", "agy", "gemini-3-pro");
    expect(res.ok).toBe(true);
    expect((readConfig().brain as any).review_by_builder.codex).toEqual({
      provider: "agy",
      model: "gemini-3-pro",
    });
  });

  test("rejects a model on codex — its spawn argv has no -m, writes nothing", () => {
    const res = setReviewByBuilder(home, "agy", "codex", "gpt-5");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/model|codex|config/i);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("second builder entry merges, does not clobber the first", () => {
    setReviewByBuilder(home, "codex", "claude");
    setReviewByBuilder(home, "qoder", "claude");
    const rbb = (readConfig().brain as any).review_by_builder;
    expect(rbb.codex).toEqual({ provider: "claude" });
    expect(rbb.qoder).toEqual({ provider: "claude" });
  });
});

describe("runBrainCli set-builder verb (Brain select v2 T2)", () => {
  test('"set-builder codex claude sonnet" writes config', () => {
    const res = runBrainCli(["set-builder", "codex", "claude", "claude-opus-4-8"], home);
    expect(res.ok).toBe(true);
    expect((readConfig().brain as any).review_by_builder.codex).toEqual({
      provider: "claude",
      model: "claude-opus-4-8",
    });
  });

  test('"set-builder codex agy <model>" accepted — agy\'s argv carries --model', () => {
    const res = runBrainCli(["set-builder", "codex", "agy", "gemini-3-pro"], home);
    expect(res.ok).toBe(true);
    expect((readConfig().brain as any).review_by_builder.codex).toEqual({
      provider: "agy",
      model: "gemini-3-pro",
    });
  });

  test('"set-builder agy codex <model>" rejected — codex never receives one', () => {
    const res = runBrainCli(["set-builder", "agy", "codex", "gpt-5"], home);
    expect(res.ok).toBe(false);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("set-builder missing args → usage error", () => {
    const res = runBrainCli(["set-builder", "codex"], home);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/usage|set-builder/i);
  });

  test("show renders a per-builder table when review_by_builder is set", () => {
    setReviewByBuilder(home, "codex", "claude", "claude-sonnet-4-6");
    const out = formatBrainShow(home);
    expect(out).toMatch(/codex/);
    expect(out).toMatch(/claude-sonnet-4-6/);
  });

  // Reviewer finding, 2026-09-12: brainView's per-builder row kept the old
  // `reviewer === "claude"` test after every writer had moved to the capability
  // check. So a model that was accepted, stored, and genuinely sent to agy's
  // argv was printed as "(CLI default)" — configured-but-shown-as-unset, the
  // same silent mismatch this whole track exists to remove. The previous test
  // above only ever used a claude reviewer, the one case that line got right.
  // Spec brain-select-four-gaps §3.2: a global `set review <family>` outranks
  // every per-builder rule, and there was no way back — no `unset` verb, no
  // dashboard control — so a user who tried "one reviewer for everything" first
  // and then switched to per-agent rules found the second silently inert, while
  // `brain show` kept listing those rules as though they applied.
  test("unset review removes the global pin and lets per-builder rules apply again", () => {
    setReviewByBuilder(home, "codex", "agy");
    runBrainSet(home, "review", "qoder");
    // Pinned: the per-builder rule is overridden.
    expect(loadBrainConfigSync(home).roles.review.provider).toBe("qoder");

    const res = runBrainCli(["unset", "review"], home);
    expect(res.ok).toBe(true);
    expect((readConfig().brain as any).roles?.review).toBeUndefined();
    // The per-builder rule survived the unset and is live again.
    expect((readConfig().brain as any).review_by_builder.codex).toEqual({ provider: "agy" });
  });

  // Safe to run blind: unsetting what was never pinned must not error, and must
  // not conjure a config file for a user who has none.
  test("unset on a role with no pin succeeds and creates no config file", () => {
    const res = runBrainCli(["unset", "review"], home);
    expect(res.ok).toBe(true);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("unset leaves an existing config's other keys untouched", () => {
    writeConfig({ pet: { name: "Rex" }, brain: { roles: { chat: { provider: "claude" } } } });
    const res = runBrainCli(["unset", "review"], home);
    expect(res.ok).toBe(true);
    const cfg = readConfig();
    expect(cfg.pet).toEqual({ name: "Rex" });
    expect((cfg.brain as any).roles.chat).toEqual({ provider: "claude" });
  });

  test("unset rejects an unknown role and writes nothing", () => {
    const res = runBrainCli(["unset", "banana"], home);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/role/i);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  // Found in review: the flag was set from the pin ALONE, so a pin with zero
  // per-builder rules came back with all five rows "overridden" — a claim about
  // rules that do not exist, served to every consumer of GET /api/brain, not
  // just to the page that happens to filter them out when rendering.
  test("a row nobody configured is never reported as overridden", () => {
    runBrainSet(home, "review", "qoder");
    const rows = brainView(home).reviewByBuilder;
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.configured === false)).toBe(true);
    expect(rows.some((r) => r.overriddenByGlobalPin)).toBe(false);
  });

  // Three sources outrank review_by_builder; the first version of the check saw
  // only `brain.roles.review`, so a `reviewer_provider` pin left the rule
  // silently inert and unmarked — the exact fault this feature removes.
  test("a reviewer_provider pin counts as overriding, not just brain.roles.review", () => {
    writeConfig({
      reviewer_provider: "agy",
      brain: { review_by_builder: { codex: { provider: "claude" } } },
    });
    const codexRow = brainView(home).reviewByBuilder.find((r) => r.builder === "codex");
    expect(codexRow?.configured).toBe(true);
    expect(codexRow?.overriddenByGlobalPin).toBe(true);
  });

  test("show marks a per-builder row that the global pin is overriding", () => {
    setReviewByBuilder(home, "codex", "agy");
    expect(formatBrainShow(home)).not.toMatch(/overridden/i);

    runBrainSet(home, "review", "qoder");
    const out = formatBrainShow(home);
    expect(out).toMatch(/overridden/i);
    // and it must say what to run to get back
    expect(out).toMatch(/unset review/);
  });

  test("show prints a model set on a NON-claude reviewer that really receives it", () => {
    for (const reviewer of ["agy", "qoder", "codebuddy"] as const) {
      rmSync(join(home, "config.json"), { force: true });
      setReviewByBuilder(home, "codex", reviewer, "picked-model");
      const out = formatBrainShow(home);
      expect(out).toMatch(new RegExp(reviewer));
      expect(out).toMatch(/picked-model/);
      expect(out).not.toMatch(/CLI default/);
    }
  });
});

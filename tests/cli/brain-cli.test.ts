// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatBrainShow, runBrainCli, runBrainSet, setReviewByBuilder } from "../../src/cli/brain-cli";

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

  test("rejects a model on a NON-claude reviewer (auth-fixed), writes nothing", () => {
    const res = setReviewByBuilder(home, "codex", "agy", "some-model");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/model|claude|auth/i);
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

  test('"set-builder codex agy <model>" rejected (non-claude + model)', () => {
    const res = runBrainCli(["set-builder", "codex", "agy", "x"], home);
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
});

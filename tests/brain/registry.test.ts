import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBrainConfig } from "../../src/brain/brain-config";
import { loadReviewerProvider } from "../../src/brain/provider-select";
import { CLAUDE_REVIEW_MODELS, familyBinary, familyModelDefault, familySupportsModelChoice, providerForFamily, resolveRole, resolveRoleMeta } from "../../src/brain/registry";

describe("providerForFamily", () => {
  test("maps each family to a provider whose meta.name matches", () => {
    for (const f of ["claude", "codex", "agy", "qoder", "codebuddy"] as const) {
      expect(providerForFamily(f).meta.name).toBe(f);
    }
  });
});

describe("familyModelDefault", () => {
  test("claude review keeps DEFAULT_MODEL (haiku alias); chat/extract pin the snapshot (Q1, S2)", () => {
    expect(familyModelDefault("claude", "chat")).toBe("claude-haiku-4-5-20251001");
    expect(familyModelDefault("claude", "review")).toBe("claude-haiku-4-5");
    expect(familyModelDefault("claude", "extract")).toBe("claude-haiku-4-5-20251001");
  });

  test("ccfork/codex/agy families default to undefined (CLI account default)", () => {
    for (const f of ["codex", "agy", "qoder", "codebuddy"] as const) {
      expect(familyModelDefault(f, "review")).toBeUndefined();
    }
  });
});

describe("familyBinary", () => {
  test("maps each non-claude family to its PATH binary; claude -> null", () => {
    expect(familyBinary("codex")).toBe("codex");
    expect(familyBinary("agy")).toBe("agy");
    expect(familyBinary("qoder")).toBe("qodercli");
    expect(familyBinary("codebuddy")).toBe("codebuddy");
    expect(familyBinary("claude")).toBeNull();
  });
});

describe("per-role claude model defaults (Q1: pin extract/chat)", () => {
  test("review keeps the undated alias (S1 value)", () => {
    expect(familyModelDefault("claude", "review")).toBe("claude-haiku-4-5");
  });
  test("extract + chat pin the snapshot", () => {
    expect(familyModelDefault("claude", "extract")).toBe("claude-haiku-4-5-20251001");
    expect(familyModelDefault("claude", "chat")).toBe("claude-haiku-4-5-20251001");
  });
});

describe("resolveRoleMeta — display-only, no provider construction", () => {
  test("returns family + model without constructing a provider", () => {
    const c = parseBrainConfig(JSON.stringify({ brain: { roles: { extract: { provider: "qoder" } } } }));
    const m = resolveRoleMeta(c, "extract");
    expect(m.family).toBe("qoder");
    expect(m.model).toBeUndefined();
    expect((m as { provider?: unknown }).provider).toBeUndefined();
  });
});

describe("resolveRole", () => {
  test("default config -> claude provider for every role; review keeps the alias, chat/extract pin the snapshot (Q1, S2)", () => {
    const c = parseBrainConfig(null);
    for (const role of ["chat", "review", "extract"] as const) {
      const r = resolveRole(c, role);
      expect(r.family).toBe("claude");
      expect(r.provider.meta.name).toBe("claude");
      expect(r.model).toBe(role === "review" ? "claude-haiku-4-5" : "claude-haiku-4-5-20251001");
    }
  });

  test("explicit config model overrides the family default", () => {
    const c = parseBrainConfig(JSON.stringify({ brain: { roles: { chat: { provider: "codex", model: "gpt-5.5" } } } }));
    const r = resolveRole(c, "chat");
    expect(r.family).toBe("codex");
    expect(r.provider.meta.name).toBe("codex");
    expect(r.model).toBe("gpt-5.5");
  });

  test("ccfork provider with no model -> undefined model (omit --model)", () => {
    const c = parseBrainConfig(JSON.stringify({ brain: { roles: { review: { provider: "qoder" } } } }));
    const r = resolveRole(c, "review");
    expect(r.family).toBe("qoder");
    expect(r.model).toBeUndefined();
  });

  // Slice A end-to-end (T1 builder-default + T2 own-model): when review defaults
  // to the builder family via hostFamily, the model is that family's OWN default
  // (undefined -> CLI account default), NOT a hardcoded cheapest pin (Q1).
  test("hostFamily builder-default review runs the family's own model (undefined), not a pinned cheap one", () => {
    const c = parseBrainConfig(null, { hostFamily: "codebuddy" });
    const r = resolveRole(c, "review");
    expect(r.family).toBe("codebuddy");
    expect(r.provider.meta.name).toBe("codebuddy");
    expect(r.model).toBeUndefined(); // codebuddy's own account default, not a table
  });

  test("hostFamily=claude review keeps claude-haiku-4-5 through the full resolve path (ZERO REGRESSION)", () => {
    const r = resolveRole(parseBrainConfig(null, { hostFamily: "claude" }), "review");
    expect(r.family).toBe("claude");
    expect(r.model).toBe("claude-haiku-4-5");
  });
});

describe("loadReviewerProvider — back-compat seam over the registry", () => {
  test("reviewer_provider alias resolves through the new SoT", async () => {
    const home = mkdtempSync(join(tmpdir(), "prov-sel-"));
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ reviewer_provider: "qoder" }));
      const { provider: p } = await loadReviewerProvider(home);
      expect(p.meta.name).toBe("qoder");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("absent config -> claude (byte-identical default)", async () => {
    const home = mkdtempSync(join(tmpdir(), "prov-sel-"));
    try {
      expect((await loadReviewerProvider(home)).provider.meta.name).toBe("claude");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("familySupportsModelChoice + CLAUDE_REVIEW_MODELS (Brain select v2 T1)", () => {
  test("only claude supports model choice", () => {
    expect(familySupportsModelChoice("claude")).toBe(true);
    for (const f of ["codex", "agy", "qoder", "codebuddy"] as const) {
      expect(familySupportsModelChoice(f)).toBe(false);
    }
  });
  test("CLAUDE_REVIEW_MODELS leads with the haiku default and is non-empty", () => {
    expect(CLAUDE_REVIEW_MODELS.length).toBeGreaterThan(0);
    expect(CLAUDE_REVIEW_MODELS[0]).toBe("claude-haiku-4-5");
  });
});

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReviewerProvider } from "../../src/brain/provider-select";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-provider-select-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.SILTPOKE_REVIEWER_PROVIDER;
});

test("no config.json → claude (default)", async () => {
  const { provider } = await loadReviewerProvider(tmp);
  expect(provider.meta.name).toBe("claude");
});

test("config.json present but reviewer_provider absent → claude", async () => {
  writeFileSync(join(tmp, "config.json"), JSON.stringify({ other: 1 }));
  const { provider } = await loadReviewerProvider(tmp);
  expect(provider.meta.name).toBe("claude");
});

test('reviewer_provider: "claude" → claude', async () => {
  writeFileSync(join(tmp, "config.json"), JSON.stringify({ reviewer_provider: "claude" }));
  const { provider } = await loadReviewerProvider(tmp);
  expect(provider.meta.name).toBe("claude");
});

test('reviewer_provider: "codex" → codex', async () => {
  writeFileSync(join(tmp, "config.json"), JSON.stringify({ reviewer_provider: "codex" }));
  const { provider } = await loadReviewerProvider(tmp);
  expect(provider.meta.name).toBe("codex");
});

test("reviewer_provider garbage (number) → claude", async () => {
  writeFileSync(join(tmp, "config.json"), JSON.stringify({ reviewer_provider: 42 }));
  const { provider } = await loadReviewerProvider(tmp);
  expect(provider.meta.name).toBe("claude");
});

test("reviewer_provider garbage (unknown string) → claude", async () => {
  writeFileSync(join(tmp, "config.json"), JSON.stringify({ reviewer_provider: "gpt5" }));
  const { provider } = await loadReviewerProvider(tmp);
  expect(provider.meta.name).toBe("claude");
});

test("malformed JSON → claude (default on ANY throw, per house idiom)", async () => {
  writeFileSync(join(tmp, "config.json"), "{not valid json");
  const { provider } = await loadReviewerProvider(tmp);
  expect(provider.meta.name).toBe("claude");
});

test("env override SILTPOKE_REVIEWER_PROVIDER=codex beats config claude", async () => {
  writeFileSync(join(tmp, "config.json"), JSON.stringify({ reviewer_provider: "claude" }));
  process.env.SILTPOKE_REVIEWER_PROVIDER = "codex";
  const { provider } = await loadReviewerProvider(tmp);
  expect(provider.meta.name).toBe("codex");
});

test("env override SILTPOKE_REVIEWER_PROVIDER=claude beats config codex", async () => {
  writeFileSync(join(tmp, "config.json"), JSON.stringify({ reviewer_provider: "codex" }));
  process.env.SILTPOKE_REVIEWER_PROVIDER = "claude";
  const { provider } = await loadReviewerProvider(tmp);
  expect(provider.meta.name).toBe("claude");
});

test("env override with garbage value is ignored, falls through to config", async () => {
  writeFileSync(join(tmp, "config.json"), JSON.stringify({ reviewer_provider: "codex" }));
  process.env.SILTPOKE_REVIEWER_PROVIDER = "bogus";
  const { provider } = await loadReviewerProvider(tmp);
  expect(provider.meta.name).toBe("codex");
});

test('reviewer_provider: "agy" → agy', async () => {
  writeFileSync(join(tmp, "config.json"), JSON.stringify({ reviewer_provider: "agy" }));
  const { provider } = await loadReviewerProvider(tmp);
  expect(provider.meta.name).toBe("agy");
});

test("env override SILTPOKE_REVIEWER_PROVIDER=agy beats config claude", async () => {
  writeFileSync(join(tmp, "config.json"), JSON.stringify({ reviewer_provider: "claude" }));
  process.env.SILTPOKE_REVIEWER_PROVIDER = "agy";
  const { provider } = await loadReviewerProvider(tmp);
  expect(provider.meta.name).toBe("agy");
});

test("loadReviewerProvider: reviewer_provider='qoder' selects the qoder provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "provider-select-qoder-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ reviewer_provider: "qoder" }));
  const { provider } = await loadReviewerProvider(dir);
  expect(provider.meta.name).toBe("qoder");
  rmSync(dir, { recursive: true, force: true });
});

test("loadReviewerProvider: SILTPOKE_REVIEWER_PROVIDER=qoder env overrides config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "provider-select-qoder-env-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ reviewer_provider: "claude" }));
  const prev = process.env.SILTPOKE_REVIEWER_PROVIDER;
  process.env.SILTPOKE_REVIEWER_PROVIDER = "qoder";
  try {
    const { provider } = await loadReviewerProvider(dir);
    expect(provider.meta.name).toBe("qoder");
  } finally {
    if (prev === undefined) delete process.env.SILTPOKE_REVIEWER_PROVIDER;
    else process.env.SILTPOKE_REVIEWER_PROVIDER = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadReviewerProvider: reviewer_provider='codebuddy' selects the codebuddy provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "provider-select-codebuddy-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ reviewer_provider: "codebuddy" }));
  const { provider } = await loadReviewerProvider(dir);
  expect(provider.meta.name).toBe("codebuddy");
  rmSync(dir, { recursive: true, force: true });
});

test("loadReviewerProvider: SILTPOKE_REVIEWER_PROVIDER=codebuddy env overrides config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "provider-select-codebuddy-env-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ reviewer_provider: "claude" }));
  const prev = process.env.SILTPOKE_REVIEWER_PROVIDER;
  process.env.SILTPOKE_REVIEWER_PROVIDER = "codebuddy";
  try {
    const { provider } = await loadReviewerProvider(dir);
    expect(provider.meta.name).toBe("codebuddy");
  } finally {
    if (prev === undefined) delete process.env.SILTPOKE_REVIEWER_PROVIDER;
    else process.env.SILTPOKE_REVIEWER_PROVIDER = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── DROP #1 regression (reviewer_model plumbing, single-brain #10 critic half)
// loadReviewerProvider now returns the full ResolvedRole so the resolved review
// model survives to the critic, instead of being discarded with only .provider.

test("DROP #1: reviewer_model shorthand is PRESERVED on the resolved role (not dropped)", async () => {
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({ reviewer_provider: "agy", reviewer_model: "gemini-3-pro" }),
  );
  const resolved = await loadReviewerProvider(tmp);
  expect(resolved.provider.meta.name).toBe("agy");
  expect(resolved.model).toBe("gemini-3-pro");
});

test("DROP #1: verbose brain.roles.review.model beats the reviewer_model shorthand through the seam", async () => {
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({
      reviewer_provider: "agy",
      reviewer_model: "gemini-3-pro",
      brain: { roles: { review: { provider: "codex", model: "gpt-5.5" } } },
    }),
  );
  const resolved = await loadReviewerProvider(tmp);
  expect(resolved.provider.meta.name).toBe("codex");
  expect(resolved.model).toBe("gpt-5.5");
});

test("DROP #1: no reviewer_model -> claude default carries the family/role default model (not undefined)", async () => {
  const resolved = await loadReviewerProvider(tmp);
  expect(resolved.provider.meta.name).toBe("claude");
  // review role's claude default is the undated alias (registry.familyModelDefault).
  expect(resolved.model).toBe("claude-haiku-4-5");
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readSettingsPageText } from "../../src/chat/settings-page-context";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemblePageContext, previewContext, normalizePageId, pageLabelFor } from "../../src/chat/page-context";
import { emptyMemory } from "../../src/memory/memory";

const factMem = () => ({
  ...emptyMemory(),
  facts: [
    { id: "f1", text: "likes cats", status: "active", source_session_id: null, confidence: 1, created_at: "t", last_seen_at: "t", supersedes: null, superseded_by: null, pinned: false, recall_count: 0, retired_reason: null, stability: "durable", learned_from: { stream: "chat", session_id: null }, kind: null, last_confirmed_at: "t", expires_at: null, save_reason: null, invalid_at: null, events: [] },
  ],
});
const deps = { homeBase: "/tmp", readMemory: async () => factMem() as any };

describe("normalizePageId", () => {
  test("strips trailing slash + query + lowercases", () => {
    expect(normalizePageId("/Memory/?x=1")).toBe("/memory");
    expect(normalizePageId("/")).toBe("/");
  });
});

describe("pageLabelFor", () => {
  // the page was renamed Code Map in #214; the chat's chip still said "Repo Graph".
  test("the Code Map page is called Code Map", () => {
    expect(pageLabelFor("/repo-graph")).toBe("Code Map");
  });
  test("known pages get friendly labels", () => {
    expect(pageLabelFor("/memory")).toBe("Memory Book");
  });
});

describe("assemblePageContext", () => {
  test("/memory bundle includes active facts", async () => {
    const ctx = await assemblePageContext("/memory", deps);
    expect(ctx?.pageLabel).toBe("Memory Book");
    expect(ctx?.contextBundle).toContain("likes cats");
  });
  test("unknown page → label-only, empty bundle, no crash", async () => {
    const ctx = await assemblePageContext("/knowledge", deps);
    expect(ctx?.contextBundle).toBe("");
    expect(ctx?.systemPrompt).toContain("Knowledge");
  });
  // chat on Settings said "I need more context" — it was
  // told only the page's name. The bundle is now what the page shows.
  test("/settings bundle is the page as text", async () => {
    const ctx = await assemblePageContext("/settings", { homeBase: "/tmp", readSettingsPage: async () => "Chat: qoder" });
    expect(ctx?.pageLabel).toBe("Settings");
    expect(ctx?.contextBundle).toBe("Chat: qoder");
    expect(ctx?.systemPrompt).toContain("the Settings page, which shows which agent and model each of Siltpoke's own roles uses");
  });
  test("/settings read failure degrades to label-only", async () => {
    const ctx = await assemblePageContext("/settings", { homeBase: "/tmp", readSettingsPage: async () => { throw new Error("io"); } });
    expect(ctx?.contextBundle).toBe("");
    expect(ctx?.pageLabel).toBe("Settings");
  });
  test("/settings with an empty page text: label only", async () => {
    const ctx = await assemblePageContext("/settings", { homeBase: "/tmp", readSettingsPage: async () => "" });
    expect(ctx?.contextBundle).toBe("");
    expect(ctx?.pageLabel).toBe("Settings");
  });
  // Review 5, [4]: codex's model reaches chat through the real reader.
  test("the real reader names codex's configured model and never the daemon secret", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-page-settings-codex-"));
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ brain: { roles: { review: { provider: "codex" } } } }));
      writeFileSync(join(home, "daemon.secret"), "SECRET-MUST-NOT-LEAK");
      mkdirSync(join(home, "u", ".codex"), { recursive: true });
      writeFileSync(join(home, "u", ".codex", "config.toml"), 'model = "gpt-test-only-9"\n');
      const text = await readSettingsPageText(home, new Date(), join(home, "u"));
      expect(text).toContain("Critic (reviews your code after each turn): codex, gpt-test-only-9, from codex's config");
      expect(text).not.toContain("SECRET-MUST-NOT-LEAK");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  // The delivery half: with no seam, the real reader runs against a real home.
  test("/settings with no seam reads the real page text from the home", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-page-settings-"));
    try {
      const ctx = await assemblePageContext("/settings", { homeBase: home });
      expect(ctx?.contextBundle).toContain("Chat (answers you in the dashboard chat)");
      expect(ctx?.contextBundle).toContain("used today");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("read failure on /memory degrades to label-only", async () => {
    const ctx = await assemblePageContext("/memory", { homeBase: "/tmp", readMemory: async () => { throw new Error("io"); } });
    expect(ctx?.contextBundle).toBe("");
    expect(ctx?.pageLabel).toBe("Memory Book");
  });
});

describe("previewContext", () => {
  test("returns page label + active facts count", async () => {
    const p = await previewContext("/memory", deps);
    expect(p).toEqual({ pageLabel: "Memory Book", factsCount: 1 });
  });
  test("read error → count 0, no throw", async () => {
    const p = await previewContext("/memory", { homeBase: "/tmp", readMemory: async () => { throw new Error("io"); } });
    expect(p.factsCount).toBe(0);
  });
});

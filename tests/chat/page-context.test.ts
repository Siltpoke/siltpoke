import { describe, expect, test } from "bun:test";
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
    const ctx = await assemblePageContext("/settings", deps);
    expect(ctx?.contextBundle).toBe("");
    expect(ctx?.systemPrompt).toContain("Settings");
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

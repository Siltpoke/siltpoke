import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  upsertChatSession,
  chatSessionStats,
  listChatSessions,
  deleteChatSession,
  chatTitle,
  placeholderSummary,
} from "../../src/chat/sessions";
import { readMemory, writeMemory, emptyMemory } from "../../src/memory/memory";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-cs-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("upsertChatSession creates a new entry when none exists", async () => {
  const result = await upsertChatSession(
    home,
    "s-1",
    new Date("2026-05-16T10:00:00Z"),
  );
  expect(result.created).toBe(true);
  expect(result.message_count).toBe(2);
  const memory = await readMemory(home);
  expect(memory).not.toBeNull();
  expect(memory?.chat_sessions).toHaveLength(1);
  const s = memory?.chat_sessions[0]!;
  expect(s.id).toBe("s-1");
  expect(s.started_at).toBe("2026-05-16T10:00:00.000Z");
  expect(s.ended_at).toBe("2026-05-16T10:00:00.000Z");
  expect(s.message_count).toBe(2);
});

test("upsertChatSession increments existing entry by delta", async () => {
  const t1 = new Date("2026-05-16T10:00:00Z");
  const t2 = new Date("2026-05-16T11:00:00Z");
  await upsertChatSession(home, "s-1", t1);
  const second = await upsertChatSession(home, "s-1", t2);
  expect(second.created).toBe(false);
  expect(second.message_count).toBe(4);
  const memory = await readMemory(home);
  const s = memory?.chat_sessions.find((x) => x.id === "s-1")!;
  expect(s.started_at).toBe("2026-05-16T10:00:00.000Z");
  expect(s.ended_at).toBe("2026-05-16T11:00:00.000Z");
  expect(s.message_count).toBe(4);
});

test("upsertChatSession preserves other sessions", async () => {
  await upsertChatSession(home, "s-a", new Date("2026-05-16T10:00:00Z"));
  await upsertChatSession(home, "s-b", new Date("2026-05-16T11:00:00Z"));
  const memory = await readMemory(home);
  expect(memory?.chat_sessions.map((s) => s.id).sort()).toEqual([
    "s-a",
    "s-b",
  ]);
});

test("upsertChatSession respects custom delta", async () => {
  const r = await upsertChatSession(
    home,
    "s-1",
    new Date("2026-05-16T10:00:00Z"),
    5,
  );
  expect(r.message_count).toBe(5);
});

test("upsertChatSession preserves summary + tags on update", async () => {
  // seed an entry with non-default summary + tags
  const memory = emptyMemory();
  memory.chat_sessions = [
    {
      id: "s-1",
      started_at: "2026-05-16T09:00:00.000Z",
      ended_at: "2026-05-16T09:30:00.000Z",
      message_count: 6,
      summary: "earlier triage",
      summary_generated_at: null,
      tags: ["debug"],
      anchor: null,
    },
  ];
  await writeMemory(home, memory);
  await upsertChatSession(home, "s-1", new Date("2026-05-16T10:00:00Z"));
  const after = await readMemory(home);
  const s = after?.chat_sessions[0]!;
  expect(s.summary).toBe("earlier triage");
  expect(s.tags).toEqual(["debug"]);
  expect(s.message_count).toBe(8);
});

test("chatSessionStats on empty home returns zeros", async () => {
  const stats = await chatSessionStats(home);
  expect(stats.total_sessions).toBe(0);
  expect(stats.total_messages).toBe(0);
  expect(stats.most_recent_ended_at).toBeNull();
});

test("chatSessionStats aggregates correctly", async () => {
  await upsertChatSession(home, "s-a", new Date("2026-05-16T10:00:00Z"));
  await upsertChatSession(home, "s-a", new Date("2026-05-16T10:30:00Z"));
  await upsertChatSession(home, "s-b", new Date("2026-05-16T11:00:00Z"));
  const stats = await chatSessionStats(home);
  expect(stats.total_sessions).toBe(2);
  expect(stats.total_messages).toBe(6);
  expect(stats.most_recent_ended_at).toBe("2026-05-16T11:00:00.000Z");
});

test("listChatSessions returns newest-first with derived labels", async () => {
  const testHome = mkdtempSync(join(tmpdir(), "silt-hist-"));
  await upsertChatSession(testHome, "s-old", new Date("2026-06-23T10:00:00Z"), 2, {
    node_id: "n1", proj_hash: "p", node_name: "router.ts", node_type: "file",
    fingerprint: null, pinned_at: "2026-06-23T10:00:00Z",
  });
  await upsertChatSession(testHome, "s-new", new Date("2026-06-23T11:00:00Z"), 4, {
    node_id: "n2", proj_hash: "p", node_name: "runEval", node_type: "function",
    fingerprint: null, pinned_at: "2026-06-23T11:00:00Z",
  });
  const list = await listChatSessions(testHome);
  expect(list.map((s) => s.id)).toEqual(["s-new", "s-old"]);
  expect(list[0]).toMatchObject({ label: "runEval", badge: "fn", message_count: 4 });
  expect(list[1]).toMatchObject({ label: "router.ts", badge: "file" });
  // started_at is surfaced for the history-list created-time label + client sort.
  expect(list[0].started_at).toBe("2026-06-23T11:00:00.000Z");
  expect(list[1].started_at).toBe("2026-06-23T10:00:00.000Z");
  rmSync(testHome, { recursive: true, force: true });
});

test("deleteChatSession removes metadata, returns existed flag", async () => {
  const testHome = mkdtempSync(join(tmpdir(), "silt-hist-"));
  await upsertChatSession(testHome, "s-1", new Date(), 2, null);
  expect(await deleteChatSession(testHome, "s-1")).toBe(true);
  expect(await listChatSessions(testHome)).toEqual([]);
  expect(await deleteChatSession(testHome, "s-1")).toBe(false); // idempotent
  rmSync(testHome, { recursive: true, force: true });
});

test("chatTitle collapses whitespace, truncates with ellipsis, blank → ''", () => {
  expect(chatTitle("  how   does\nthis work? ")).toBe("how does this work?");
  expect(chatTitle("   ")).toBe("");
  const long = "a".repeat(80);
  const t = chatTitle(long, 60);
  expect(t.length).toBe(60);
  expect(t.endsWith("…")).toBe(true);
  // a space landing exactly at the cut point must be trimmed (no " …")
  const spaced = chatTitle(`${"x".repeat(58)} yyyy`, 60);
  expect(spaced.endsWith("…")).toBe(true);
  expect(spaced.includes(" …")).toBe(false);
});

test("upsertChatSession stores summary on creation, preserves it on update", async () => {
  await upsertChatSession(home, "s-sum", new Date("2026-06-23T10:00:00Z"), 2, null, "first question");
  let list = await listChatSessions(home);
  expect(list[0].title).toBe("first question");
  // a later turn (existing branch) must NOT overwrite the title
  await upsertChatSession(home, "s-sum", new Date("2026-06-23T10:05:00Z"), 2, null, "ignored second");
  list = await listChatSessions(home);
  expect(list[0].title).toBe("first question");
  expect(list[0].message_count).toBe(4);
});

test("listChatSessions title falls back to node label when summary empty", async () => {
  await upsertChatSession(home, "s-nofb", new Date(), 2, {
    node_id: "n", proj_hash: "p", node_name: "router.ts", node_type: "file",
    fingerprint: null, pinned_at: "2026-06-23T10:00:00Z",
  }); // no summary arg → ""
  const list = await listChatSessions(home);
  expect(list[0].title).toBe("router.ts");
});

test("placeholderSummary is deterministic, non-empty, and not the bare title stub", () => {
  const msg = "  how do   I wire the   consolidate summarizer to also emit per-session summaries without a new brain call?  ";
  const a = placeholderSummary(msg);
  const b = placeholderSummary(msg);
  expect(a).toBe(b); // deterministic
  expect(a.trim().length).toBeGreaterThan(0);
  expect(a).not.toBe("(no summary)");
  expect(a).not.toBe(chatTitle(msg)); // longer/different than the 60-char title
});

test("placeholderSummary returns sentinel string for empty input", () => {
  expect(placeholderSummary("")).toBe("(new chat — summary pending)");
});

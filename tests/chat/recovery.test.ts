import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMessage } from "../../src/chat/jsonl-store";
import {
  openIndex,
  insertMessage,
  indexedIdsForSession,
  search,
  type ChatIndex,
} from "../../src/chat/fts5-index";
import { recoverIndex } from "../../src/chat/recovery";
import type { ChatMessage } from "../../src/chat/schema";

let home: string;
let idx: ChatIndex;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-rec-"));
  idx = openIndex(home);
});

afterEach(() => {
  idx.close();
  rmSync(home, { recursive: true, force: true });
});

function msg(over: Partial<ChatMessage> & Pick<ChatMessage, "id" | "session_id" | "content">): ChatMessage {
  return {
    role: "user",
    ts: "2026-05-16T00:00:00Z",
    model: null,
    tokens: null,
    fts_skip: false,
    claude_session_id: null,
    ...over,
  };
}

test("empty home: stats all zero", async () => {
  const stats = await recoverIndex(home, idx);
  expect(stats.sessions_scanned).toBe(0);
  expect(stats.messages_total).toBe(0);
  expect(stats.messages_replayed).toBe(0);
  expect(stats.desync_ratio).toBe(0);
});

test("fully-synced index: nothing replayed", async () => {
  const m1 = msg({ id: "m-1", session_id: "s-1", content: "hello" });
  await appendMessage(home, "s-1", m1);
  insertMessage(idx, m1);
  const stats = await recoverIndex(home, idx);
  expect(stats.messages_already_indexed).toBe(1);
  expect(stats.messages_replayed).toBe(0);
  expect(stats.desync_ratio).toBe(0);
});

test("missing message gets replayed into FTS", async () => {
  const m1 = msg({ id: "m-1", session_id: "s-1", content: "in jsonl only" });
  await appendMessage(home, "s-1", m1);
  const before = indexedIdsForSession(idx, "s-1");
  expect(before.size).toBe(0);
  const stats = await recoverIndex(home, idx);
  expect(stats.messages_replayed).toBe(1);
  const after = indexedIdsForSession(idx, "s-1");
  expect(after.has("m-1")).toBe(true);
});

test("partial sync: only gaps replayed", async () => {
  const a = msg({ id: "m-a", session_id: "s-1", content: "alpha" });
  const b = msg({ id: "m-b", session_id: "s-1", content: "bravo" });
  const c = msg({ id: "m-c", session_id: "s-1", content: "charlie" });
  await appendMessage(home, "s-1", a);
  await appendMessage(home, "s-1", b);
  await appendMessage(home, "s-1", c);
  insertMessage(idx, a);
  insertMessage(idx, c);
  const stats = await recoverIndex(home, idx);
  expect(stats.messages_already_indexed).toBe(2);
  expect(stats.messages_replayed).toBe(1);
});

test("fts_skip messages are NOT replayed and counted separately", async () => {
  const noisy = msg({
    id: "m-noisy",
    session_id: "s-1",
    content: "tool_use blob",
    fts_skip: true,
  });
  await appendMessage(home, "s-1", noisy);
  const stats = await recoverIndex(home, idx);
  expect(stats.messages_skip_flagged).toBe(1);
  expect(stats.messages_replayed).toBe(0);
  expect(indexedIdsForSession(idx, "s-1").size).toBe(0);
});

test("desync_ratio excludes fts_skip from denominator", async () => {
  await appendMessage(
    home,
    "s-1",
    msg({ id: "m-1", session_id: "s-1", content: "a" }),
  );
  await appendMessage(
    home,
    "s-1",
    msg({
      id: "m-skip",
      session_id: "s-1",
      content: "noise",
      fts_skip: true,
    }),
  );
  const stats = await recoverIndex(home, idx);
  expect(stats.messages_skip_flagged).toBe(1);
  expect(stats.desync_ratio).toBe(1.0);
});

test("desync above 5% emits warn (gate trigger)", async () => {
  const originalWarn = console.warn;
  const logs: string[] = [];
  console.warn = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await appendMessage(
      home,
      "s-1",
      msg({ id: "m-1", session_id: "s-1", content: "uno" }),
    );
    await recoverIndex(home, idx);
  } finally {
    console.warn = originalWarn;
  }
  const warned = logs.find((l) => l.includes("fallback gate"));
  expect(warned).toBeDefined();
});

test("multi-session recovery", async () => {
  await appendMessage(
    home,
    "s-a",
    msg({ id: "m-1", session_id: "s-a", content: "aaa" }),
  );
  await appendMessage(
    home,
    "s-b",
    msg({ id: "m-2", session_id: "s-b", content: "bbb" }),
  );
  const stats = await recoverIndex(home, idx);
  expect(stats.sessions_scanned).toBe(2);
  expect(stats.messages_replayed).toBe(2);
  const matches = search(idx, "aaa");
  expect(matches).toHaveLength(1);
});

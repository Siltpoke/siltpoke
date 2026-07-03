import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openIndex,
  insertMessage,
  indexedIdsForSession,
  search,
  type ChatIndex,
} from "../../src/chat/fts5-index";
import type { ChatMessage } from "../../src/chat/schema";

let home: string;
let idx: ChatIndex;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-fts-"));
  idx = openIndex(home);
});

afterEach(() => {
  idx.close();
  rmSync(home, { recursive: true, force: true });
});

function makeMsg(over: Partial<ChatMessage> & Pick<ChatMessage, "id" | "session_id" | "content">): ChatMessage {
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

test("openIndex creates db file", () => {
  expect(existsSync(join(home, "chat-index.db"))).toBe(true);
});

test("insertMessage returns true on first insert", () => {
  const ok = insertMessage(
    idx,
    makeMsg({ id: "m-1", session_id: "s-1", content: "hello world" }),
  );
  expect(ok).toBe(true);
});

test("insertMessage is idempotent on same id", () => {
  const msg = makeMsg({ id: "m-1", session_id: "s-1", content: "hello" });
  expect(insertMessage(idx, msg)).toBe(true);
  expect(insertMessage(idx, msg)).toBe(false);
});

test("insertMessage skips when fts_skip is true", () => {
  const ok = insertMessage(
    idx,
    makeMsg({
      id: "m-1",
      session_id: "s-1",
      content: "tool noise",
      fts_skip: true,
    }),
  );
  expect(ok).toBe(false);
});

test("indexedIdsForSession returns inserted ids", () => {
  insertMessage(
    idx,
    makeMsg({ id: "m-1", session_id: "s-a", content: "a one" }),
  );
  insertMessage(
    idx,
    makeMsg({ id: "m-2", session_id: "s-a", content: "a two" }),
  );
  insertMessage(
    idx,
    makeMsg({ id: "m-3", session_id: "s-b", content: "b one" }),
  );
  const ids = indexedIdsForSession(idx, "s-a");
  expect(ids.has("m-1")).toBe(true);
  expect(ids.has("m-2")).toBe(true);
  expect(ids.has("m-3")).toBe(false);
});

test("search returns matches on token", () => {
  insertMessage(
    idx,
    makeMsg({ id: "m-1", session_id: "s-1", content: "the quick brown fox" }),
  );
  insertMessage(
    idx,
    makeMsg({ id: "m-2", session_id: "s-1", content: "lazy dog naps" }),
  );
  const matches = search(idx, "quick");
  expect(matches).toHaveLength(1);
  expect(matches[0]?.id).toBe("m-1");
});

test("search returns snippet with brackets around match", () => {
  insertMessage(
    idx,
    makeMsg({
      id: "m-1",
      session_id: "s-1",
      content: "alpha bravo charlie delta",
    }),
  );
  const matches = search(idx, "bravo");
  expect(matches[0]?.content_snippet).toContain("[bravo]");
});

test("search ranks better matches first", () => {
  insertMessage(
    idx,
    makeMsg({
      id: "m-1",
      session_id: "s-1",
      content: "rare word among many words here just one rare",
    }),
  );
  insertMessage(
    idx,
    makeMsg({ id: "m-2", session_id: "s-1", content: "rare" }),
  );
  const matches = search(idx, "rare");
  expect(matches.length).toBeGreaterThanOrEqual(2);
});

test("search respects limit", () => {
  for (let i = 0; i < 5; i++) {
    insertMessage(
      idx,
      makeMsg({
        id: `m-${i}`,
        session_id: "s-1",
        content: `target ${i}`,
      }),
    );
  }
  const matches = search(idx, "target", 2);
  expect(matches).toHaveLength(2);
});

test("search returns empty on blank query", () => {
  insertMessage(
    idx,
    makeMsg({ id: "m-1", session_id: "s-1", content: "hello" }),
  );
  expect(search(idx, "")).toEqual([]);
  expect(search(idx, "   ")).toEqual([]);
});

test("openIndex on existing db preserves data", () => {
  insertMessage(
    idx,
    makeMsg({ id: "m-1", session_id: "s-1", content: "persisted" }),
  );
  idx.close();
  const idx2 = openIndex(home);
  try {
    const matches = search(idx2, "persisted");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe("m-1");
  } finally {
    idx2.close();
  }
  idx = openIndex(home);
});

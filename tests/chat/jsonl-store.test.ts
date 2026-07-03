import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMessage,
  readSession,
  listSessions,
} from "../../src/chat/jsonl-store";
import type { ChatMessage } from "../../src/chat/schema";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-chat-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function makeMsg(
  overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "session_id">,
): ChatMessage {
  return {
    role: "user",
    content: "hello",
    ts: "2026-05-16T00:00:00Z",
    model: null,
    tokens: null,
    fts_skip: false,
    claude_session_id: null,
    ...overrides,
  };
}

test("appendMessage creates chats dir + jsonl file", async () => {
  const msg = makeMsg({ id: "m-1", session_id: "s-1" });
  await appendMessage(home, "s-1", msg);
  const raw = readFileSync(join(home, "chats", "s-1.jsonl"), "utf8");
  expect(raw).toBe(`${JSON.stringify(msg)}\n`);
});

test("appendMessage appends multiple lines", async () => {
  const m1 = makeMsg({ id: "m-1", session_id: "s-1" });
  const m2 = makeMsg({ id: "m-2", session_id: "s-1", role: "assistant" });
  await appendMessage(home, "s-1", m1);
  await appendMessage(home, "s-1", m2);
  const raw = readFileSync(join(home, "chats", "s-1.jsonl"), "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  expect(lines).toHaveLength(2);
});

test("appendMessage rejects session_id mismatch", async () => {
  const msg = makeMsg({ id: "m-1", session_id: "s-1" });
  await expect(appendMessage(home, "s-other", msg)).rejects.toThrow(
    /session_id mismatch/,
  );
});

test("readSession returns [] for non-existent session", async () => {
  const result = await readSession(home, "s-missing");
  expect(result).toEqual([]);
});

test("readSession parses appended messages", async () => {
  const m1 = makeMsg({ id: "m-1", session_id: "s-1" });
  const m2 = makeMsg({ id: "m-2", session_id: "s-1", role: "assistant" });
  await appendMessage(home, "s-1", m1);
  await appendMessage(home, "s-1", m2);
  const msgs = await readSession(home, "s-1");
  expect(msgs).toHaveLength(2);
  expect(msgs[0]?.id).toBe("m-1");
  expect(msgs[1]?.role).toBe("assistant");
});

test("readSession skips malformed lines", async () => {
  const m1 = makeMsg({ id: "m-1", session_id: "s-1" });
  await appendMessage(home, "s-1", m1);
  const path = join(home, "chats", "s-1.jsonl");
  writeFileSync(path, `${readFileSync(path, "utf8")}not json\n`);
  const msgs = await readSession(home, "s-1");
  expect(msgs).toHaveLength(1);
  expect(msgs[0]?.id).toBe("m-1");
});

test("readSession skips schema-invalid lines", async () => {
  const m1 = makeMsg({ id: "m-1", session_id: "s-1" });
  await appendMessage(home, "s-1", m1);
  const path = join(home, "chats", "s-1.jsonl");
  writeFileSync(
    path,
    `${readFileSync(path, "utf8") + JSON.stringify({ id: "x" })}\n`,
  );
  const msgs = await readSession(home, "s-1");
  expect(msgs).toHaveLength(1);
});

test("listSessions returns [] when chats dir missing", async () => {
  const sessions = await listSessions(home);
  expect(sessions).toEqual([]);
});

test("listSessions enumerates all .jsonl files", async () => {
  await appendMessage(
    home,
    "s-a",
    makeMsg({ id: "m-1", session_id: "s-a" }),
  );
  await appendMessage(
    home,
    "s-b",
    makeMsg({ id: "m-2", session_id: "s-b" }),
  );
  const sessions = await listSessions(home);
  const ids = sessions.map((s) => s.session_id).sort();
  expect(ids).toEqual(["s-a", "s-b"]);
});

test("listSessions ignores non-jsonl entries", async () => {
  await appendMessage(
    home,
    "s-a",
    makeMsg({ id: "m-1", session_id: "s-a" }),
  );
  writeFileSync(join(home, "chats", "stray.txt"), "ignore me");
  const sessions = await listSessions(home);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.session_id).toBe("s-a");
});

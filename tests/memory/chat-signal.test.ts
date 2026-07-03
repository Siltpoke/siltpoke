import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containsSecret, loadRecentChatMessages } from "../../src/memory/chat-signal";

describe("containsSecret", () => {
  test("flags an OpenAI-style sk- key", () => {
    expect(containsSecret("my key is sk-abc123DEF456ghi789jkl012mno345pqr")).toBe(true);
  });
  test("flags an Anthropic-style key", () => {
    expect(containsSecret("export ANTHROPIC_API_KEY=sk-ant-api03-XYZ123abc456")).toBe(true);
  });
  test("flags a bearer token", () => {
    expect(containsSecret("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe(true);
  });
  test("flags a password assignment", () => {
    expect(containsSecret('password = "hunter2correct"')).toBe(true);
  });
  test("does NOT flag ordinary prose", () => {
    expect(containsSecret("can you explain this function like I'm new to the codebase")).toBe(false);
  });
  test("does NOT flag ordinary Chinese code talk", () => {
    expect(containsSecret("用中文跟我说吗，这个 sk 变量是什么")).toBe(false);
  });

  // --- PII expansion (paths + emails). Each new pattern: prove it FIRES on
  // a real positive AND a known false-positive SURVIVES. ---

  test("flags an absolute home path (/Users) — leaks username + layout", () => {
    expect(containsSecret("see /Users/alice/secret/notes.txt for the config")).toBe(true);
  });
  test("flags an absolute home path (/home Linux)", () => {
    expect(containsSecret("the file lives at /home/bob/.ssh/config")).toBe(true);
  });
  test("flags an absolute home path (C:\\Users Windows)", () => {
    expect(containsSecret("open C:\\Users\\carol\\Documents\\todo.txt")).toBe(true);
  });
  test("does NOT flag a relative repo path (signal, must survive)", () => {
    expect(containsSecret("edit src/memory/foo.ts please")).toBe(false);
  });
  test("does NOT flag a bare system path with no user component (survives)", () => {
    // Decision: only HOME paths leak identity. System paths carry no username,
    // so /usr/local/bin and /etc/hosts are NOT dropped.
    expect(containsSecret("it's on the PATH at /usr/local/bin")).toBe(false);
    expect(containsSecret("check /etc/hosts for the mapping")).toBe(false);
  });

  test("flags an email address", () => {
    expect(containsSecret("ping me at alice@example.com when ready")).toBe(true);
  });
  test("does NOT flag a name + preference (signal, must survive)", () => {
    expect(containsSecret("the user prefers Chinese, explain like I'm new")).toBe(false);
  });
  test("does NOT flag 'my name is Alice' (name is signal, not PII)", () => {
    expect(containsSecret("my name is Alice")).toBe(false);
  });
});

function writeChatSession(homeBase: string, sessionId: string, msgs: Array<{ role: string; content: string; ts: string }>): void {
  const dir = join(homeBase, "chats");
  mkdirSync(dir, { recursive: true });
  const lines = msgs.map((m, i) =>
    JSON.stringify({
      id: `${sessionId}-${i}`, session_id: sessionId, role: m.role, content: m.content,
      ts: m.ts, model: null, tokens: null, fts_skip: false, claude_session_id: null,
    }),
  );
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n"), "utf8");
}

describe("loadRecentChatMessages", () => {
  test("returns user/assistant messages after sinceTime, newest-first, secrets dropped", async () => {
    const home = mkdtempSync(join(tmpdir(), "chat-signal-"));
    try {
      writeChatSession(home, "s1", [
        { role: "user", content: "old message before cutoff", ts: "2026-04-01T00:00:00.000Z" },
        { role: "user", content: "请用中文跟我说", ts: "2026-04-10T00:00:00.000Z" },
        { role: "user", content: "my key is sk-abc123DEF456ghi789jkl012mno", ts: "2026-04-11T00:00:00.000Z" },
        { role: "assistant", content: "sure, switching to Chinese", ts: "2026-04-12T00:00:00.000Z" },
      ]);
      const since = new Date("2026-04-05T00:00:00.000Z");
      const out = await loadRecentChatMessages(home, since);
      expect(out.some((s) => s.includes("sk-abc123"))).toBe(false);
      expect(out.some((s) => s.includes("old message"))).toBe(false);
      expect(out.some((s) => s.includes("请用中文跟我说") && s.startsWith("[user]"))).toBe(true);
      const idxAssistant = out.findIndex((s) => s.includes("switching to Chinese"));
      const idxUser = out.findIndex((s) => s.includes("请用中文"));
      expect(idxAssistant).toBeLessThan(idxUser);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("returns empty array when no chats dir exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "chat-signal-empty-"));
    try {
      expect(await loadRecentChatMessages(home, new Date("2026-01-01T00:00:00.000Z"))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

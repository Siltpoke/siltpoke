import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTranscriptTurns } from "../../src/router/extract-turns";
import { extractTurnsFromEvents } from "../../src/router/context";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-extract-turns-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("extractTranscriptTurns", () => {
  test("returns [] when transcript file does not exist", async () => {
    const turns = await extractTranscriptTurns(join(tmp, "missing.jsonl"));
    expect(turns).toEqual([]);
  });

  test("parses a typical transcript with user and assistant turns", async () => {
    const p = join(tmp, "typical.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        role: "user",
        message: { role: "user", content: "Fix the null bug in capture.ts" },
        timestamp: "2026-05-20T10:00:00.000Z",
      }),
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I'll fix the null bug by wiring the transcript turns." },
          ],
        },
        timestamp: "2026-05-20T10:00:05.000Z",
      }),
      JSON.stringify({
        type: "user",
        role: "user",
        message: { role: "user", content: "Also add a test" },
        timestamp: "2026-05-20T10:01:00.000Z",
      }),
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me add the test now." },
            { type: "tool_use", name: "Write", input: { file_path: "test.ts" } },
          ],
        },
        timestamp: "2026-05-20T10:01:10.000Z",
      }),
    ].join("\n");
    writeFileSync(p, lines);

    const turns = await extractTranscriptTurns(p);

    expect(turns).toHaveLength(4);
    expect(turns[0]).toMatchObject({ role: "user", text: "Fix the null bug in capture.ts", ts: "2026-05-20T10:00:00.000Z" });
    expect(turns[1]).toMatchObject({ role: "assistant" });
    expect(turns[1]?.text).toContain("I'll fix the null bug");
    expect(turns[2]).toMatchObject({ role: "user", text: "Also add a test" });
    expect(turns[3]).toMatchObject({ role: "assistant" });
    expect(turns[3]?.text).toContain("Let me add the test now");
  });

  test("returns [] when transcript file is empty", async () => {
    const p = join(tmp, "empty.jsonl");
    writeFileSync(p, "");
    const turns = await extractTranscriptTurns(p);
    expect(turns).toEqual([]);
  });

  test("skips malformed lines and continues parsing valid ones", async () => {
    const p = join(tmp, "malformed.jsonl");
    const lines = [
      "not valid json }{",
      JSON.stringify({
        type: "user",
        role: "user",
        message: { role: "user", content: "Hello siltpoke" },
      }),
      "{broken",
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I'll help with that." }],
        },
      }),
      "",
      "   ",
    ].join("\n");
    writeFileSync(p, lines);

    const turns = await extractTranscriptTurns(p);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: "user", text: "Hello siltpoke" });
    expect(turns[1]).toMatchObject({ role: "assistant" });
    expect(turns[1]?.text).toContain("I'll help with that");
  });

  test("skips tool-only assistant turns (no text parts)", async () => {
    const p = join(tmp, "tool-only.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        role: "user",
        message: { role: "user", content: "Run a command" },
      }),
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        message: {
          role: "assistant",
          content: [
            // Only tool_use — extractAssistantText still includes a summary "[tool Bash] ..."
            { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(p, lines);

    const turns = await extractTranscriptTurns(p);

    // extractAssistantText includes tool_use summaries so this turn IS included
    expect(turns).toHaveLength(2);
    expect(turns[1]?.role).toBe("assistant");
    expect(turns[1]?.text).toContain("[tool Bash]");
  });

});

describe("extractTurnsFromEvents", () => {
  test("groups a multi-edit assistant reply under one user prompt (one turn, deduped files)", () => {
    const events = [
      { type: "user", message: { role: "user", content: "add rate limiting" }, timestamp: "t0" },
      { type: "assistant", timestamp: "t1", message: { role: "assistant", content: [
        { type: "tool_use", name: "Edit", input: { file_path: "src/login.ts" } },
        { type: "tool_use", name: "Write", input: { file_path: "src/login.ts" } },
      ] } },
    ];
    const turns = extractTurnsFromEvents(events as never);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ index: 0, userAsk: "add rate limiting", editedFiles: ["src/login.ts"] });
  });

  test("a tool_result user event does NOT start a new turn or wipe the ask", () => {
    const events = [
      { type: "user", message: { role: "user", content: "fix the bug" }, timestamp: "t0" },
      { type: "assistant", timestamp: "t1", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }] } },
      // tool_result comes back as a user-role event whose content is a tool_result block (no text):
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] }, timestamp: "t2" },
      { type: "assistant", timestamp: "t3", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }] } },
    ];
    const turns = extractTurnsFromEvents(events as never);
    expect(turns).toHaveLength(1);                       // still ONE turn, not two
    expect(turns[0]?.userAsk).toBe("fix the bug");       // ask not wiped to ""
  });

  test("two distinct prompts editing the same file ⇒ two turns", () => {
    const events = [
      { type: "user", message: { role: "user", content: "security fix" }, timestamp: "t0" },
      { type: "assistant", timestamp: "t1", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }] } },
      { type: "user", message: { role: "user", content: "format imports" }, timestamp: "t2" },
      { type: "assistant", timestamp: "t3", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }] } },
    ];
    const turns = extractTurnsFromEvents(events as never);
    expect(turns.map((t) => t.userAsk)).toEqual(["security fix", "format imports"]);
  });
});

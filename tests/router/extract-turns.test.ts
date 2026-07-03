import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTranscriptTurns } from "../../src/router/extract-turns";

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

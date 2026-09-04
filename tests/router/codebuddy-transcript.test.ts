// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * CodeBuddy transcript adapter — fixture lines modeled 1:1 on a real
 * codebuddy 2.119.2 session JSONL captured during the 2026-07-19 host-
 * integration smoke (session 72066f02). codebuddy writes an OpenAI-style
 * transcript: top-level `message` turns (role + content[input_text|
 * output_text]) and `function_call` tool events (top-level `name` +
 * `arguments` JSON string), NOT Claude's `tool_use` content blocks. Without
 * translation, extractChangedFiles() sees zero changed files and the Stop
 * pipeline skips every codebuddy turn as "no_code_changes".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractChangedFiles,
  extractLatestUserMessage,
} from "../../src/router/context";
import { extractTranscriptTurns } from "../../src/router/extract-turns";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-codebuddy-transcript-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function cbLine(obj: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: 1784496886803, cwd: "/repo", ...obj });
}

/** Minimal-but-faithful codebuddy session: user turn → non-edit tool → Edit → result → final reply. */
function writeCodebuddyFixture(path: string, opts?: { editArgs?: string }): void {
  const lines = [
    cbLine({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "In token.ts, change the <= to < in the expiresAt comparison." },
      ],
      sessionId: "72066f02",
    }),
    // A non-edit tool call must NOT contribute a changed file.
    cbLine({
      type: "function_call",
      name: "Glob",
      arguments: '{"pattern": "**/token.ts"}',
      callId: "toolu_bdrk_glob",
    }),
    cbLine({
      type: "function_call",
      name: "Edit",
      arguments:
        opts?.editArgs ??
        '{"file_path": "/repo/token.ts", "old_string": "  return token.expiresAt <= now;", "new_string": "  return token.expiresAt < now;"}',
      callId: "toolu_bdrk_edit",
    }),
    // The result envelope duplicates the edit and must NOT double-count.
    cbLine({
      type: "function_call_result",
      name: "Edit",
      callId: "toolu_bdrk_edit",
      status: "completed",
      output: { type: "text", text: "Successfully edited file: /repo/token.ts" },
    }),
    cbLine({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done." }],
    }),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
}

describe("CodeBuddy transcript → extractChangedFiles", () => {
  test("Edit function_call surfaces the absolute changed path (bug: was zero)", async () => {
    const p = join(tmp, "cb.jsonl");
    writeCodebuddyFixture(p);
    const files = await extractChangedFiles(p);
    expect(files).toEqual(["/repo/token.ts"]);
  });

  test("non-edit tool calls (Glob) contribute no changed files", async () => {
    const p = join(tmp, "cb-glob-only.jsonl");
    writeFileSync(
      p,
      `${cbLine({ type: "function_call", name: "Glob", arguments: '{"pattern":"**/*.ts"}', callId: "x" })}\n`,
    );
    expect(await extractChangedFiles(p)).toEqual([]);
  });

  test("Write function_call is also counted", async () => {
    const p = join(tmp, "cb-write.jsonl");
    writeFileSync(
      p,
      `${cbLine({ type: "function_call", name: "Write", arguments: '{"file_path": "/repo/new.ts", "content": "x"}', callId: "w" })}\n`,
    );
    expect(await extractChangedFiles(p)).toEqual(["/repo/new.ts"]);
  });

  test("NotebookEdit is deliberately NOT counted (arg key is notebook_path, not wired)", async () => {
    const p = join(tmp, "cb-notebook.jsonl");
    writeFileSync(
      p,
      `${cbLine({ type: "function_call", name: "NotebookEdit", arguments: '{"notebook_path": "/repo/nb.ipynb"}', callId: "nb" })}\n`,
    );
    expect(await extractChangedFiles(p)).toEqual([]);
  });

  test("malformed arguments JSON degrades gracefully (no crash, no path)", async () => {
    const p = join(tmp, "cb-bad.jsonl");
    writeCodebuddyFixture(p, { editArgs: "{not valid json" });
    expect(await extractChangedFiles(p)).toEqual([]);
  });
});

describe("CodeBuddy transcript → extractLatestUserMessage", () => {
  test("returns the user prompt from a message/input_text turn", async () => {
    const p = join(tmp, "cb.jsonl");
    writeCodebuddyFixture(p);
    expect(await extractLatestUserMessage(p)).toBe(
      "In token.ts, change the <= to < in the expiresAt comparison.",
    );
  });
});

describe("CodeBuddy transcript → extractTranscriptTurns", () => {
  test("yields ordered user/assistant turns including the edit tool-use summary", async () => {
    const p = join(tmp, "cb.jsonl");
    writeCodebuddyFixture(p);
    const turns = await extractTranscriptTurns(p);
    expect(turns[0]?.role).toBe("user");
    expect(turns[0]?.text).toContain("change the <= to <");
    // The Edit surfaces as an assistant tool-use summary turn so packContext sees code work.
    expect(turns.some((t) => t.role === "assistant" && t.text.includes("token.ts"))).toBe(true);
    expect(turns.some((t) => t.role === "assistant" && t.text.includes("Done."))).toBe(true);
  });
});

describe("Claude transcript passthrough (regression)", () => {
  test("Claude-format lines are untouched by the CodeBuddy adapter", async () => {
    const p = join(tmp, "claude.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Fix the bug" },
        timestamp: "2026-05-20T10:00:00.000Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Write", input: { file_path: "/tmp/proj/fix.ts" } }],
        },
        timestamp: "2026-05-20T10:00:05.000Z",
      }),
    ];
    writeFileSync(p, `${lines.join("\n")}\n`);
    expect(await extractChangedFiles(p)).toEqual(["/tmp/proj/fix.ts"]);
    expect(await extractLatestUserMessage(p)).toBe("Fix the bug");
  });
});

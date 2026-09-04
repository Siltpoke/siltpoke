// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Codex rollout transcript adapter — fixture lines modeled 1:1 on a real
 * codex-cli 0.142.5 rollout JSONL captured during the 2026-07-07 host-
 * integration smoke (session 019f3e13-876e): every line is a
 * {timestamp, type, payload} envelope; file changes surface as
 * event_msg/patch_apply_end with absolute paths in payload.changes.
 */
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
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
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-codex-transcript-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function codexLine(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-07-07T19:35:00.000Z", type, payload });
}

/** Minimal-but-faithful rollout: meta → user turn → commentary → patch → final reply. */
function writeCodexFixture(path: string, opts?: { patchSuccess?: boolean }): void {
  const lines = [
    codexLine("session_meta", {
      session_id: "019f3e13-876e-7302-8fe2-c4b0f8659996",
      cwd: "/tmp/proj",
      originator: "codex_exec",
      cli_version: "0.142.5",
    }),
    codexLine("turn_context", { cwd: "/tmp/proj", model: "gpt-5" }),
    codexLine("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Create a file math.ts with an add function." }],
    }),
    codexLine("event_msg", {
      type: "user_message",
      message: "Create a file math.ts with an add function.",
      images: [],
    }),
    codexLine("response_item", {
      type: "reasoning",
      id: "rs_x",
      summary: [],
      encrypted_content: "REDACTED",
    }),
    codexLine("event_msg", {
      type: "agent_message",
      message: "I’ll create only math.ts with the requested contents.",
      phase: "commentary",
    }),
    codexLine("response_item", {
      type: "custom_tool_call",
      status: "completed",
      call_id: "call_1",
      name: "apply_patch",
      input: "*** Begin Patch\n*** Add File: math.ts\n+export function add(a: number, b: number): number { return a + b; }\n*** End Patch\n",
    }),
    codexLine("event_msg", {
      type: "patch_apply_end",
      call_id: "call_1",
      stdout: "Success. Updated the following files:\nA math.ts\n",
      stderr: "",
      success: opts?.patchSuccess ?? true,
      changes: {
        "/tmp/proj/math.ts": { type: "add", content: "export function add..." },
      },
      status: "completed",
    }),
    codexLine("event_msg", {
      type: "agent_message",
      message: "Created math.ts with the exact requested contents.",
    }),
    codexLine("event_msg", { type: "task_complete", last_agent_message: "Created math.ts." }),
    codexLine("event_msg", { type: "token_count", info: null }),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
}

describe("Codex rollout → extractChangedFiles", () => {
  test("apply_patch add surfaces the absolute changed path", async () => {
    const p = join(tmp, "rollout.jsonl");
    writeCodexFixture(p);
    const files = await extractChangedFiles(p);
    expect(files).toEqual(["/tmp/proj/math.ts"]);
  });

  test("update and delete changes are also counted", async () => {
    const p = join(tmp, "rollout-multi.jsonl");
    const lines = [
      codexLine("event_msg", {
        type: "patch_apply_end",
        call_id: "call_2",
        success: true,
        changes: {
          "/tmp/proj/a.ts": { type: "update" },
          "/tmp/proj/b.ts": { type: "delete" },
        },
      }),
    ];
    writeFileSync(p, `${lines.join("\n")}\n`);
    const files = await extractChangedFiles(p);
    expect(files.sort()).toEqual(["/tmp/proj/a.ts", "/tmp/proj/b.ts"]);
  });

  test("failed patch application contributes no changed files", async () => {
    const p = join(tmp, "rollout-failed.jsonl");
    writeCodexFixture(p, { patchSuccess: false });
    const files = await extractChangedFiles(p);
    expect(files).toEqual([]);
  });
});

describe("Codex rollout → extractLatestUserMessage", () => {
  test("returns the user prompt from event_msg/user_message", async () => {
    const p = join(tmp, "rollout.jsonl");
    writeCodexFixture(p);
    const msg = await extractLatestUserMessage(p);
    expect(msg).toBe("Create a file math.ts with an add function.");
  });
});

describe("Codex rollout → extractTranscriptTurns", () => {
  test("yields ordered user/assistant turns without duplicating the response_item copy", async () => {
    const p = join(tmp, "rollout.jsonl");
    writeCodexFixture(p);
    const turns = await extractTranscriptTurns(p);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
    expect(turns[0]!.text).toBe("Create a file math.ts with an add function.");
    expect(turns[1]!.text).toContain("I’ll create only math.ts");
    // The patch itself surfaces as a tool-use summary turn so packContext sees code work.
    expect(turns[2]!.text).toContain("math.ts");
    expect(turns[3]!.text).toBe("Created math.ts with the exact requested contents.");
  });
});

describe("Claude transcript passthrough (regression)", () => {
  test("Claude-format lines are untouched by the Codex adapter", async () => {
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
          content: [
            { type: "tool_use", name: "Write", input: { file_path: "/tmp/proj/fix.ts" } },
          ],
        },
        timestamp: "2026-05-20T10:00:05.000Z",
      }),
    ];
    writeFileSync(p, `${lines.join("\n")}\n`);
    expect(await extractChangedFiles(p)).toEqual(["/tmp/proj/fix.ts"]);
    expect(await extractLatestUserMessage(p)).toBe("Fix the bug");
  });
});

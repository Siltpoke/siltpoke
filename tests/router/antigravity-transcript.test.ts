// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * normalizeAntigravityEvents — unit-tested directly against the real agy
 * transcript captured 2026-07-10 (an internal design note
 * statusline-host-design.md §2, gap-verification run). Every assertion below
 * uses the literal committed fixture content, not synthesized JSON.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAntigravityEvents } from "../../src/router/antigravity-transcript";
import { extractChangedFiles } from "../../src/router/context";

const FIXTURE_PATH = join(import.meta.dir, "..", "fixtures", "agy", "transcript-code-edit.jsonl");

function fixtureLines(): unknown[] {
  return readFileSync(FIXTURE_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe("normalizeAntigravityEvents against the real transcript-code-edit.jsonl fixture", () => {
  const lines = fixtureLines();

  test("step_index 0 (USER_INPUT): strips the <USER_REQUEST> wrapper, drops ADDITIONAL_METADATA/USER_SETTINGS_CHANGE", () => {
    const result = normalizeAntigravityEvents(lines[0]);
    expect(result).toEqual([
      {
        type: "user",
        message: {
          role: "user",
          content:
            "create a file calc.py with an add function that has a bug: it returns a minus b instead of a plus b",
        },
        timestamp: "2026-07-10T22:16:21Z",
      },
    ]);
  });

  test("step_index 1 (CONVERSATION_HISTORY): recognized agy step, no reviewable content — dropped", () => {
    expect(normalizeAntigravityEvents(lines[1])).toEqual([]);
  });

  test("step_index 2 (PLANNER_RESPONSE, write_to_file tool_call, no `content`): maps TargetFile to a Write tool_use, ignores `thinking`", () => {
    const result = normalizeAntigravityEvents(lines[2]);
    expect(result).toEqual([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Write",
              input: { file_path: "/Users/v/agy-gap-test/calc.py" },
            },
          ],
        },
        timestamp: "2026-07-10T22:16:21Z",
      },
    ]);
  });

  test("step_index 3 (CODE_ACTION): prose summary of the same edit already captured on step 2 — dropped, not double-counted", () => {
    expect(normalizeAntigravityEvents(lines[3])).toEqual([]);
  });

  test("step_index 4 (CHECKPOINT): dropped", () => {
    expect(normalizeAntigravityEvents(lines[4])).toEqual([]);
  });

  test("step_index 5 (PLANNER_RESPONSE, `content` text only, no tool_calls): assistant text turn", () => {
    const result = normalizeAntigravityEvents(lines[5]);
    expect(result).toEqual([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text:
                "I have created the file [calc.py](file:///Users/v/agy-gap-test/calc.py) with the buggy [add](file:///Users/v/agy-gap-test/calc.py#L1) function that performs subtraction (`a - b`) instead of addition (`a + b`).",
            },
          ],
        },
        timestamp: "2026-07-10T22:16:23Z",
      },
    ]);
  });

  test("step_index 6 (USER_INPUT, no ADDITIONAL_METADATA sibling): strips the wrapper, keeps the CJK request", () => {
    const result = normalizeAntigravityEvents(lines[6]);
    expect(result).toEqual([
      {
        type: "user",
        message: { role: "user", content: "好 帮我把你刚刚create的删掉吧" },
        timestamp: "2026-07-10T22:16:40Z",
      },
    ]);
  });

  test("step_index 7 (PLANNER_RESPONSE, run_command tool_call, no `content`): NOT write_to_file — deliberately unhandled tool, dropped", () => {
    expect(normalizeAntigravityEvents(lines[7])).toEqual([]);
  });

  test("step_index 8 (RUN_COMMAND): dropped", () => {
    expect(normalizeAntigravityEvents(lines[8])).toEqual([]);
  });

  test("step_index 9 (PLANNER_RESPONSE, `content` text only): assistant text turn", () => {
    const result = normalizeAntigravityEvents(lines[9]);
    expect(result).toEqual([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I have deleted the [calc.py](file:///Users/v/agy-gap-test/calc.py) file as requested.",
            },
          ],
        },
        timestamp: "2026-07-10T22:16:41Z",
      },
    ]);
  });
});

describe("normalizeAntigravityEvents passthrough + edge cases", () => {
  test("returns null for non-agy lines (no `type` field, or a `type` outside the known step enum)", () => {
    expect(normalizeAntigravityEvents({ role: "user", content: "hi" })).toBeNull();
    expect(normalizeAntigravityEvents({ type: "event_msg", payload: {} })).toBeNull();
    expect(normalizeAntigravityEvents("not an object")).toBeNull();
    expect(normalizeAntigravityEvents(null)).toBeNull();
    expect(normalizeAntigravityEvents(42)).toBeNull();
  });

  test("USER_INPUT with non-string content degrades to [] instead of throwing", () => {
    expect(normalizeAntigravityEvents({ type: "USER_INPUT", content: 42 })).toEqual([]);
  });

  test("USER_INPUT without the <USER_REQUEST> wrapper falls back to the trimmed raw content", () => {
    expect(normalizeAntigravityEvents({ type: "USER_INPUT", content: "  plain text  " })).toEqual([
      { type: "user", message: { role: "user", content: "plain text" }, timestamp: undefined },
    ]);
  });

  test("PLANNER_RESPONSE with neither `content` nor a write_to_file tool_call is dropped", () => {
    expect(
      normalizeAntigravityEvents({
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "ls" } }],
      }),
    ).toEqual([]);
  });

  test("PLANNER_RESPONSE with a write_to_file tool_call missing TargetFile is skipped, not crashed", () => {
    expect(
      normalizeAntigravityEvents({
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "write_to_file", args: { CodeContent: "x" } }],
      }),
    ).toEqual([]);
  });
});

describe("normalizeAntigravityEvents — agy 1.1.1 CODE_ACTION edit format (replace_file_content)", () => {
  // Faithful to a real agy 1.1.1 CODE_ACTION line captured 2026-07-19: the
  // edited path lives ONLY in the prose `content`; there is no structured
  // write_to_file tool_call (the 2026-07-10 shape). content ends the path with
  // ". If relevant..." and then a [diff_block].
  const CODE_ACTION_CONTENT =
    "Created At: 2026-07-19T15:20:12-07:00\n" +
    "Completed At: 2026-07-19T15:20:12-07:00\n" +
    "The following changes were made by the replace_file_content tool to: " +
    "/Users/v/agysmoke-repo/token.ts. If relevant, proactively run " +
    "terminal commands to execute this code for the USER. Don't ask for permission.\n" +
    "[diff_block_start]\n@@ -1,4 +1,4 @@\n-  return token.expiresAt <= now;\n" +
    "+  return token.expiresAt < now;\n[diff_block_end]";

  test("CODE_ACTION prose → an Edit tool_use with the dotted path captured whole", () => {
    const result = normalizeAntigravityEvents({
      type: "CODE_ACTION",
      status: "DONE",
      created_at: "2026-07-19T22:20:12Z",
      content: CODE_ACTION_CONTENT,
    });
    expect(result).toEqual([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Edit",
              input: { file_path: "/Users/v/agysmoke-repo/token.ts" },
            },
          ],
        },
        timestamp: "2026-07-19T22:20:12Z",
      },
    ]);
  });

  test("path terminated by a bare newline (no 'If relevant' suffix) is still captured whole", () => {
    const result = normalizeAntigravityEvents({
      type: "CODE_ACTION",
      content: "changes were made by the replace_file_content tool to: /repo/a.ts\n[diff_block_start]",
    });
    expect(result).toEqual([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/a.ts" } }],
        },
        timestamp: undefined,
      },
    ]);
  });

  test("a missing space before 'If' cannot run the path off into the sentence (\\S+ bound)", () => {
    // Defensive: even a malformed "…to: /repo/a.ts.If relevant run" stays bounded
    // to the non-whitespace run — never captures "…relevant run".
    const result = normalizeAntigravityEvents({
      type: "CODE_ACTION",
      content: "changes were made by the replace_file_content tool to: /repo/a.ts.If relevant run cmds",
    });
    const content = result?.[0]?.message?.content as
      | { input: { file_path: string } }[]
      | undefined;
    const path = content?.[0]?.input.file_path;
    expect(path).not.toContain(" ");
    expect(path?.startsWith("/repo/a.ts")).toBe(true);
  });

  test("the OLD 'Created file <url> with requested content' phrasing is NOT matched (stays dropped)", () => {
    expect(
      normalizeAntigravityEvents({
        type: "CODE_ACTION",
        content:
          "Created file file:///Users/v/agy-gap-test/calc.py with requested content.\nIf relevant, proactively run terminal commands.",
      }),
    ).toEqual([]);
  });

  test("CODE_ACTION with non-string / no-match content degrades to [] instead of throwing", () => {
    expect(normalizeAntigravityEvents({ type: "CODE_ACTION", content: 42 })).toEqual([]);
    expect(normalizeAntigravityEvents({ type: "CODE_ACTION", content: "no tool phrase here" })).toEqual([]);
  });

  test("extractChangedFiles surfaces the agy 1.1.1 CODE_ACTION edit end-to-end (was zero before the fix)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "siltpoke-agy-codeaction-"));
    const p = join(tmp, "transcript.jsonl");
    writeFileSync(
      p,
      `${JSON.stringify({ type: "USER_INPUT", content: "<USER_REQUEST>\nchange <= to <\n</USER_REQUEST>" })}\n${JSON.stringify(
        { type: "CODE_ACTION", status: "DONE", content: CODE_ACTION_CONTENT },
      )}\n`,
    );
    expect(await extractChangedFiles(p)).toEqual(["/Users/v/agysmoke-repo/token.ts"]);
    rmSync(tmp, { recursive: true, force: true });
  });
});

// Real transcript from the Antigravity desktop app (2.0.6, gemini-3.8-flash-high),
// captured 2026-09-30 by a hook probe; paths rewritten to /tmp. The edit is a
// structured `replace_file_content` tool_call on PLANNER_RESPONSE, and a GENERIC
// step repeats it as prose. Before this fix the parser saw zero changed files.
const DESKTOP_FIXTURE = join(
  import.meta.dir,
  "..",
  "fixtures",
  "agy",
  "transcript-desktop-replace-file-content.jsonl",
);

function desktopLines(): { type: string }[] {
  return readFileSync(DESKTOP_FIXTURE, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { type: string });
}

function editEvent(
  filePath: string,
  timestamp: string | undefined,
): NonNullable<ReturnType<typeof normalizeAntigravityEvents>> {
  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Edit", input: { file_path: filePath } }],
      },
      timestamp,
    },
  ];
}

describe("Antigravity desktop 2.0.6 transcript — edits are read from the replace_file_content tool_call", () => {
  const lines = desktopLines();

  test("fixture shape is what this block assumes (8 steps, edit on step 3, GENERIC prose on step 4)", () => {
    expect(lines.map((l) => l.type)).toEqual([
      "USER_INPUT",
      "PLANNER_RESPONSE",
      "GENERIC",
      "PLANNER_RESPONSE",
      "GENERIC",
      "PLANNER_RESPONSE",
      "GENERIC",
      "PLANNER_RESPONSE",
    ]);
  });

  test("step 3 (PLANNER_RESPONSE, replace_file_content tool_call) → an Edit tool_use on TargetFile", () => {
    expect(normalizeAntigravityEvents(lines[3])).toEqual(
      editEvent("/tmp/agy-desktop-ws/hello.txt", "2026-10-01T02:35:41Z"),
    );
  });

  test("steps 1 and 5 (view_file tool_calls) are reads, not edits — dropped", () => {
    expect(normalizeAntigravityEvents(lines[1])).toEqual([]);
    expect(normalizeAntigravityEvents(lines[5])).toEqual([]);
  });
});

describe("Antigravity desktop 2.0.6 transcript — GENERIC is dropped and the file is found end to end", () => {
  const lines = desktopLines();

  test("GENERIC steps are recognized agy steps and dropped — the prose repeat of the edit is not double-counted", () => {
    expect(normalizeAntigravityEvents(lines[2])).toEqual([]);
    expect(normalizeAntigravityEvents(lines[4])).toEqual([]);
    expect(normalizeAntigravityEvents(lines[6])).toEqual([]);
  });

  test("extractChangedFiles on the real desktop transcript returns exactly the edited file (was [] before the fix)", async () => {
    expect(await extractChangedFiles(DESKTOP_FIXTURE)).toEqual(["/tmp/agy-desktop-ws/hello.txt"]);
  });
});

describe("normalizeAntigravityEvents — structured edit tool names, synthetic edge cases", () => {
  test("multi_replace_file_content maps the same way (synthetic: same TargetFile arg, not yet seen in a captured transcript)", () => {
    expect(
      normalizeAntigravityEvents({
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "multi_replace_file_content", args: { TargetFile: "/repo/b.ts" } }],
      }),
    ).toEqual(editEvent("/repo/b.ts", undefined));
  });

  test("a tool name that is an inherited object key (constructor, toString) is not an edit", () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(
        normalizeAntigravityEvents({
          type: "PLANNER_RESPONSE",
          tool_calls: [{ name, args: { TargetFile: "/repo/c.ts" } }],
        }),
      ).toEqual([]);
    }
  });

  test("replace_file_content without a TargetFile is skipped, not crashed", () => {
    expect(
      normalizeAntigravityEvents({
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "replace_file_content", args: { ReplacementContent: "x" } }],
      }),
    ).toEqual([]);
  });
});

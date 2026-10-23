/**
 * 🛡 prompt-injection defence [C]: which tools a reviewer used, read from the
 * CLI's own output. Fixture shapes are copied from real runs:
 *   claude — the 2026-10-18 probe's denied Read
 *     (an internal design note)
 *   codex  — `codex exec --json -s read-only`, 2026-10-19, asked to read a
 *     file inside its folder and one outside it (it read both).
 */
import { describe, expect, test } from "bun:test";
import { callBrain } from "../../src/brain/brain";
import { makeClaudeProvider } from "../../src/brain/provider";
import { makeCodexProvider } from "../../src/brain/providers/codex";
import { claudeToolCalls, codexToolCalls, describeToolCalls } from "../../src/brain/tool-calls";

const CANARY = "/sandbox/prompt-injection/outside/canary.txt";

const CLAUDE_EVENTS = [
  { type: "system", subtype: "init", tools: ["Read", "Grep", "Glob"] },
  {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_A", name: "Read", input: { file_path: CANARY } }] },
  },
  { type: "system", subtype: "permission_denied", tool_name: "Read", tool_use_id: "toolu_A" },
  {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_A", is_error: true, content: "Claude requested permissions to read from …" }] },
  },
  {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Looking around." },
        { type: "tool_use", id: "toolu_B", name: "Grep", input: { pattern: "formatName", path: "src" } },
      ],
    },
  },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_B", content: "src/format.ts:2" }] } },
  { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} },
];

const CODEX_EVENTS = [
  { type: "thread.started", thread_id: "t" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "error", message: "Exceeded skills context budget." } },
  { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "I'll read both files." } },
  {
    type: "item.started",
    item: { id: "item_2", type: "command_execution", command: "/bin/zsh -lc \"sed -n '1,200p' ../outside.txt\"", aggregated_output: "", exit_code: null, status: "in_progress" },
  },
  {
    type: "item.completed",
    item: { id: "item_2", type: "command_execution", command: "/bin/zsh -lc \"sed -n '1,200p' ../outside.txt\"", aggregated_output: "outside-secret-7\n", exit_code: 0, status: "completed" },
  },
  { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "outside-secret-7" } },
  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } },
];

describe("claudeToolCalls", () => {
  test("every tool_use, the denied one marked failed", () => {
    expect(claudeToolCalls(CLAUDE_EVENTS)).toEqual([
      { tool: "Read", target: CANARY, failed: true },
      { tool: "Grep", target: "formatName in src", failed: false },
    ]);
  });

  test("an event list with no tool_use is an empty list (the verbose list does report tools)", () => {
    expect(claudeToolCalls([{ type: "system", subtype: "init" }, { type: "result", result: "ok" }])).toEqual([]);
  });

  test("what a tool returned is never kept — only name, target, failed", () => {
    const json = JSON.stringify(claudeToolCalls(CLAUDE_EVENTS));
    expect(json).not.toContain("src/format.ts:2");
    expect(json).not.toContain("requested permissions");
  });

  test("a long target is capped at 2000 (R11)", () => {
    const events = [{ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Read", input: { file_path: "a".repeat(3000) } }] } }];
    const [call] = claudeToolCalls(events);
    expect(call?.target).toHaveLength(2001);
    expect(call?.target.endsWith("…")).toBe(true);
  });
});

describe("codexToolCalls", () => {
  test("one record per command, started + completed folded together; words and warnings are not tools", () => {
    expect(codexToolCalls(CODEX_EVENTS)).toEqual([
      { tool: "shell", target: "/bin/zsh -lc \"sed -n '1,200p' ../outside.txt\"", failed: false },
    ]);
  });

  test("non-zero exit or a failed/declined status marks it failed", () => {
    const events = [
      { type: "item.completed", item: { id: "a", type: "command_execution", command: "cat nope", exit_code: 1, status: "failed" } },
      { type: "item.completed", item: { id: "b", type: "command_execution", command: "rm x", exit_code: null, status: "declined" } },
    ];
    expect(codexToolCalls(events).map((c) => c.failed)).toEqual([true, true]);
  });

  test("a command that started and never completed is still recorded", () => {
    const events = [{ type: "item.started", item: { id: "a", type: "command_execution", command: "cat ../canary.txt", status: "in_progress" } }];
    expect(codexToolCalls(events)).toEqual([{ tool: "shell", target: "cat ../canary.txt", failed: false }]);
  });

  test("a non-shell tool item is kept under its own type", () => {
    const events = [{ type: "item.completed", item: { id: "m", type: "mcp_tool_call", server: "fs", tool: "read_file", status: "completed" } }];
    expect(codexToolCalls(events)).toEqual([{ tool: "mcp_tool_call", target: "fs.read_file", failed: false }]);
  });

  test("an unknown item never leaks what the tool returned into the target", () => {
    const events = [
      { type: "item.completed", item: { id: "u", type: "some_future_tool", result: "SECRET-1", aggregated_output: "SECRET-2", error: "SECRET-3" } },
      { type: "item.completed", item: { id: "w", type: "web_search", query: "siltpoke docs", result: "SECRET-4" } },
      { type: "item.completed", item: { id: "f", type: "file_change", changes: [{ path: "src/a.ts", diff: "SECRET-5" }] } },
    ];
    const calls = codexToolCalls(events);
    expect(JSON.stringify(calls)).not.toContain("SECRET");
    expect(calls.map((c) => c.target)).toEqual(["", "siltpoke docs", "src/a.ts"]);
  });

  test("codex's own plan (todo_list) is not a tool call", () => {
    const events = [{ type: "item.completed", item: { id: "p", type: "todo_list", items: [{ text: "read ../canary.txt" }] } }];
    expect(codexToolCalls(events)).toEqual([]);
  });
});

describe("describeToolCalls (siltpoke review's terminal line)", () => {
  test("three different answers for three different facts", () => {
    expect(describeToolCalls("not_recorded")).toBe("reviewer tools: not recorded — this agent does not report them");
    expect(describeToolCalls(undefined)).toBe("reviewer tools: not recorded — this agent does not report them");
    expect(describeToolCalls([])).toBe("reviewer tools: none");
    expect(describeToolCalls([{ tool: "Read", target: CANARY, failed: true }, { tool: "Grep", target: "x in src", failed: false }])).toBe(
      `reviewer tools: Read ${CANARY} (failed) · Grep x in src`,
    );
  });
});

function fakeSpawn(stdoutText: string): typeof Bun.spawn {
  return ((_cmd: string[], _options: unknown) => ({
    stdin: { write(_c: string) {}, end() {} },
    stdout: new Response(stdoutText).body,
    stderr: new Response("").body,
    exited: Promise.resolve(0),
    kill() {},
  })) as unknown as typeof Bun.spawn;
}

const REVIEW = JSON.stringify({
  mood: "happy", pose: "base", bubble_short: "ok", bubble_long: "l",
  critique_for_claude: "", severity: "info", confidence: "medium", xp_earned_events: [],
});

describe("providers hand the record up", () => {
  test("claude: callRaw and call both carry toolCalls from the event array", async () => {
    const events = [...CLAUDE_EVENTS.slice(0, -1), { type: "result", subtype: "success", is_error: false, result: REVIEW, usage: {} }];
    const p = makeClaudeProvider();
    const raw = await p.callRaw({ systemPrompt: "s", contextBundle: "c", spawnFn: fakeSpawn(JSON.stringify(events)) });
    expect(raw.toolCalls).toEqual(claudeToolCalls(CLAUDE_EVENTS));
    const called = await p.call({ systemPrompt: "s", contextBundle: "c", spawnFn: fakeSpawn(JSON.stringify(events)) });
    expect(called.toolCalls?.[0]).toEqual({ tool: "Read", target: CANARY, failed: true });
  });

  test("claude: a single result object (no event list) carries no tool record — not_recorded, not []", async () => {
    const single = { type: "result", subtype: "success", is_error: false, result: REVIEW, usage: {} };
    const raw = await makeClaudeProvider().callRaw({ systemPrompt: "s", contextBundle: "c", spawnFn: fakeSpawn(JSON.stringify(single)) });
    expect(raw.text).toBe(REVIEW);
    expect(raw.toolCalls).toBeUndefined();
  });

  test("claude: bare callBrain (the no-home fallback in runCritic) keeps toolCalls too", async () => {
    const events = [...CLAUDE_EVENTS.slice(0, -1), { type: "result", subtype: "success", is_error: false, result: REVIEW, usage: {} }];
    const r = await callBrain({ systemPrompt: "s", contextBundle: "c", spawnFn: fakeSpawn(JSON.stringify(events)) });
    expect(r.toolCalls).toEqual(claudeToolCalls(CLAUDE_EVENTS));
  });

  test("codex: callRaw and call both carry toolCalls from the JSONL", async () => {
    const lines = [...CODEX_EVENTS.slice(0, -2), { type: "item.completed", item: { id: "z", type: "agent_message", text: REVIEW } }, CODEX_EVENTS.at(-1)];
    const stdout = lines.map((l) => JSON.stringify(l)).join("\n");
    const p = makeCodexProvider({ configHome: "/nonexistent" });
    const raw = await p.callRaw({ systemPrompt: "s", contextBundle: "c", spawnFn: fakeSpawn(stdout) });
    expect(raw.toolCalls).toEqual(codexToolCalls(CODEX_EVENTS));
    const called = await p.call({ systemPrompt: "s", contextBundle: "c", spawnFn: fakeSpawn(stdout) });
    expect(called.toolCalls).toHaveLength(1);
  });
});

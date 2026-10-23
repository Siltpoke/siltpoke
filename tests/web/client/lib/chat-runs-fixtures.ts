/**
 * Chat call records shaped like the real ones in ~/.siltpoke/chat-runs/
 * (2026-10-15: one claude answer, three start failures). Line contents are
 * cut down; the line TYPES and their order are the real ones.
 */
import type { ChatRun } from "../../../../src/chat/run-store";

const BLOCKS = [
  { name: "page context", chars: 30, text: "You are siltpoke. Settings page" },
  { name: "what siltpoke knows about you", chars: 22, text: "- Prefers plain words." },
  { name: "memory-save rule", chars: 25, text: "You cannot save anything." },
  { name: "conversation", chars: 25, text: "[user] What does this do?" },
].map((b) => ({ ...b, chars: b.text.length }));

export function baseRun(over: Partial<ChatRun> = {}): ChatRun {
  return {
    v: 1,
    run_id: "r-1",
    session_id: "s-1",
    message_id: "m-1",
    started_at: "2026-10-15T22:40:40.359Z",
    total_ms: 14196,
    first_token_ms: 13319,
    family: "claude",
    source: "chosen",
    model_requested: "claude-haiku-5-5",
    model_reported: "claude-haiku-5-5",
    outcome: "ok",
    failure_reason: null,
    failure_message: null,
    tokens: { input: 2, output: 1491, cache_read: 10472, cache_write: 34923, thinking: 854 },
    cost: { kind: "usd", usd: 0.00783502 },
    command: ["claude", "-p", "--model", "claude-haiku-5-5", "--output-format", "stream-json", "--verbose"],
    cli_version: "2.1.301",
    exit_code: 0,
    permitted_tools: ["Read", "Grep"],
    prompt_blocks: BLOCKS,
    prompt_omitted: ["past episodes", "memory-save marker", "related past chats"],
    output: [],
    output_truncated: false,
    ...over,
  };
}

const j = (o: unknown): string => JSON.stringify(o);

/** The real claude answer's line sequence (hooks → init → thinking counts →
 * thinking → text → rate limit → result → a late hook). */
export const CLAUDE_OK_LINES: Array<{ t_ms: number; line: string }> = [
  { t_ms: 2294, line: j({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" }) },
  { t_ms: 2297, line: j({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" }) },
  {
    t_ms: 2297,
    line: j({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", output: "/bin/sh: powershell: command not found\n", stderr: "/bin/sh: powershell: command not found\n" }),
  },
  { t_ms: 2306, line: j({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", output: "", stderr: "" }) },
  { t_ms: 4319, line: j({ type: "system", subtype: "init", cwd: "/", tools: ["Task", "Bash", "Read"], model: "claude-haiku-5-5" }) },
  { t_ms: 6042, line: j({ type: "system", subtype: "thinking_tokens", estimated_tokens: 50 }) },
  { t_ms: 9430, line: j({ type: "system", subtype: "thinking_tokens", estimated_tokens: 700 }) },
  {
    t_ms: 10414,
    line: j({ type: "assistant", message: { model: "claude-haiku-5-5", content: [{ type: "thinking", thinking: "", signature: "CAQS" }] } }),
  },
  {
    t_ms: 13316,
    line: j({
      type: "assistant",
      message: { model: "claude-haiku-5-5", content: [{ type: "text", text: "这一页是 Siltpoke 的设置页。" }], usage: { output_tokens: 1491 } },
    }),
  },
  {
    t_ms: 13330,
    line: j({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.41 }, seven_day: { utilization: 0.32 } } },
    }),
  },
  {
    t_ms: 13480,
    line: j({
      duration_api_ms: 8972,
      type: "result",
      subtype: "success",
      duration_ms: 13400,
      total_cost_usd: 0.00783502,
      usage: { input_tokens: 2, cache_creation_input_tokens: 34923, cache_read_input_tokens: 10472, output_tokens: 1491 },
      modelUsage: { "claude-haiku-5-5": {} },
      result: "这一页是 Siltpoke 的设置页。",
    }),
  },
  { t_ms: 13485, line: j({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", output: "" }) },
];

export const TOOL_LINES: Array<{ t_ms: number; line: string }> = [
  { t_ms: 900, line: j({ type: "system", subtype: "init", tools: ["Read", "Grep"], model: "claude-haiku-5-5" }) },
  {
    t_ms: 1100,
    line: j({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "src/config/load.ts", offset: 30, limit: 40 } }] } }),
  },
  { t_ms: 1200, line: j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "42  export function readConfig()" }] } }) },
  {
    t_ms: 7400,
    line: j({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "Grep", input: { pattern: "readConfig", path: "." } }] } }),
  },
];

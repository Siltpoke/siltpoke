/**
 * Chat Runs window — record → what the window shows (spec 2026-10-13 §10.1).
 */
import { describe, expect, test } from "bun:test";
import { composeChatPrompt } from "../../../../src/chat/prompt-blocks";
import { runRowHtml } from "../../../../src/web/client/lib/chat-runs-render";
import { buildRunView, shortModel } from "../../../../src/web/client/lib/chat-runs-view";
import { baseRun, CLAUDE_OK_LINES, TOOL_LINES } from "./chat-runs-fixtures";

/** Every stdout line must be shown in exactly one step's `{ }` (spec: "完整输出，一条不删"). */
function expectEveryLineOnce(run: ReturnType<typeof baseRun>): void {
  const view = buildRunView(run, 0);
  const shown = view.steps.flatMap((s) => s.raw);
  expect(shown.sort()).toEqual(run.output.map((o) => o.line).sort());
}

describe("steps from claude's output", () => {
  const run = baseRun({ output: CLAUDE_OK_LINES });
  const view = buildRunView(run, 0);

  test("every line lands in exactly one step", () => expectEveryLineOnce(run));

  test("steps in order, in plain words", () => {
    expect(view.steps.map((s) => s.label)).toEqual([
      "Sent",
      "Hooks",
      "Started",
      "Thought",
      "Answered",
      "Checked usage limit",
      "Finished",
      "Hooks",
    ]);
  });

  test("consecutive hook lines fold into one step and say which printed an error", () => {
    const hooks = view.steps[1];
    expect(hooks?.raw).toHaveLength(4);
    expect(hooks?.body).toEqual({
      kind: "lines",
      lines: [
        "SessionStart:startup started",
        "SessionStart:startup started",
        "SessionStart:startup finished, printed 39 chars (with an error message)",
        "SessionStart:startup finished",
      ],
    });
  });

  test("Started names the model and the allowed tools", () => {
    expect(view.steps[2]?.body).toEqual({
      kind: "lines",
      lines: ["Model: claude-haiku-5-5", "Working folder: /", "Allowed to use 3 tools: Task, Bash, Read (what it actually used is below)"],
    });
  });

  test("a thought whose words claude withheld says so, and carries the running token count", () => {
    const thought = view.steps[3];
    expect(thought?.tokens).toBe("~700 thinking tokens");
    expect(thought?.body).toEqual({
      kind: "quote",
      text: null,
      note: "The CLI did not include the words of this thought, only that it thought.",
    });
    expect(thought?.raw).toHaveLength(3);
  });

  test("a step's work runs from the end of the step before it to its own last line", () => {
    const span = (label: string) => {
      const s = view.steps.find((x) => x.label === label);
      return [s?.atMs, s?.tookMs];
    };
    expect(span("Sent")).toEqual([0, 2294]); // CLI start-up, until the first line
    expect(span("Started")).toEqual([2306, 4319 - 2306]); // after the last hook line
    expect(span("Thought")).toEqual([4319, 10414 - 4319]); // through the thinking block
    expect(span("Answered")).toEqual([10414, 13316 - 10414]); // writing the answer is the answer's time
  });

  test("Sent carries the input total; the answer its output tokens", () => {
    expect(view.steps[0]?.tokens).toBe("45,397 tokens in");
    expect(view.steps[4]?.tokens).toBe("1,491 tokens out");
  });

  test("trace marks the one slowest step", () => {
    const slow = view.trace.rows.filter((r) => r.slowest);
    expect(slow.map((r) => r.name)).toEqual(["Thought"]);
    expect(view.trace.rows.find((r) => r.name === "Sent")?.tokens).toBe("45,397");
  });

  test("row head and summary", () => {
    expect(view.agent).toBe("claude");
    expect(view.modelShort).toBe("haiku 5.5");
    expect(view.pick).toEqual({ tag: "from settings", long: "You picked claude for chat on the Settings page.", chosen: true });
    expect(view.runtime).toBe("14.2 s (first words after 13.3 s)");
    expect(view.modelNote).toBeNull();
    expect(view.result).toBeNull();
    expect(view.why).toBe(
      "Only what Siltpoke sent (page context, what siltpoke knows about you, memory-save rule, conversation). It did not open any file or run any tool.",
    );
  });
});

describe("tool calls", () => {
  const run = baseRun({ outcome: "failed", failure_reason: "timeout", failure_message: "Timed out after 60 s.", total_ms: 60_000, output: TOOL_LINES, tokens: null, model_reported: null });
  const view = buildRunView(run, 2);

  test("a tool call and what it got back are one step", () => {
    const read = view.steps.find((s) => s.body.kind === "tool" && s.body.name === "Read");
    expect(read?.body).toEqual({
      kind: "tool",
      name: "Read",
      input: "src/config/load.ts, lines 30–70",
      calledAtMs: 1100,
      result: "42  export function readConfig()",
      resultAtMs: 1200,
    });
    expect(read?.raw).toHaveLength(2);
    expectEveryLineOnce(run);
  });

  test("a quick tool is not blamed for the slow answer printed after it (review round 1)", () => {
    const quick = baseRun({
      total_ms: 9200,
      output: [
        ...TOOL_LINES.slice(0, 3),
        { t_ms: 9000, line: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }) },
        { t_ms: 9100, line: JSON.stringify({ type: "result", subtype: "success", usage: {} }) },
      ],
    });
    const v = buildRunView(quick, 0);
    const tool = v.steps.find((s) => s.kind === "tool");
    expect(tool?.tookMs).toBe(1200 - 900);
    expect(v.trace.rows.find((r) => r.slowest)?.name).toBe("Answered");
    expect(runRowHtml(v)).not.toMatch(/Read[\s\S]*slowest step[\s\S]*got back at/);
  });

  const use = (t: number, id: string, name: string) => ({
    t_ms: t,
    line: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: { file_path: id } }] } }),
  });
  const back = (t: number, id: string) => ({
    t_ms: t,
    line: JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "x" }] } }),
  });
  const span = (v: ReturnType<typeof buildRunView>, name: string) => {
    const s = v.steps.find((x) => x.body.kind === "tool" && x.body.name === name);
    return [s?.atMs, s?.tookMs];
  };

  test("parallel tool calls each keep their own span (review round 2)", () => {
    const v = buildRunView(
      baseRun({ total_ms: 7000, output: [use(1000, "a", "Read"), use(1050, "b", "Grep"), back(1200, "b"), back(6000, "a")] }),
      0,
    );
    expect(span(v, "Read")).toEqual([1000, 5000]);
    expect(span(v, "Grep")).toEqual([1050, 150]);
  });

  test("a tool inside a Task keeps its own span (review round 2)", () => {
    const v = buildRunView(
      baseRun({ total_ms: 16_000, output: [use(1000, "t", "Task"), use(2000, "r", "Read"), back(2100, "r"), back(15_000, "t")] }),
      0,
    );
    expect(span(v, "Task")).toEqual([1000, 14_000]);
    expect(span(v, "Read")).toEqual([2000, 100]);
  });

  test("a thought inside a Task keeps its first line as its start (review round 3)", () => {
    const tok = (t: number) => ({ t_ms: t, line: JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 5 }) });
    const think = (t: number) => ({
      t_ms: t,
      line: JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hm" }] } }),
    });
    const v = buildRunView(
      baseRun({ total_ms: 16_000, output: [use(1000, "t", "Task"), tok(2000), think(5000), back(15_000, "t")] }),
      0,
    );
    const th = v.steps.find((s) => s.kind === "thought");
    expect([th?.atMs, th?.tookMs]).toEqual([2000, 3000]);
  });

  test("in a call that finished, a tool with no matched result is not stretched over later steps (review round 3)", () => {
    const answer = { t_ms: 4000, line: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }) };
    const v = buildRunView(baseRun({ total_ms: 5000, output: [use(1000, "a", "Read"), answer] }), 0);
    expect(span(v, "Read")).toEqual([1000, 0]);
    expect(v.steps.find((s) => s.kind === "answer")?.tookMs).toBe(3000);
  });

  test("plain-text output (agy) and a silent failure do not charge the wait to Sent (review round 3)", () => {
    const agy = buildRunView(baseRun({ family: "agy", total_ms: 9000, output: [{ t_ms: 8800, line: "answer" }] }), 0);
    expect(agy.steps.map((s) => [s.label, s.tookMs])).toEqual([
      ["Sent", 0],
      ["Printed", 8800],
    ]);
    const silent = buildRunView(baseRun({ outcome: "failed", failure_message: "Timed out.", total_ms: 60_000, output: [] }), 0);
    expect(silent.steps.map((s) => [s.label, s.tookMs])).toEqual([
      ["Sent", 0],
      ["Stopped", 60_000],
    ]);
  });

  test("a tool call that never came back runs to the end of the call", () => {
    const grep = view.steps.filter((s) => s.kind === "tool").at(-1);
    expect(grep?.atMs).toBe(1200);
    expect(grep?.tookMs).toBe(60_000 - 1200);
    expect(view.steps.at(-1)?.tookMs).toBe(0);
  });

  test("a failed call says which step was still running and ends with Stopped", () => {
    expect(view.n).toBe(3);
    expect(view.result).toEqual({
      message: "Timed out after 60 s.",
      stuck: "Still running when it stopped: Grep “readConfig” in ., started at 7.4 s.",
    });
    expect(view.steps.at(-1)?.label).toBe("Stopped");
    expect(view.runtime).toBe("60.0 s, then it failed");
    expect(view.why).toStartWith("No answer.");
  });
});

describe("other agents", () => {
  test("qoder prints one result block: it becomes the answer + Finished, and the model line says what was not reported", () => {
    const line = JSON.stringify({ type: "result", result: "That works.", usage: { input_tokens: 1390, output_tokens: 312 } });
    const run = baseRun({
      family: "qoder",
      model_requested: "lite",
      model_reported: null,
      first_token_ms: null,
      total_ms: 9800,
      output: [{ t_ms: 9800, line }],
    });
    const view = buildRunView(run, 0);
    expect(view.steps.map((s) => s.label)).toEqual(["Sent", "Answered", "Finished"]);
    // It printed only at the end: the wait was the answer, not start-up (review round 2).
    expect(view.steps.map((s) => s.tookMs)).toEqual([0, 9800, 0]);
    expect(view.modelShort).toBe("lite");
    expect(view.modelNote).toBe("Settings chose lite; qoder did not report which model it actually used.");
    expect(view.runtime).toBe("9.8 s (qoder sends the whole reply at once)");
    expect(view.why).toEndWith("Qoder does not say whether it also read files.");
    expectEveryLineOnce(run);
  });

  test("codex --json events", () => {
    const lines = [
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { type: "reasoning", text: "Look at the page." } },
      { type: "item.completed", item: { type: "agent_message", text: "Answer." } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } },
    ].map((o, i) => ({ t_ms: i * 100, line: JSON.stringify(o) }));
    const run = baseRun({ family: "codex", output: lines, first_token_ms: null });
    const view = buildRunView(run, 0);
    expect(view.steps.map((s) => s.label)).toEqual(["Sent", "Started", "Thought", "Answered", "Finished"]);
    expect(view.why).toEndWith(". It did not open any file or run any tool.");
    expectEveryLineOnce(run);
  });

  // Shape recorded from a real `codex exec --json -s read-only` run, 2026-10-19:
  // asked to read a file inside the folder and one outside it, it did both.
  const CODEX_TOOL_LINES = [
    { type: "thread.started", thread_id: "t" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "error", message: "Exceeded skills context budget." } },
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
  ].map((o, i) => ({ t_ms: i * 100, line: JSON.stringify(o) }));

  test("codex commands show as tool steps with what they printed", () => {
    const run = baseRun({ family: "codex", output: CODEX_TOOL_LINES, first_token_ms: null });
    const view = buildRunView(run, 0);
    expect(view.steps.map((s) => s.label)).toEqual(["Sent", "Started", "Printed", "Printed", "Used a tool", "Answered", "Finished"]);
    const tool = view.steps.find((s) => s.kind === "tool");
    expect(tool?.body).toEqual({
      kind: "tool",
      name: "Shell",
      input: "/bin/zsh -lc \"sed -n '1,200p' ../outside.txt\"",
      calledAtMs: 300,
      result: "outside-secret-7\n",
      resultAtMs: 400,
    });
    expect(tool?.raw).toHaveLength(2);
    expect(view.why).toContain("what it looked up itself: Shell /bin/zsh -lc");
    expectEveryLineOnce(run);
  });

  test("a failed codex command says so; one with no start line still shows", () => {
    const lines = [
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { id: "a", type: "command_execution", command: "cat nope", aggregated_output: "No such file", exit_code: 1, status: "failed" } },
      { type: "item.started", item: { id: "b", type: "mcp_tool_call", server: "s", tool: "x" } },
    ].map((o, i) => ({ t_ms: i * 100, line: JSON.stringify(o) }));
    const run = baseRun({ family: "codex", output: lines, first_token_ms: null, outcome: "cancelled" });
    const view = buildRunView(run, 0);
    const tools = view.steps.filter((s) => s.body.kind === "tool").map((s) => s.body);
    expect(tools).toEqual([
      { kind: "tool", name: "Shell", input: "cat nope", calledAtMs: 100, result: "No such file\n(exit code 1, failed)", resultAtMs: 100 },
      { kind: "tool", name: "mcp_tool_call", input: JSON.stringify({ id: "b", type: "mcp_tool_call", server: "s", tool: "x" }), calledAtMs: 200, result: null, resultAtMs: null },
    ]);
    expect(view.result?.stuck).toStartWith("Still running when it stopped: mcp_tool_call");
    expectEveryLineOnce(run);
  });

  test("plain-text output (agy) is kept as one Printed step", () => {
    const run = baseRun({ family: "agy", output: [{ t_ms: 50, line: "first" }, { t_ms: 60, line: "second" }] });
    const view = buildRunView(run, 0);
    expect(view.steps[1]?.body).toEqual({ kind: "text", text: "first\nsecond" });
    expectEveryLineOnce(run);
  });

  test("a start failure has no output and says why", () => {
    const run = baseRun({
      outcome: "failed",
      failure_reason: "spawn_failed",
      failure_message: 'could not start claude: Executable not found in $PATH: "claude"',
      total_ms: 1,
      tokens: null,
      model_reported: null,
      exit_code: null,
    });
    const view = buildRunView(run, 0);
    expect(view.steps.map((s) => s.label)).toEqual(["Sent", "Stopped"]);
    expect(view.result?.message).toBe('could not start claude: Executable not found in $PATH: "claude"');
    expect(view.modelNote).toBeNull();
  });

  test("an answer with no captured output says so instead of showing only Sent", () => {
    const view = buildRunView(baseRun({ output: [] }), 0);
    expect(view.steps.map((s) => s.label)).toEqual(["Sent", "No output captured"]);
  });

  test("a stopped call says the user stopped it", () => {
    const view = buildRunView(baseRun({ outcome: "cancelled", total_ms: 3000 }), 0);
    expect(view.runtime).toBe("3.0 s, then you stopped it");
    expect(view.result?.message).toBe("You stopped this call before it finished.");
  });

  test("source tags", () => {
    expect(buildRunView(baseRun({ source: "installed" }), 0).pick?.tag).toBe("only one installed");
    expect(buildRunView(baseRun({ source: "recent" }), 0).pick?.tag).toBe("last used");
    expect(buildRunView(baseRun({ source: null }), 0).pick).toBeNull();
  });

  test("a reported model that differs from the one asked for is named", () => {
    const view = buildRunView(baseRun({ model_requested: "claude-haiku-5-5", model_reported: "claude-sonnet-5-5" }), 0);
    expect(view.modelNote).toBe("Asked for claude-haiku-5-5, claude reported claude-sonnet-5-5.");
    expect(view.modelShort).toBe("sonnet 5.5");
  });
});

describe("whole prompt", () => {
  test("the system part is joined exactly as composeChatPrompt joins it; the two parts are labelled", () => {
    const parts = {
      page: "PAGE",
      userFacts: "FACTS",
      episodes: "",
      captureHonesty: "RULE",
      captureMarker: "",
      recall: "\n\nRECALL",
      transcript: "[user] hi",
    };
    const { systemPrompt, blocks, omitted } = composeChatPrompt(parts);
    const view = buildRunView(baseRun({ prompt_blocks: blocks, prompt_omitted: omitted }), 0);
    expect(view.wholePrompt).toBe(`--- system prompt ---\n${systemPrompt}\n\n--- message ---\n[user] hi`);
  });
});

test("shortModel", () => {
  expect(shortModel("claude-haiku-5-5")).toBe("haiku 5.5");
  expect(shortModel("claude-sonnet-4-5-20250929")).toBe("sonnet 4.5");
  expect(shortModel("gpt-5.3-codex")).toBe("gpt-5.3-codex");
  expect(shortModel(null)).toBe("model not reported");
});

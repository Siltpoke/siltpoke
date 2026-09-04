import { test, expect } from "bun:test";
import { makeClaudeProvider } from "../../src/brain/provider";

const valid = {
  mood: "happy",
  pose: "base",
  bubble_short: "looks good",
  bubble_long: "",
  critique_for_claude: "",
  severity: "info",
  confidence: "high",
  xp_earned_events: [],
};

function envelopeWithResult(resultText: string): string {
  return JSON.stringify([
    { type: "system", subtype: "init" },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: resultText,
      total_cost_usd: 0.001,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 50,
        output_tokens: 200,
      },
    },
  ]);
}

function fakeSpawn(capture: { argv?: string[] }): typeof Bun.spawn {
  return ((cmd: string[], _options: unknown) => {
    capture.argv = cmd;
    return {
      stdin: { write(_chunk: string) {}, end() {} },
      stdout: new Response(envelopeWithResult(JSON.stringify(valid))).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
}

test("claude provider meta matches spec §1", () => {
  const provider = makeClaudeProvider();
  expect(provider.meta).toEqual({
    name: "claude",
    billing: "usd",
    genAiSystem: "anthropic",
  });
});

test("claude provider argv is byte-identical to brain.ts's runBrainCall (brain.ts:118-129)", async () => {
  const capture: { argv?: string[] } = {};
  const provider = makeClaudeProvider();
  const { output } = await provider.call({
    systemPrompt: "test-system-prompt",
    contextBundle: "test-context",
    spawnFn: fakeSpawn(capture),
  });

  expect(capture.argv).toEqual([
    "claude",
    "-p",
    "--model",
    "claude-haiku-4-5",
    "--system-prompt",
    "test-system-prompt",
    "--output-format",
    "json",
    "--no-session-persistence",
  ]);
  expect(output.mood).toBe("happy");
});

test("claude provider honors a custom model, same argv shape", async () => {
  const capture: { argv?: string[] } = {};
  const provider = makeClaudeProvider();
  await provider.call({
    systemPrompt: "sp",
    contextBundle: "cb",
    model: "claude-sonnet-4-6",
    spawnFn: fakeSpawn(capture),
  });
  expect(capture.argv?.[3]).toBe("claude-sonnet-4-6");
});

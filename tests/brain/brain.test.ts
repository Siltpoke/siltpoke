import { test, expect } from "bun:test";
import { callBrain, BrainError } from "../../src/brain/brain";

function fakeSpawn(opts: {
  stdoutText: string;
  stderrText?: string;
  exitCode?: number;
}): typeof Bun.spawn {
  return ((_cmd: string[], _options: unknown) => ({
    stdin: {
      write(_chunk: string) {},
      end() {},
    },
    stdout: new Response(opts.stdoutText).body,
    stderr: new Response(opts.stderrText ?? "").body,
    exited: Promise.resolve(opts.exitCode ?? 0),
    kill() {},
  })) as unknown as typeof Bun.spawn;
}

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

function envelopeWithResult(
  resultText: string,
  isError = false,
  usage: Record<string, number> = {},
): string {
  return JSON.stringify([
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "text", text: resultText }] } },
    {
      type: "result",
      subtype: isError ? "error" : "success",
      is_error: isError,
      result: resultText,
      total_cost_usd: 0.001,
      usage: {
        cache_creation_input_tokens: 72000,
        cache_read_input_tokens: 0,
        input_tokens: 50,
        output_tokens: 200,
        ...usage,
      },
    },
  ]);
}

test("happy path: parses event stream, finds result event, JSON-parses, validates", async () => {
  const env = envelopeWithResult(JSON.stringify(valid));
  const { output } = await callBrain({
    systemPrompt: "test",
    contextBundle: "test",
    spawnFn: fakeSpawn({ stdoutText: env }),
  });
  expect(output.mood).toBe("happy");
});

test("returns usage with cache metrics from result event", async () => {
  const env = envelopeWithResult(JSON.stringify(valid), false, {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 65000,
  });
  const { usage } = await callBrain({
    systemPrompt: "x",
    contextBundle: "x",
    spawnFn: fakeSpawn({ stdoutText: env }),
  });
  expect(usage.cache_creation_input_tokens).toBe(0);
  expect(usage.cache_read_input_tokens).toBe(65000);
  expect(usage.total_cost_usd).toBe(0.001);
});

test("usage defaults to zeros when result event lacks usage field", async () => {
  const env = JSON.stringify([
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify(valid),
    },
  ]);
  const { usage } = await callBrain({
    systemPrompt: "x",
    contextBundle: "x",
    spawnFn: fakeSpawn({ stdoutText: env }),
  });
  expect(usage.cache_creation_input_tokens).toBe(0);
  expect(usage.cache_read_input_tokens).toBe(0);
  expect(usage.total_cost_usd).toBeNull();
});

test("happy path: strips markdown code fence around inner JSON", async () => {
  const fenced = `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``;
  const env = envelopeWithResult(fenced);
  const { output } = await callBrain({
    systemPrompt: "x",
    contextBundle: "x",
    spawnFn: fakeSpawn({ stdoutText: env }),
  });
  expect(output.mood).toBe("happy");
});

test("non-zero exit code throws BrainError", async () => {
  await expect(
    callBrain({
      systemPrompt: "x",
      contextBundle: "x",
      spawnFn: fakeSpawn({ stdoutText: "", stderrText: "boom", exitCode: 1 }),
    }),
  ).rejects.toBeInstanceOf(BrainError);
});

test("invalid envelope JSON throws BrainError", async () => {
  await expect(
    callBrain({
      systemPrompt: "x",
      contextBundle: "x",
      spawnFn: fakeSpawn({ stdoutText: "not json" }),
    }),
  ).rejects.toBeInstanceOf(BrainError);
});

test("envelope not an array throws BrainError", async () => {
  await expect(
    callBrain({
      systemPrompt: "x",
      contextBundle: "x",
      spawnFn: fakeSpawn({ stdoutText: JSON.stringify({ result: "x" }) }),
    }),
  ).rejects.toBeInstanceOf(BrainError);
});

test("missing result event throws BrainError", async () => {
  const env = JSON.stringify([{ type: "system" }, { type: "assistant" }]);
  await expect(
    callBrain({
      systemPrompt: "x",
      contextBundle: "x",
      spawnFn: fakeSpawn({ stdoutText: env }),
    }),
  ).rejects.toBeInstanceOf(BrainError);
});

test("result event with is_error=true throws BrainError", async () => {
  const env = envelopeWithResult("rate limit", true);
  await expect(
    callBrain({
      systemPrompt: "x",
      contextBundle: "x",
      spawnFn: fakeSpawn({ stdoutText: env }),
    }),
  ).rejects.toBeInstanceOf(BrainError);
});

test("inner result is not JSON throws BrainError", async () => {
  const env = envelopeWithResult("this is not json at all");
  await expect(
    callBrain({
      systemPrompt: "x",
      contextBundle: "x",
      spawnFn: fakeSpawn({ stdoutText: env }),
    }),
  ).rejects.toBeInstanceOf(BrainError);
});

test("inner result fails schema validation throws BrainError", async () => {
  const env = envelopeWithResult(JSON.stringify({ ...valid, mood: "rage" }));
  await expect(
    callBrain({
      systemPrompt: "x",
      contextBundle: "x",
      spawnFn: fakeSpawn({ stdoutText: env }),
    }),
  ).rejects.toBeInstanceOf(BrainError);
});

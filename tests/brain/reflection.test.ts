import { test, expect } from "bun:test";
import {
  callReflection,
  reflectionSystemPrompt,
  buildContextBundle,
  REFLECTION_SYSTEM_PROMPT,
} from "../../src/brain/reflection";
import { BrainError } from "../../src/brain/brain";

// --- mode-aware reflection (dismiss vs acted_on) ---

test("reflectionSystemPrompt defaults to dismiss framing (unchanged)", () => {
  expect(reflectionSystemPrompt()).toBe(REFLECTION_SYSTEM_PROMPT);
  expect(reflectionSystemPrompt("dismiss")).toBe(REFLECTION_SYSTEM_PROMPT);
});

test("acted_on system prompt is reinforcement-framed, not dismiss/mistake-framed", () => {
  const p = reflectionSystemPrompt("acted_on");
  const lower = p.toLowerCase();
  expect(p).not.toBe(REFLECTION_SYSTEM_PROMPT);
  // must NOT carry the dismiss FRAMING that inverts acted-on rules — target the
  // dismiss prompt's actual framing phrases, not a bare "dismissed" token (the
  // acted-on prompt legitimately names "dismissed critiques" in a DON'T-do-that
  // contrast clause).
  expect(lower).not.toContain("just dismissed");
  expect(lower).not.toContain("reflect on the mistake");
  expect(lower).not.toContain("it was wrong");
  // must carry the acted-on / reinforcement framing
  expect(lower).toContain("acted on");
  expect(lower).toContain("correct");
  expect(lower).toContain("reinforces");
});

test("buildContextBundle tags the reason by mode", () => {
  const dismiss = buildContextBundle({ critiqueBody: "c", userReason: "r" });
  expect(dismiss).toContain("<user_dismiss_reason>");
  expect(dismiss).not.toContain("<user_acted_on_reason>");

  const acted = buildContextBundle({ critiqueBody: "c", userReason: "r", mode: "acted_on" });
  expect(acted).toContain("<user_acted_on_reason>");
  expect(acted).not.toContain("<user_dismiss_reason>");
});

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

const validReflection = {
  reflection:
    "I flagged a missing null check on queries.py:47, but the line already guards against None upstream.",
  learned_rule:
    "Before flagging NULL handling, grep for existing null/None guards in the same file.",
  rule_category: "null_check",
  confidence: "high",
  applies_to_file_types: ["py"],
};

function envelopeWithResult(
  resultText: string,
  isError = false,
  usage: Record<string, number> = {},
): string {
  return JSON.stringify([
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: resultText }] },
    },
    {
      type: "result",
      subtype: isError ? "error" : "success",
      is_error: isError,
      result: resultText,
      total_cost_usd: 0.0002,
      usage: {
        cache_creation_input_tokens: 800,
        cache_read_input_tokens: 0,
        input_tokens: 30,
        output_tokens: 60,
        ...usage,
      },
    },
  ]);
}

test("happy path: parses event stream and validates reflection JSON", async () => {
  const env = envelopeWithResult(JSON.stringify(validReflection));
  const { output, usage } = await callReflection({
    critiqueBody: "queries.py:47 missing null check",
    userReason: "already null-checked",
    spawnFn: fakeSpawn({ stdoutText: env }),
  });
  expect(output.rule_category).toBe("null_check");
  expect(output.confidence).toBe("high");
  expect(usage.cache_creation_input_tokens).toBe(800);
  expect(usage.total_cost_usd).toBe(0.0002);
});

test("happy path: strips markdown code fence around inner JSON", async () => {
  const fenced = `\`\`\`json\n${JSON.stringify(validReflection)}\n\`\`\``;
  const env = envelopeWithResult(fenced);
  const { output } = await callReflection({
    critiqueBody: "x",
    userReason: "y",
    spawnFn: fakeSpawn({ stdoutText: env }),
  });
  expect(output.rule_category).toBe("null_check");
});

test("non-zero exit code throws BrainError", async () => {
  await expect(
    callReflection({
      critiqueBody: "x",
      userReason: "y",
      spawnFn: fakeSpawn({
        stdoutText: "",
        stderrText: "boom",
        exitCode: 1,
      }),
    }),
  ).rejects.toBeInstanceOf(BrainError);
});

test("missing result event throws BrainError", async () => {
  const env = JSON.stringify([{ type: "system" }, { type: "assistant" }]);
  await expect(
    callReflection({
      critiqueBody: "x",
      userReason: "y",
      spawnFn: fakeSpawn({ stdoutText: env }),
    }),
  ).rejects.toBeInstanceOf(BrainError);
});

test("result event with is_error=true throws BrainError", async () => {
  const env = envelopeWithResult("rate limit", true);
  await expect(
    callReflection({
      critiqueBody: "x",
      userReason: "y",
      spawnFn: fakeSpawn({ stdoutText: env }),
    }),
  ).rejects.toBeInstanceOf(BrainError);
});

test("inner result fails schema validation throws BrainError", async () => {
  const env = envelopeWithResult(
    JSON.stringify({ ...validReflection, confidence: "extreme" }),
  );
  await expect(
    callReflection({
      critiqueBody: "x",
      userReason: "y",
      spawnFn: fakeSpawn({ stdoutText: env }),
    }),
  ).rejects.toBeInstanceOf(BrainError);
});

test("inner result is not JSON throws BrainError", async () => {
  const env = envelopeWithResult("this is not json at all");
  await expect(
    callReflection({
      critiqueBody: "x",
      userReason: "y",
      spawnFn: fakeSpawn({ stdoutText: env }),
    }),
  ).rejects.toBeInstanceOf(BrainError);
});

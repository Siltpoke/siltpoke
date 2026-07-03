import { describe, expect, test } from "bun:test";
import type { BrainCallRawResult, CallBrainOptions } from "../../../src/brain/brain";
import { DEFAULT_GRADER_MODEL, makeSemanticGrader, parseAboutPlanted } from "../../../src/eval/caller-impact/grader";

function rawResult(output: unknown): BrainCallRawResult {
  return {
    output,
    usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 0, output_tokens: 0, total_cost_usd: 0 },
  };
}

const planted = { file: "src/b.ts", function: "callerFn", line: 42 };
const finding = { file: "src/b.ts", line: 42 };

describe("parseAboutPlanted — conservative", () => {
  test("explicit true → true", () => {
    expect(parseAboutPlanted({ aboutPlanted: true })).toBe(true);
  });
  test("false / missing / malformed → false", () => {
    expect(parseAboutPlanted({ aboutPlanted: false })).toBe(false);
    expect(parseAboutPlanted({})).toBe(false);
    expect(parseAboutPlanted("yes")).toBe(false);
    expect(parseAboutPlanted({ aboutPlanted: "true" })).toBe(false);
  });
});

describe("makeSemanticGrader", () => {
  test("returns the model's verdict", async () => {
    const grader = makeSemanticGrader({ call: async () => rawResult({ aboutPlanted: true }) });
    expect(await grader({ planted, finding, arm: "grep-sigdelta" })).toEqual({ aboutPlanted: true });
  });

  test("is BLIND — the arm label never reaches the prompt", async () => {
    let seen = "";
    const grader = makeSemanticGrader({
      call: async (opts: CallBrainOptions) => {
        seen = `${opts.systemPrompt}\n${opts.contextBundle}`;
        return rawResult({ aboutPlanted: false });
      },
    });
    await grader({ planted, finding, arm: "graph-sigdelta" });
    expect(seen).not.toContain("graph-sigdelta");
    expect(seen).not.toContain("arm");
  });

  test("uses a different tier than the arm Brain (Haiku) by default", async () => {
    let model = "";
    const grader = makeSemanticGrader({
      call: async (opts: CallBrainOptions) => {
        model = opts.model ?? "";
        return rawResult({ aboutPlanted: true });
      },
    });
    await grader({ planted, finding, arm: "baseline" });
    expect(model).toBe(DEFAULT_GRADER_MODEL);
    expect(model).not.toContain("haiku");
  });

  test("grader call failure → conservative false (never manufactures a confirmation)", async () => {
    const grader = makeSemanticGrader({
      call: async () => {
        throw new Error("boom");
      },
    });
    expect(await grader({ planted, finding, arm: "baseline" })).toEqual({ aboutPlanted: false });
  });
});

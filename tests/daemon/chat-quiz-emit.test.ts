import { describe, it, expect } from "bun:test";
import { generateValidatedVerbalization } from "../../src/daemon/routes/chat-quiz-emit";

function fakeStream(text: string, usage = { input_tokens: 1, output_tokens: 1 }) {
  return async function* () {
    yield { type: "message_start", message_id: "m", model: "t" };
    yield { type: "content_block_delta", text };
    yield { type: "message_stop", usage, full_text: text };
  } as any;
}

describe("generateValidatedVerbalization", () => {
  it("passes clean prose through", async () => {
    const out = await generateValidatedVerbalization({
      streamFactory: fakeStream("The map has it the other way: A depends on B.", { input_tokens: 10, output_tokens: 5 }),
      baseOpts: { transcript: [], systemPrompt: "sp" } as any,
      verdict: "contradict", fallback: "FB",
    });
    expect(out.usedFallback).toBe(false);
    // Single call (no retry needed) — usage is exactly that one call's real
    // usage, never a synthetic zero (review round 1, cost-honesty fix).
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("caving prose after contradict → retries then falls back, usage SUMS both real Brain calls", async () => {
    let n = 0;
    const streamFactory = ((opts: any) => {
      n++;
      // Distinct usage per call so a sum (not a last-write-wins overwrite)
      // is the only way the assertion below passes.
      return fakeStream("Your intuition is basically right, both are true!", { input_tokens: 20, output_tokens: 8 })();
    }) as any;
    const out = await generateValidatedVerbalization({
      streamFactory, baseOpts: { transcript: [], systemPrompt: "sp" } as any,
      verdict: "contradict", fallback: "REAL-DIRECTION-FALLBACK",
    });
    expect(n).toBe(2);                      // one retry
    expect(out.usedFallback).toBe(true);
    expect(out.text).toBe("REAL-DIRECTION-FALLBACK");
    // Two real Brain calls were made (initial + retry) even though the
    // FALLBACK text is what's shown — both must be ledgered, so usage is
    // the sum: 20+20 input, 8+8 output. A caller that ledgers 0/0 here
    // (or only the last call) would silently under-report real spend.
    expect(out.usage).toEqual({ input_tokens: 40, output_tokens: 16 });
  });
});

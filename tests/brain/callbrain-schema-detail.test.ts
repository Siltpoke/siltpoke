import { describe, test, expect } from "bun:test";
import { describeSchemaIssues, brainOutputSchema } from "../../src/brain/schema";
import { callBrain } from "../../src/brain/brain";


// #647 made a schema failure say WHICH field failed — but only on one of the two
// paths that can raise one. `parse-raw.ts` appends the detail;
// `brain.ts:callBrain` throws a bare "Brain response failed schema validation"
// and drops the ZodError's paths on the floor.
//
// That is not hypothetical. The paid A/B on 2026-08-25 hit it three times, and
// its log carries exactly the bare string — undiagnosable, on a run that cost
// money. Same shape as the defect this repo keeps finding: a defence that exists
// in one place, and a sibling path that never got it.
//
// The detail is PATHS AND CODES ONLY — never zod's own `message`, which
// interpolates the received value and would put reviewed source into a log line
// the span input is deliberately redacted to keep out.
describe("describeSchemaIssues is reachable by both throw sites", () => {
  function issuesFor(input: unknown): string {
    try {
      brainOutputSchema.parse(input);
    } catch (err) {
      return describeSchemaIssues(err);
    }
    throw new Error("expected the schema to reject this input");
  }

  const valid = {
    mood: "happy",
    pose: "base",
    bubble_short: "ok",
    bubble_long: "",
    critique_for_claude: "",
    severity: "info",
    confidence: "medium",
    xp_earned_events: [],
  };

  test("it is exported — brain.ts cannot use what it cannot import", () => {
    expect(typeof describeSchemaIssues).toBe("function");
  });

  test("a bad enum names its own field", () => {
    const detail = issuesFor({ ...valid, severity: "catastrophic" });
    expect(detail).toContain("severity");
  });

  test("a #655 field names itself too", () => {
    const detail = issuesFor({ ...valid, category: "vibes" });
    expect(detail).toContain("category");
  });

  test("it stays path:code — the received value never reaches the message", () => {
    const secret = "SUPER_SECRET_SOURCE_LINE";
    const detail = issuesFor({ ...valid, severity: secret });
    expect(detail).toContain("severity");
    expect(detail).not.toContain(secret);
  });

  test("a non-zod error yields no detail rather than throwing", () => {
    expect(describeSchemaIssues(new Error("not a zod error"))).toBe("");
    expect(describeSchemaIssues(null)).toBe("");
  });
});

// The mutation check that mattered: reverting brain.ts to the bare message left
// every test above GREEN, because they only exercise the helper. A fix nothing
// covers is the shape this repo keeps finding — so this drives the real
// `callBrain` path through its spawn seam and reads the message it actually
// throws.
describe("callBrain's own schema failure carries the detail", () => {
  function fakeSpawn(stdoutText: string): typeof Bun.spawn {
    return ((_cmd: string[], _options: unknown) => ({
      stdin: { write(_c: string) {}, end() {} },
      stdout: new Response(stdoutText).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    })) as unknown as typeof Bun.spawn;
  }

  function envelope(resultText: string): string {
    return JSON.stringify([
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success", is_error: false, result: resultText },
    ]);
  }

  async function messageFrom(payload: Record<string, unknown>): Promise<string> {
    try {
      await callBrain({
        systemPrompt: "x",
        contextBundle: "x",
        spawnFn: fakeSpawn(envelope(JSON.stringify(payload))),
      });
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("expected callBrain to reject this payload");
  }

  const valid = {
    mood: "happy", pose: "base", bubble_short: "ok", bubble_long: "",
    critique_for_claude: "", severity: "info", confidence: "high", xp_earned_events: [],
  };

  test("it still starts with the generic prefix audit-absence classifies on", async () => {
    const msg = await messageFrom({ ...valid, severity: "catastrophic" });
    expect(msg).toContain("Brain response failed schema validation");
  });

  test("and it now names the failing field", async () => {
    const msg = await messageFrom({ ...valid, severity: "catastrophic" });
    expect(msg).toContain("severity");
  });

  test("a missing required field is named too", async () => {
    // `severity`, not `mood`: a missing cosmetic field is now filled by the
    // shape repair rather than rejected, so it would no longer produce the
    // failure this test is about. `severity` is a judgement and still rejects.
    const { severity: _dropped, ...withoutSeverity } = valid;
    const msg = await messageFrom(withoutSeverity);
    expect(msg).toContain("severity");
  });

  test("the received value never reaches the message", async () => {
    const secret = "SUPER_SECRET_SOURCE_LINE";
    const msg = await messageFrom({ ...valid, severity: secret });
    expect(msg).toContain("severity");
    expect(msg).not.toContain(secret);
  });
});

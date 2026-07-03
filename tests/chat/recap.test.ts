import { describe, expect, test } from "bun:test";
import { recapSession } from "../../src/chat/recap";

const deps = (brain: any) => ({
  homeBase: "/tmp",
  sessionId: "s1",
  callBrainText: brain,
  ledger: async () => {},
});
const msgs = [
  { role: "user", content: "我在看什么页面?" },
  { role: "assistant", content: "Memory Book 页 — 记忆一览。" },
];
const textBrain = (text: string) => async () => ({
  text,
  usage: { input_tokens: 1, output_tokens: 1 },
});

describe("recapSession", () => {
  test("returns the plain-text recap sentence", async () => {
    expect(await recapSession(msgs, deps(textBrain("聊了 Memory Book 页在讲什么。")))).toBe(
      "聊了 Memory Book 页在讲什么。",
    );
  });
  test("empty messages → '' (no call)", async () => {
    let called = false;
    const brain = async () => {
      called = true;
      return { text: "x", usage: {} } as any;
    };
    expect(await recapSession([], deps(brain))).toBe("");
    expect(called).toBe(false);
  });
  test("brain throw → '' (never throws)", async () => {
    const brain = async () => {
      throw new Error("timeout");
    };
    expect(await recapSession(msgs, deps(brain))).toBe("");
  });

  // Sanitizer robustness — the model drifts into these shapes even when asked
  // for plain prose; recapSession must recover a clean one-liner from each.
  test("strips a stray {\"recap\":\"...\"} JSON envelope", async () => {
    expect(
      await recapSession(msgs, deps(textBrain('{"recap":"问了当前在哪个页面"}'))),
    ).toBe("问了当前在哪个页面");
  });
  test("strips a markdown code fence", async () => {
    expect(
      await recapSession(msgs, deps(textBrain("```\n问了当前在哪个页面\n```"))),
    ).toBe("问了当前在哪个页面");
  });
  test("strips wrapping quotes", async () => {
    expect(await recapSession(msgs, deps(textBrain('"问了当前在哪个页面"')))).toBe(
      "问了当前在哪个页面",
    );
  });
  test("truncates to ≤120 chars", async () => {
    const long = "话".repeat(200);
    expect((await recapSession(msgs, deps(textBrain(long)))).length).toBe(120);
  });
  test("blank text → ''", async () => {
    expect(await recapSession(msgs, deps(textBrain("   ")))).toBe("");
  });
});

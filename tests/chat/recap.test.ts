import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// ---------------------------------------------------------------------------
// Default seam is role-routed (single-brain S2, task 12) — recapSession no
// longer defaults `deps.callBrainText` to the imported `callBrainText`
// (always claude, model pinned via the deleted RECAP_MODEL constant); it
// defaults to `makeRoleTextBrain(deps.homeBase, "chat")`. Same rationale as
// tag-entities.test.ts's twin block: mocking the shared `role-brain` module
// was verified to leak across test files with no working restore (bun
// `mock.module` limitation), so this exercises the REAL chain end-to-end via
// a `config.json` selecting "qoder" for the chat role + a throwaway
// `qodercli` executable on PATH.
// ---------------------------------------------------------------------------

describe("recapSession default seam (role-routed)", () => {
  test("no deps.callBrainText + homeBase config selecting qoder → real qoder path is exercised", async () => {
    const home = mkdtempSync(join(tmpdir(), "recap-role-home-"));
    const bin = mkdtempSync(join(tmpdir(), "recap-role-bin-"));
    const originalPath = process.env.PATH;
    try {
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ brain: { roles: { chat: { provider: "qoder" } } } }),
      );
      const fakeBin = join(bin, "qodercli");
      writeFileSync(
        fakeBin,
        [
          "#!/usr/bin/env bun",
          'const inner = "聊了 Memory Book 页在讲什么。";',
          'const envelope = { type: "result", subtype: "success", is_error: false, result: inner, total_cost_usd: 0, usage: { input_tokens: 5, output_tokens: 3 } };',
          "process.stdout.write(JSON.stringify(envelope));",
          "",
        ].join("\n"),
      );
      chmodSync(fakeBin, 0o755);
      process.env.PATH = `${bin}:${originalPath ?? ""}`;

      const out = await recapSession(msgs, {
        homeBase: home,
        sessionId: "s1",
        ledger: async () => {},
      });

      expect(out).toBe("聊了 Memory Book 页在讲什么。");
    } finally {
      process.env.PATH = originalPath;
      rmSync(home, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

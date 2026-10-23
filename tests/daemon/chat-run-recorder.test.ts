// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// One chat call → one stored record (spec 2026-10-13 §10.2), whatever happened
// to the call, and never at the cost of the call itself.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localRunStore } from "../../src/chat/run-store";
import { startChatRun } from "../../src/daemon/routes/chat-run-recorder";

type RunEnd = Parameters<ReturnType<typeof startChatRun>["finish"]>[0];

let home = "";
let clock = 0;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "run-recorder-"));
  clock = 1_000;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Init = Parameters<typeof startChatRun>[0];
function base(over: Partial<Init> = {}): Init {
  return {
    store: localRunStore(home),
    sessionId: "s-abc",
    family: "claude",
    source: "chosen",
    modelRequested: "claude-haiku-4-5-20251001",
    billing: "usd",
    command: ["claude", "-p"],
    blocks: [{ name: "conversation", chars: 9, text: "[user] hi" }],
    omitted: ["page context"],
    now: () => clock,
    ...over,
  };
}

const okEnd = (messageId: string, over: Partial<RunEnd> = {}): RunEnd => ({
  messageId,
  outcome: "ok",
  failureReason: null,
  failureMessage: null,
  usage: { input_tokens: 7, output_tokens: 3 },
  ...over,
});

const claudeLines = (JSON.parse(readFileSync("tests/fixtures/claude-envelope/verbose-on.json", "utf8")) as unknown[]).map(
  (e) => JSON.stringify(e),
);

async function* events(evs: Array<{ type: string }>, tick = 0): AsyncGenerator<{ type: string }> {
  for (const ev of evs) {
    clock += tick;
    yield ev;
  }
}

test("a claude call: model, version, tools, tokens and cost come from what claude printed", async () => {
  const rec = startChatRun(base());
  for (const l of claudeLines) rec.onRawLine(l);
  rec.onExit(0);
  clock += 1919;
  const r = await rec.finish(okEnd("m-1"));
  expect(r.recorded).toBe(true);
  const [run] = await localRunStore(home).read("s-abc");
  expect(run).toMatchObject({
    run_id: r.runId,
    message_id: "m-1",
    family: "claude",
    source: "chosen",
    model_requested: "claude-haiku-4-5-20251001",
    model_reported: "claude-haiku-4-5-20251001",
    cli_version: "2.1.274",
    tokens: { input: 9, output: 67, cache_read: 34951, cache_write: 0, thinking: 61 },
    exit_code: 0,
    total_ms: 1919,
    outcome: "ok",
    prompt_omitted: ["page context"],
  });
  expect(run.cost).toEqual({ kind: "usd", usd: 0.0038391000000000007 });
  expect(run.permitted_tools?.length).toBe(160);
  expect(run.output.length).toBe(claudeLines.length);
});

test("another agent: reported model is null (it does not say), cost is plan quota, version comes from its CLI", async () => {
  const rec = startChatRun(base({ family: "qoder", source: "recent", modelRequested: null, billing: "quota", versionOf: async (b) => `${b} 1.3.0` }));
  rec.onSpawn(["qodercli", "-p", "--output-format", "json"]);
  rec.onRawLine('{"type":"result","result":"hi"}');
  rec.onExit(0);
  await rec.finish(okEnd("m-1"));
  const [run] = await localRunStore(home).read("s-abc");
  expect(run).toMatchObject({
    family: "qoder",
    model_requested: null,
    model_reported: null,
    cost: { kind: "quota" },
    cli_version: "qodercli 1.3.0",
    command: ["qodercli", "-p", "--output-format", "json"],
    tokens: { input: 7, output: 3, cache_read: null, cache_write: null, thinking: null },
    permitted_tools: null,
  });
});

test("the version is asked when the agent starts, not when the record is written", async () => {
  const asked: string[] = [];
  const rec = startChatRun(base({ family: "codex", billing: "quota", versionOf: async (b) => {
    asked.push(b);
    return "codex 1";
  } }));
  rec.onSpawn(["codex", "exec"]);
  expect(asked).toEqual(["codex"]);
  await rec.finish(okEnd("m-1"));
  expect(asked).toEqual(["codex"]);
  expect((await localRunStore(home).read("s-abc"))[0]?.cli_version).toBe("codex 1");
});

test("a stopped call keeps the output that arrived before the stop", async () => {
  const rec = startChatRun(base());
  rec.onRawLine(claudeLines[0] as string);
  const r = await rec.finish(okEnd("m-1", { outcome: "cancelled", usage: null }));
  expect(r.recorded).toBe(true);
  const [run] = await localRunStore(home).read("s-abc");
  expect(run.outcome).toBe("cancelled");
  expect(run.output.length).toBe(1);
  expect(run.tokens).toBeNull();
  expect(run.model_reported).toBe("claude-haiku-4-5-20251001");
});

test("output past the cap is cut and marked", async () => {
  const rec = startChatRun(base({ family: "qoder", billing: "quota" }));
  const big = "x".repeat(64 * 1024);
  for (let i = 0; i < 40; i++) rec.onRawLine(big); // 2.5 MB
  await rec.finish(okEnd("m-1"));
  const [run] = await localRunStore(home).read("s-abc");
  expect(run.output_truncated).toBe(true);
  expect(run.output.reduce((n, o) => n + o.line.length, 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(run.output.length).toBe(32);
});

test("a second finish writes nothing and returns the first result", async () => {
  const rec = startChatRun(base());
  const a = await rec.finish(okEnd("m-1"));
  const b = await rec.finish(okEnd("m-2", { outcome: "failed" }));
  expect(b).toEqual(a);
  expect((await localRunStore(home).read("s-abc")).length).toBe(1);
});

test("a failed write is reported, not thrown", async () => {
  writeFileSync(join(home, "chat-runs"), "x");
  const logged: string[] = [];
  const r = await startChatRun(base({ logError: (m) => logged.push(m) })).finish(okEnd("m-1"));
  expect(r.recorded).toBe(false);
  expect(logged.length).toBe(1);
});

test("first-token time is kept for claude only", async () => {
  const deltas = [{ type: "message_start" }, { type: "content_block_delta" }, { type: "content_block_delta" }];
  const claude = startChatRun(base());
  for await (const _ of claude.wrap(events(deltas, 100))) {
    // drain
  }
  await claude.finish(okEnd("m-1"));
  const qoder = startChatRun(base({ sessionId: "s-def", family: "qoder", billing: "quota" }));
  for await (const _ of qoder.wrap(events(deltas, 100))) {
    // drain
  }
  await qoder.finish(okEnd("m-2"));
  expect((await localRunStore(home).read("s-abc"))[0]?.first_token_ms).toBe(200);
  expect((await localRunStore(home).read("s-def"))[0]?.first_token_ms).toBeNull();
});

test("no agent decided: the record still says what happened", async () => {
  const rec = startChatRun(base({ family: null, source: null, modelRequested: null, billing: null, command: [] }));
  await rec.finish(okEnd("m-1", { outcome: "failed", failureReason: "choose_provider", failureMessage: "x".repeat(400), usage: null }));
  const [run] = await localRunStore(home).read("s-abc");
  expect(run).toMatchObject({ family: null, outcome: "failed", failure_reason: "choose_provider", cost: null, tokens: null });
  expect(run.failure_message?.length).toBe(300);
});

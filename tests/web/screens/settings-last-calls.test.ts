// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// What the Settings page says happened last (spec 2026-10-13 AC7–AC11): read
// from records of calls that ran — chat call records and brain-calls.jsonl —
// never from the current setting.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatRun, localRunStore } from "../../../src/chat/run-store";
import { lastCalls } from "../../../src/web/screens/settings-last-calls";

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "settings-last-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function run(over: Partial<ChatRun>): ChatRun {
  return {
    v: 1, run_id: "r-1", session_id: "s-a", message_id: "m-1", started_at: "2026-10-14T19:58:00.000Z",
    total_ms: 1, first_token_ms: null, family: "claude", source: "chosen",
    model_requested: "claude-haiku-4-5", model_reported: "claude-haiku-4-5", outcome: "ok",
    failure_reason: null, failure_message: null, tokens: null, cost: null, command: [], cli_version: null,
    exit_code: 0, permitted_tools: null, prompt_blocks: [], prompt_omitted: [], output: [], output_truncated: false,
    ...over,
  };
}

const fired = (ts: string, provider: string, model?: string) => ({
  timestamp: ts, session_id: "aaa111", cwd: "/x", critique_id: `c-${ts}`, provider,
  ...(model ? { model } : {}),
  brain_output: { bubble_short: "looks fine", severity: "low" },
});
const skipped = (ts: string, provider: string) => ({
  // The real shape: `skipped` carries the reason as a string (critic-event-log-parse.ts).
  timestamp: ts, session_id: "aaa111", cwd: "/x", provider, skipped: "dedupe",
});
const brainCalls = (rows: unknown[]) =>
  writeFileSync(join(home, "brain-calls.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

test("nothing recorded anywhere: both null, no throw", async () => {
  expect(await lastCalls(home, localRunStore(home))).toEqual({ chat: null, review: null });
});

test("chat: the newest record of the newest conversation, with the model it reported", async () => {
  const store = localRunStore(home);
  await store.append(run({ session_id: "s-old", started_at: "2026-10-14T10:00:00.000Z", family: "qoder", model_reported: null }));
  await store.append(run({ session_id: "s-new", run_id: "r-a", started_at: "2026-10-14T19:57:00.000Z" }));
  await store.append(run({ session_id: "s-new", run_id: "r-b", started_at: "2026-10-14T19:58:00.000Z", family: "agy", model_reported: null, model_requested: "gemini-3.8-flash-low" }));
  const old = new Date("2026-10-14T10:00:00Z");
  utimesSync(join(home, "chat-runs", "s-old.jsonl"), old, old);
  expect((await lastCalls(home, store)).chat).toEqual({
    family: "agy", model: null, requested: "gemini-3.8-flash-low", at: "2026-10-14T19:58:00.000Z", outcome: "ok",
  });
});

test("chat: the reported model wins over the requested one; requested is not shown as if reported", async () => {
  const store = localRunStore(home);
  await store.append(run({ model_requested: "claude-haiku-4-5", model_reported: "claude-haiku-4-5-20251001" }));
  expect((await lastCalls(home, store)).chat?.model).toBe("claude-haiku-4-5-20251001");
});

test("review: the newest review that ran, skipping a newer skipped one", async () => {
  brainCalls([fired("2026-10-14T19:40:00Z", "qoder"), skipped("2026-10-14T19:45:00Z", "qoder")]);
  expect((await lastCalls(home, localRunStore(home))).review).toEqual({
    family: "qoder", model: null, requested: null, at: "2026-10-14T19:40:00Z", outcome: "ok",
  });
});

test("review: a model on the row is passed through", async () => {
  brainCalls([fired("2026-10-14T19:40:00Z", "claude", "claude-haiku-4-5")]);
  expect((await lastCalls(home, localRunStore(home))).review?.model).toBe("claude-haiku-4-5");
});

// Found in the final review: a "choose an agent" reply writes a record with no
// agent. Reading it as "nothing recorded" told a user who had chatted for weeks
// that no answer was ever recorded.
test("chat: a newest record with no agent decided is reported as that, not as nothing", async () => {
  const store = localRunStore(home);
  await store.append(run({ run_id: "r-a", started_at: "2026-10-14T19:50:00.000Z" }));
  await store.append(
    run({ run_id: "r-b", started_at: "2026-10-14T19:58:00.000Z", family: null, model_reported: null, outcome: "failed" }),
  );
  expect((await lastCalls(home, store)).chat).toEqual({
    family: null, model: null, requested: "claude-haiku-4-5", at: "2026-10-14T19:58:00.000Z", outcome: "failed",
  });
});

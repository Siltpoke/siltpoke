// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Chat call records (spec 2026-10-13-agent-in-use-truth §10.2): one file per
// conversation under the siltpoke home, never brain-calls.jsonl.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatRun, localRunStore } from "../../src/chat/run-store";

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "run-store-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function run(over: Partial<ChatRun> = {}): ChatRun {
  return {
    v: 1,
    run_id: "r-1",
    session_id: "s-abc",
    message_id: "m-1",
    started_at: "2026-10-14T20:31:07.000Z",
    total_ms: 1919,
    first_token_ms: null,
    family: "claude",
    source: "chosen",
    model_requested: "claude-haiku-4-5-20251001",
    model_reported: null,
    outcome: "ok",
    failure_reason: null,
    failure_message: null,
    tokens: { input: 9, output: 67, cache_read: null, cache_write: null, thinking: null },
    cost: { kind: "usd", usd: 0.0038 },
    command: ["claude", "-p"],
    cli_version: null,
    exit_code: 0,
    permitted_tools: null,
    prompt_blocks: [{ name: "conversation", chars: 9, text: "[user] hi" }],
    prompt_omitted: [],
    output: [],
    output_truncated: false,
    ...over,
  };
}

test("append then read returns records oldest first", async () => {
  await localRunStore(home).append(run({ run_id: "r-1" }));
  await localRunStore(home).append(run({ run_id: "r-2" }));
  expect((await localRunStore(home).read("s-abc")).map((r) => r.run_id)).toEqual(["r-1", "r-2"]);
});

test("read of a conversation with no file is an empty list, not an error", async () => {
  expect(await localRunStore(home).read("s-none")).toEqual([]);
});

test("a corrupt line is skipped, the good ones survive", async () => {
  await localRunStore(home).append(run({ run_id: "r-1" }));
  appendFileSync(join(home, "chat-runs", "s-abc.jsonl"), "{not json\n");
  await localRunStore(home).append(run({ run_id: "r-2" }));
  expect((await localRunStore(home).read("s-abc")).map((r) => r.run_id)).toEqual(["r-1", "r-2"]);
});

test("append throws when chat-runs is a file — the caller decides what that means", async () => {
  writeFileSync(join(home, "chat-runs"), "x");
  await expect(localRunStore(home).append(run())).rejects.toThrow();
});

test("delete removes only that conversation", async () => {
  await localRunStore(home).append(run({ session_id: "s-abc" }));
  await localRunStore(home).append(run({ session_id: "s-def" }));
  await localRunStore(home).delete("s-abc");
  expect(await localRunStore(home).read("s-abc")).toEqual([]);
  expect((await localRunStore(home).read("s-def")).length).toBe(1);
});

test("prune deletes files untouched for more than 30 days and keeps the rest", async () => {
  await localRunStore(home).append(run({ session_id: "s-old" }));
  await localRunStore(home).append(run({ session_id: "s-new" }));
  const now = new Date("2026-10-14T00:00:00Z");
  const old = new Date(now.getTime() - 31 * 86_400_000);
  utimesSync(join(home, "chat-runs", "s-old.jsonl"), old, old);
  const fresh = new Date(now.getTime() - 29 * 86_400_000);
  utimesSync(join(home, "chat-runs", "s-new.jsonl"), fresh, fresh);
  expect(await localRunStore(home).prune(now)).toBe(1);
  expect(existsSync(join(home, "chat-runs", "s-old.jsonl"))).toBe(false);
  expect(existsSync(join(home, "chat-runs", "s-new.jsonl"))).toBe(true);
});

test("prune with no folder deletes nothing and does not throw", async () => {
  expect(await localRunStore(home).prune(new Date())).toBe(0);
});

test("read refuses a session id that would leave the folder", async () => {
  mkdirSync(join(home, "chat-runs"), { recursive: true });
  await expect(localRunStore(home).read("../config")).rejects.toThrow();
});

test("the store writes where a second store over the same home reads", async () => {
  const store = localRunStore(home);
  await store.append(run({ run_id: "r-9" }));
  expect((await localRunStore(home).read("s-abc")).map((r) => r.run_id)).toEqual(["r-9"]);
  expect((await store.read("s-abc")).map((r) => r.run_id)).toEqual(["r-9"]);
  await store.delete("s-abc");
  expect(await localRunStore(home).read("s-abc")).toEqual([]);
});

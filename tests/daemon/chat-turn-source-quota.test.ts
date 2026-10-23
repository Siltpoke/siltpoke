// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openChatTurn } from "../../src/daemon/routes/chat-turn-source";
import type { StreamChatOptions, StreamEvent } from "../../src/daemon/routes/chat-stream";
import { readBrainHealth } from "../../src/state/brain-health";

// Spec §12.3: claude chat is counted in the `chat` bucket and refused at the
// cap like every other agent. Before this, the claude chat path never went
// through the cap at all.

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "chat-turn-quota-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function collect(stream: AsyncGenerator<StreamEvent, void, void>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

function claudeTurn(onStart: () => void) {
  return openChatTurn({
    homeBase: home,
    resolution: { kind: "use", family: "claude", source: "chosen" },
    transcript: "hi",
    signal: new AbortController().signal,
    streamFactory: (_opts: StreamChatOptions) =>
      (async function* () {
        onStart();
        yield { type: "message_stop", usage: { input_tokens: 0, output_tokens: 0 }, full_text: "ok" } as StreamEvent;
      })(),
  });
}

describe("claude chat takes from the chat daily cap", () => {
  test("each claude chat turn counts under chat", async () => {
    await collect(claudeTurn(() => {}).stream);
    await collect(claudeTurn(() => {}).stream);
    expect(readBrainHealth(home).quota_calls_today.chat?.count).toBe(2);
  });

  test("at the cap: one quota_cap error event and claude is never started", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ brain: { chat_quota_daily_cap: 1 } }));
    let started = 0;
    await collect(claudeTurn(() => started++).stream);
    const events = await collect(claudeTurn(() => started++).stream);
    expect(started).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", reason: "quota_cap", provider: "claude" });
  });

  test("cap 0 = no cap", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ brain: { chat_quota_daily_cap: 0 } }));
    let started = 0;
    for (let i = 0; i < 5; i++) await collect(claudeTurn(() => started++).stream);
    expect(started).toBe(5);
  });
});

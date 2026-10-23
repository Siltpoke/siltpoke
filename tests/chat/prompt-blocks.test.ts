// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The chat prompt as named blocks (spec 2026-10-13 §10.1 "Sent"). The join must
// stay byte-identical to the inline expression chat.ts used before.
import { expect, test } from "bun:test";
import { composeChatPrompt } from "../../src/chat/prompt-blocks";

type Parts = { page: string; userFacts: string; episodes: string; captureHonesty: string; captureMarker: string; recall: string };

/** The old expression from chat.ts, copied verbatim — the control. */
function legacy(p: Parts): string | undefined {
  return ([p.page, p.userFacts, p.episodes, p.captureHonesty, p.captureMarker].filter(Boolean).join("\n\n") + p.recall) || undefined;
}

const KEYS = ["page", "userFacts", "episodes", "captureHonesty", "captureMarker", "recall"] as const;

test("systemPrompt is byte-identical to the old join for all 64 empty/non-empty combinations", () => {
  for (let mask = 0; mask < 64; mask++) {
    const parts = Object.fromEntries(KEYS.map((k, i) => [k, mask & (1 << i) ? `<${k}>` : ""])) as Parts;
    expect(composeChatPrompt({ ...parts, transcript: "[user] hi" }).systemPrompt).toBe(legacy(parts));
  }
});

test("blocks list the non-empty parts in send order, conversation last, with char counts", () => {
  const r = composeChatPrompt({ page: "PAGE", userFacts: "", episodes: "EP", captureHonesty: "", captureMarker: "", recall: "", transcript: "[user] hi" });
  expect(r.blocks.map((b) => b.name)).toEqual(["page context", "past episodes", "conversation"]);
  expect(r.blocks[0]).toEqual({ name: "page context", chars: 4, text: "PAGE" });
  expect(r.omitted).toEqual(["what siltpoke knows about you", "memory-save rule", "memory-save marker", "related past chats"]);
});

test("the joining blank lines are not counted as any block", () => {
  const r = composeChatPrompt({ page: "A", userFacts: "B", episodes: "", captureHonesty: "", captureMarker: "", recall: "", transcript: "T" });
  const sum = r.blocks.filter((b) => b.name !== "conversation").reduce((n, b) => n + b.chars, 0);
  expect(sum).toBe(2);
  expect(r.systemPrompt).toBe("A\n\nB");
});

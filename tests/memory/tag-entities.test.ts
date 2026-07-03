import { describe, expect, test } from "bun:test";
import { tagUntaggedEntities } from "../../src/memory/tag-entities";
import { emptyMemory } from "../../src/memory/memory";
import type { callBrainRaw as callBrainRawType } from "../../src/brain/brain";

function memWith(facts: any[]) {
  return { ...emptyMemory(), facts };
}
const base = {
  id: "f1", text: "likes cats", source_session_id: null, confidence: 1, status: "active",
  created_at: "t", last_seen_at: "t", supersedes: null, superseded_by: null, pinned: false,
  recall_count: 0, retired_reason: null, stability: "durable",
  learned_from: { stream: "chat", session_id: null }, kind: null, last_confirmed_at: "t",
  expires_at: null, save_reason: null, invalid_at: null, events: [],
};
const noopLedger = async () => {};

describe("tagUntaggedEntities", () => {
  test("tags an untagged active fact from the batched Haiku call", async () => {
    const callBrainRaw = async () => ({
      output: { tags: [{ id: "f1", entities: [{ name: "cats", type: "thing" }] }] },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const out = await tagUntaggedEntities(memWith([{ ...base }]), {
      homeBase: "/tmp",
      callBrainRaw: callBrainRaw as unknown as typeof callBrainRawType,
      ledger: noopLedger,
    });
    expect(out.facts[0]!.entities).toEqual([{ name: "cats", type: "thing" }]);
  });

  test("no untagged facts → no call, memory unchanged (idempotent)", async () => {
    let called = false;
    const callBrainRaw = async () => { called = true; return { output: {}, usage: {} } as any; };
    const mem = memWith([{ ...base, entities: [{ name: "cats" }] }]);
    const out = await tagUntaggedEntities(mem, { homeBase: "/tmp", callBrainRaw, ledger: noopLedger });
    expect(called).toBe(false);
    expect(out).toBe(mem);
  });

  test("malformed response leaves facts untagged (no crash)", async () => {
    const callBrainRaw = async () => ({ output: { nope: 1 }, usage: {} }) as any;
    const out = await tagUntaggedEntities(memWith([{ ...base }]), {
      homeBase: "/tmp",
      callBrainRaw: callBrainRaw as unknown as typeof callBrainRawType,
      ledger: noopLedger,
    });
    expect(out.facts[0]!.entities).toBeUndefined();
  });
});

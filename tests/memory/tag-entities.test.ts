import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { callBrainRaw as callBrainRawType } from "../../src/brain/brain";
import { emptyMemory } from "../../src/memory/memory";
import { tagUntaggedEntities } from "../../src/memory/tag-entities";

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

// ---------------------------------------------------------------------------
// Default seam is role-routed (single-brain S2, task 6) — tagUntaggedEntities
// no longer defaults `deps.callBrainRaw` to the imported `callBrainRaw`
// (always claude, model pinned via the deleted TAG_MODEL constant); it
// defaults to `makeRoleRawBrain(deps.homeBase, "extract")`. Same rationale as
// extract-facts.test.ts's twin block: mocking the shared `role-brain` module
// was verified to leak across test files with no working restore (bun
// `mock.module` limitation), so this exercises the REAL chain end-to-end via
// a `config.json` selecting "qoder" for the extract role + a throwaway
// `qodercli` executable on PATH.
// ---------------------------------------------------------------------------

describe("tagUntaggedEntities default seam (role-routed)", () => {
  test("no deps.callBrainRaw + homeBase config selecting qoder → real qoder path is exercised", async () => {
    const home = mkdtempSync(join(tmpdir(), "tag-entities-role-home-"));
    const bin = mkdtempSync(join(tmpdir(), "tag-entities-role-bin-"));
    const originalPath = process.env.PATH;
    try {
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ brain: { roles: { extract: { provider: "qoder" } } } }),
      );
      const fakeBin = join(bin, "qodercli");
      writeFileSync(
        fakeBin,
        [
          "#!/usr/bin/env bun",
          'const inner = JSON.stringify({ tags: [{ id: "f1", entities: [{ name: "cats", type: "thing" }] }] });',
          'const envelope = { type: "result", subtype: "success", is_error: false, result: inner, total_cost_usd: 0, usage: { input_tokens: 5, output_tokens: 3 } };',
          "process.stdout.write(JSON.stringify(envelope));",
          "",
        ].join("\n"),
      );
      chmodSync(fakeBin, 0o755);
      process.env.PATH = `${bin}:${originalPath ?? ""}`;

      const out = await tagUntaggedEntities(memWith([{ ...base }]), {
        homeBase: home,
        ledger: noopLedger,
      });

      expect(out.facts[0]!.entities).toEqual([{ name: "cats", type: "thing" }]);
    } finally {
      process.env.PATH = originalPath;
      rmSync(home, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFactKinds } from "../../src/memory/ensure-fact-kinds";
import { emptyMemory, readMemory, writeMemory } from "../../src/memory/memory";
import type { Fact } from "../../src/memory/memory";

let home: string;

function fact(over: Partial<Fact>): Fact {
  return {
    id: "f-1",
    text: "x",
    source_session_id: null,
    confidence: 0.9,
    status: "active",
    created_at: "2026-06-29T00:00:00.000Z",
    last_seen_at: "2026-06-29T00:00:00.000Z",
    supersedes: null,
    superseded_by: null,
    pinned: false,
    recall_count: 0,
    retired_reason: null,
    stability: "durable",
    learned_from: null,
    last_confirmed_at: null,
    expires_at: null,
    save_reason: null,
    invalid_at: null,
    events: [],
    kind: null,
    ...over,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-ensure-kind-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("ensureFactKinds", () => {
  it("tags untagged facts on disk + persists (returns true)", async () => {
    await writeMemory(home, {
      ...emptyMemory(),
      facts: [
        fact({ id: "zh", text: "the user prefers responses in Chinese", kind: null }),
        fact({ id: "dan", text: "User's boyfriend is Daniel", kind: null }),
      ],
    });
    const wrote = await ensureFactKinds(home);
    expect(wrote).toBe(true);
    const after = await readMemory(home);
    expect(after?.facts.find((f) => f.id === "zh")?.kind).toBe("style");
    expect(after?.facts.find((f) => f.id === "dan")?.kind).toBe("profile");
  });

  it("is idempotent — a fully-tagged store is left untouched (returns false)", async () => {
    await writeMemory(home, {
      ...emptyMemory(),
      facts: [fact({ id: "zh", text: "prefers Chinese", kind: "style" })],
    });
    expect(await ensureFactKinds(home)).toBe(false);
    expect(await ensureFactKinds(home)).toBe(false);
  });

  it("no store → returns false, no throw", async () => {
    // fresh home, nothing written
    expect(await ensureFactKinds(join(home, "nope"))).toBe(false);
  });
});

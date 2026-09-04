/**
 * global.facts partition/merge tests (Leg B core — T1).
 *
 * User-level facts (kind "style" | "profile") route to the cwd-independent
 * global store so they survive across repos and under launchd (daemon cwd=/).
 * Untagged (null/undefined kind) facts stay in the per-project slice.
 *
 * These use the explicit `projectCwd` override on readMemory/writeMemory
 * (proven in compat-shim.test.ts) rather than chdir, so a write in one repo
 * and a read from a *different* repo prove global routing survives a cwd change.
 */
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readMemory,
  writeMemory,
  emptyMemory,
  isGlobalFact,
  type CoreMemory,
  type Fact,
} from "../../src/memory/memory";
import {
  readGlobal,
  writeGlobal,
  emptyGlobal,
} from "../../src/memory/global";
import {
  writeProject,
  emptyProject,
  resolveProjectRoot,
} from "../../src/memory/project";

let home: string;
let repoX: string;
let repoY: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-gfacts-home-"));
  repoX = mkdtempSync(join(tmpdir(), "siltpoke-gfacts-repoX-"));
  repoY = mkdtempSync(join(tmpdir(), "siltpoke-gfacts-repoY-"));
  mkdirSync(join(repoX, ".git"));
  mkdirSync(join(repoY, ".git"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoX, { recursive: true, force: true });
  rmSync(repoY, { recursive: true, force: true });
});

function makeFact(overrides: Partial<Fact>): Fact {
  return {
    id: "f-1",
    text: "a fact",
    source_session_id: null,
    confidence: 0.9,
    status: "active",
    created_at: "2026-07-08T00:00:00Z",
    last_seen_at: "2026-07-08T00:00:00Z",
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
    ...overrides,
  };
}

describe("global.facts partition on write / merge on read", () => {
  test("a style fact written in repo X still appears when read from repo Y (global routing survives cwd change)", async () => {
    await writeGlobal(home, emptyGlobal());
    const mem: CoreMemory = {
      ...emptyMemory(),
      facts: [makeFact({ id: "f-style", text: "喜欢中文", kind: "style" })],
    };
    await writeMemory(home, mem, repoX);

    // A DIFFERENT repo — proves the fact is not stranded in repo X's slice.
    const backY = await readMemory(home, repoY);
    expect(backY!.facts.map((f) => f.id)).toContain("f-style");

    // And it physically landed in the global store, not the project slice.
    const g = await readGlobal(home);
    expect(g!.facts.map((f) => f.id)).toContain("f-style");
  });

  test("a null-kind (untagged) fact stays in the project slice and does NOT appear from another repo", async () => {
    await writeGlobal(home, emptyGlobal());
    const mem: CoreMemory = {
      ...emptyMemory(),
      facts: [makeFact({ id: "f-untagged", text: "project-scoped", kind: null })],
    };
    await writeMemory(home, mem, repoX);

    const backX = await readMemory(home, repoX);
    expect(backX!.facts.map((f) => f.id)).toContain("f-untagged");

    const backY = await readMemory(home, repoY);
    expect(backY!.facts.map((f) => f.id)).not.toContain("f-untagged");

    // Global store must NOT have swallowed the untagged fact.
    const g = await readGlobal(home);
    expect(g!.facts.map((f) => f.id)).not.toContain("f-untagged");
  });

  test("a profile fact routes to global (same as style)", async () => {
    await writeGlobal(home, emptyGlobal());
    const mem: CoreMemory = {
      ...emptyMemory(),
      facts: [makeFact({ id: "f-profile", text: "has a cat named tofu", kind: "profile" })],
    };
    await writeMemory(home, mem, repoX);

    const backY = await readMemory(home, repoY);
    expect(backY!.facts.map((f) => f.id)).toContain("f-profile");

    const g = await readGlobal(home);
    expect(g!.facts.map((f) => f.id)).toContain("f-profile");
  });

  test("reading an OLD global.json without a facts field yields facts:[] (zod default coercion, no throw)", async () => {
    // Hand-crafted pre-existing global.json missing the new `facts` field.
    const legacyGlobal = {
      schemaVersion: 3,
      appearance: { head: "cat", face: "neutral", legs: "default" },
      daily_caps_state: { local_date: "2026-07-08", per_source_counts: {} },
    };
    writeFileSync(join(home, "global.json"), JSON.stringify(legacyGlobal));

    // readGlobal itself must not throw and must coerce facts -> [].
    const g = await readGlobal(home);
    expect(g).not.toBeNull();
    expect(g!.facts).toEqual([]);

    // The merged read path is likewise unaffected.
    const merged = await readMemory(home, repoX);
    expect(merged!.facts).toEqual([]);
  });

  test("a fact present in BOTH global and project (same id) appears only once after merge (dedupe, global wins)", async () => {
    const dupInGlobal = makeFact({ id: "f-dup", text: "global copy", kind: "style" });
    const g = emptyGlobal();
    g.facts = [dupInGlobal];
    await writeGlobal(home, g);

    const resolvedX = resolveProjectRoot(repoX);
    const p = emptyProject(resolvedX);
    // Same id, different text — mid-upgrade a not-yet-swept project copy.
    p.facts = [makeFact({ id: "f-dup", text: "stale project copy", kind: "style" })];
    await writeProject(home, resolvedX.project_id, p);

    const merged = await readMemory(home, repoX);
    const dupHits = merged!.facts.filter((f) => f.id === "f-dup");
    expect(dupHits).toHaveLength(1);
    // Global wins the collision (concat order [...global, ...project], first-seen kept).
    expect(dupHits[0]!.text).toBe("global copy");
  });

  test("isGlobalFact is the exact boundary: style+profile true, null/undefined false", () => {
    expect(isGlobalFact(makeFact({ kind: "style" }))).toBe(true);
    expect(isGlobalFact(makeFact({ kind: "profile" }))).toBe(true);
    expect(isGlobalFact(makeFact({ kind: null }))).toBe(false);
    expect(isGlobalFact(makeFact({ kind: undefined }))).toBe(false);
  });

  test("read-merge-write round-trip preserves a pre-existing global fact of a DIFFERENT id (documents the full-replace contract)", async () => {
    // Pre-seed global with fact B.
    const g = emptyGlobal();
    g.facts = [makeFact({ id: "f-B", text: "existing global fact", kind: "profile" })];
    await writeGlobal(home, g);

    // A normal read-modify-write from repo X: read merged, add fact A, write back.
    const mem = await readMemory(home, repoX);
    mem!.facts.push(makeFact({ id: "f-A", text: "new style fact", kind: "style" }));
    await writeMemory(home, mem!, repoX);

    // Both survive — the wholesale global replace did NOT wipe f-B because the
    // merged read folded it into memory.facts before write.
    const after = await readGlobal(home);
    const ids = after!.facts.map((f) => f.id);
    expect(ids).toContain("f-A");
    expect(ids).toContain("f-B");
  });
});

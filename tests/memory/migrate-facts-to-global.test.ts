import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateFactsToGlobal } from "../../src/memory/migrate-facts-to-global";
import type { Fact } from "../../src/memory/memory";
import { readGlobal, writeGlobal, emptyGlobal } from "../../src/memory/global";
import {
  readProject,
  writeProject,
  emptyProject,
  resolveProjectRoot,
} from "../../src/memory/project";

let home: string;
let repoX: string;
let repoY: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-migrate-home-"));
  repoX = mkdtempSync(join(tmpdir(), "siltpoke-migrate-repoX-"));
  repoY = mkdtempSync(join(tmpdir(), "siltpoke-migrate-repoY-"));
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

/** Seed a project slice for `repoRoot` with the given facts. */
async function seedProject(repoRoot: string, facts: Fact[]): Promise<string> {
  const resolved = resolveProjectRoot(repoRoot);
  const p = emptyProject(resolved);
  p.facts = facts;
  await writeProject(home, resolved.project_id, p);
  return resolved.project_id;
}

describe("migrateFactsToGlobal", () => {
  it("relocates style+profile facts from every project slice into global (deduped); slices keep only null-kind facts", async () => {
    await writeGlobal(home, emptyGlobal());

    const idX = await seedProject(repoX, [
      makeFact({ id: "x-style", text: "喜欢中文", kind: "style" }),
      makeFact({ id: "x-profile", text: "has a cat named tofu", kind: "profile" }),
      makeFact({ id: "x-null", text: "project-scoped X", kind: null }),
    ]);
    const idY = await seedProject(repoY, [
      makeFact({ id: "y-style", text: "prefers terse replies", kind: "style" }),
      makeFact({ id: "y-null", text: "project-scoped Y", kind: null }),
    ]);

    const wrote = await migrateFactsToGlobal(home);
    expect(wrote).toBe(true);

    // Global gained all three user-level facts.
    const g = await readGlobal(home);
    const gIds = g!.facts.map((f) => f.id).sort();
    expect(gIds).toEqual(["x-profile", "x-style", "y-style"]);

    // Each project slice keeps ONLY its null-kind fact.
    const px = await readProject(home, idX);
    expect(px!.facts.map((f) => f.id)).toEqual(["x-null"]);
    const py = await readProject(home, idY);
    expect(py!.facts.map((f) => f.id)).toEqual(["y-null"]);
  });

  it("is idempotent — running twice changes nothing (second run makes no writes, no dupes)", async () => {
    await writeGlobal(home, emptyGlobal());
    await seedProject(repoX, [
      makeFact({ id: "x-style", text: "喜欢中文", kind: "style" }),
      makeFact({ id: "x-null", text: "project-scoped X", kind: null }),
    ]);

    expect(await migrateFactsToGlobal(home)).toBe(true);
    const afterFirst = await readGlobal(home);
    const firstIds = afterFirst!.facts.map((f) => f.id);

    // Second run: nothing left stranded → no-op (returns false), global unchanged.
    expect(await migrateFactsToGlobal(home)).toBe(false);
    const afterSecond = await readGlobal(home);
    expect(afterSecond!.facts.map((f) => f.id)).toEqual(firstIds);
    // No duplicates introduced.
    expect(new Set(firstIds).size).toBe(firstIds.length);
    expect(firstIds).toEqual(["x-style"]);
  });

  it("a style fact already in global with the same id stranded in a project → appears once in global, removed from project", async () => {
    const g = emptyGlobal();
    g.facts = [makeFact({ id: "f-dup", text: "global copy", kind: "style" })];
    await writeGlobal(home, g);

    const idX = await seedProject(repoX, [
      makeFact({ id: "f-dup", text: "stale project copy", kind: "style" }),
      makeFact({ id: "x-null", text: "project-scoped X", kind: null }),
    ]);

    expect(await migrateFactsToGlobal(home)).toBe(true);

    const after = await readGlobal(home);
    const hits = after!.facts.filter((f) => f.id === "f-dup");
    expect(hits).toHaveLength(1);
    // Global wins the id collision — keeps its own copy.
    expect(hits[0]!.text).toBe("global copy");

    // The stranded copy is pruned from the project slice.
    const px = await readProject(home, idX);
    expect(px!.facts.map((f) => f.id)).toEqual(["x-null"]);
  });

  it("empty/missing projects dir → no-op, no throw, global unchanged", async () => {
    await writeGlobal(home, emptyGlobal());
    const before = await readGlobal(home);

    // No projects/ dir exists at all.
    expect(await migrateFactsToGlobal(home)).toBe(false);

    const after = await readGlobal(home);
    expect(after!.facts).toEqual(before!.facts);
    expect(after!.facts).toEqual([]);
  });

  it("a slice holding ONLY null-kind facts is left untouched (write-only-if-changed at slice granularity)", async () => {
    await writeGlobal(home, emptyGlobal());
    // repoY has a global fact (forces the sweep to run + write); repoX is clean.
    const idX = await seedProject(repoX, [
      makeFact({ id: "x-null-1", text: "clean A", kind: null }),
      makeFact({ id: "x-null-2", text: "clean B", kind: null }),
    ]);
    await seedProject(repoY, [
      makeFact({ id: "y-style", text: "喜欢中文", kind: "style" }),
    ]);

    const before = await readProject(home, idX);
    expect(await migrateFactsToGlobal(home)).toBe(true);

    // The clean slice's facts are unchanged (not needlessly rewritten/reordered).
    const after = await readProject(home, idX);
    expect(after!.facts.map((f) => f.id)).toEqual(before!.facts.map((f) => f.id));
    expect(after!.facts.map((f) => f.id)).toEqual(["x-null-1", "x-null-2"]);
  });

  it("fresh install with NO global.json → sweep creates it and lands the stranded facts", async () => {
    // No writeGlobal seeding — global.json does not exist yet.
    await seedProject(repoX, [
      makeFact({ id: "x-style", text: "喜欢中文", kind: "style" }),
      makeFact({ id: "x-null", text: "project-scoped", kind: null }),
    ]);

    expect(await migrateFactsToGlobal(home)).toBe(true);

    const g = await readGlobal(home);
    expect(g).not.toBeNull();
    expect(g!.facts.map((f) => f.id)).toEqual(["x-style"]);
  });
});

/**
 * GLOBAL_ONLY memory-scope tests (Leg A — T3, daemon launchd env-hardening).
 *
 * The machine-global daemon (cwd=`/` under launchd) has no correct project cwd.
 * A request with no project signal must read/write the cwd-independent GLOBAL
 * store via the `GLOBAL_ONLY` sentinel — never resolve `process.cwd()` (which
 * hashes to an empty `/`-slice → the 0-facts bug).
 *
 * Three-way `projectCwd` meaning proven here:
 *   - GLOBAL_ONLY   → global store only, no project slice (AC1/AC2 + risk #5).
 *   - "<path>" str  → that project (AC3).
 *   - undefined     → process.cwd() (regression: CLI + Stop-hook unchanged, risk #3).
 */
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readMemory,
  writeMemory,
  emptyMemory,
  GLOBAL_ONLY,
  type CoreMemory,
  type Fact,
} from "../../src/memory/memory";
import { readGlobal, writeGlobal, emptyGlobal } from "../../src/memory/global";
import {
  readProject,
  writeProject,
  emptyProject,
  resolveProjectRoot,
} from "../../src/memory/project";

let home: string;
let repoX: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-gonly-home-"));
  repoX = mkdtempSync(join(tmpdir(), "siltpoke-gonly-repoX-"));
  mkdirSync(join(repoX, ".git"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoX, { recursive: true, force: true });
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

describe("readMemory(base, GLOBAL_ONLY)", () => {
  test("AC1/AC2 — returns the GLOBAL facts, never a project slice's", async () => {
    // Global store carries the user's real (style) fact.
    const g = emptyGlobal();
    g.facts = [makeFact({ id: "f-global", text: "喜欢中文", kind: "style" })];
    await writeGlobal(home, g);

    // Seed a DIFFERENT project slice with its own untagged fact — the thing a
    // cwd-based read (process.cwd()) would (wrongly) surface, or miss entirely.
    const resolvedX = resolveProjectRoot(repoX);
    const p = emptyProject(resolvedX);
    p.facts = [makeFact({ id: "f-proj", text: "project-only", kind: null })];
    await writeProject(home, resolvedX.project_id, p);

    const mem = await readMemory(home, GLOBAL_ONLY);
    expect(mem).not.toBeNull();
    const ids = mem!.facts.map((f) => f.id);
    expect(ids).toContain("f-global");
    // No project slice was merged — the project fact must NOT appear.
    expect(ids).not.toContain("f-proj");
  });

  test("risk #5 — project-scoped fields come back empty (no `/` slice leak)", async () => {
    const g = emptyGlobal();
    g.facts = [makeFact({ id: "f-global", kind: "profile" })];
    await writeGlobal(home, g);

    // A project slice loaded with episodic/rule data that must NOT leak.
    const resolvedX = resolveProjectRoot(repoX);
    const p = emptyProject(resolvedX);
    p.learned_rules = [
      {
        id: "r-1",
        rule: "always lint",
        category: "style",
        created_at: "2026-07-08T00:00:00Z",
        applied_count: 0,
        effectiveness: "neutral",
      },
    ];
    p.chat_sessions = [
      {
        id: "s-1",
        started_at: "2026-07-08T00:00:00Z",
        ended_at: null,
        message_count: 1,
        summary: "hi",
        summary_generated_at: null,
        tags: [],
        anchor: null,
      },
    ];
    await writeProject(home, resolvedX.project_id, p);

    const mem = await readMemory(home, GLOBAL_ONLY);
    expect(mem!.learned_rules).toEqual([]);
    expect(mem!.chat_sessions).toEqual([]);
    expect(mem!.episodes).toEqual([]);
    expect(mem!.event_fragments).toEqual([]);
    // But the global user identity survives.
    expect(mem!.facts.map((f) => f.id)).toContain("f-global");
  });
});

describe("writeMemory(base, mem, GLOBAL_ONLY)", () => {
  test("does NOT create or wipe a project slice; global gets the new fact", async () => {
    await writeGlobal(home, emptyGlobal());

    // Pre-existing project slice with a fact on disk.
    const resolvedX = resolveProjectRoot(repoX);
    const seeded = emptyProject(resolvedX);
    seeded.facts = [makeFact({ id: "f-proj", text: "keep me", kind: null })];
    seeded.long_term_summary = "project summary";
    await writeProject(home, resolvedX.project_id, seeded);

    // A GLOBAL_ONLY write carrying a new global (style) fact.
    const mem: CoreMemory = {
      ...emptyMemory(),
      facts: [makeFact({ id: "f-new-global", text: "prefers terse", kind: "style" })],
    };
    await writeMemory(home, mem, GLOBAL_ONLY);

    // Project slice on disk is byte-for-fact unchanged (writeProject never ran).
    const afterProj = await readProject(home, resolvedX.project_id);
    expect(afterProj!.facts.map((f) => f.id)).toEqual(["f-proj"]);
    expect(afterProj!.long_term_summary).toBe("project summary");

    // Global gained the new fact.
    const afterGlobal = await readGlobal(home);
    expect(afterGlobal!.facts.map((f) => f.id)).toContain("f-new-global");
  });

  test("born-null facts are CLASSIFIED and persisted to global under GLOBAL_ONLY (not dropped)", async () => {
    // Regression for the T3 data-loss the review caught: facts are born kind:null
    // (addFactCore / captureChatFactCore), and the un-anchored write path used
    // to `.filter(isGlobalFact)` them away → the fresh `记住 喜欢中文` vanished.
    await writeGlobal(home, emptyGlobal());
    const mem: CoreMemory = {
      ...emptyMemory(),
      facts: [
        makeFact({ id: "f-lang", text: "我喜欢你跟我说中文", kind: null }),
        makeFact({ id: "f-dog", text: "has a dog named Momo", kind: null }),
      ],
    };
    await writeMemory(home, mem, GLOBAL_ONLY);

    const g = await readGlobal(home);
    const byId = new Map(g!.facts.map((f) => [f.id, f]));
    // Both survive — nothing dropped.
    expect(byId.has("f-lang")).toBe(true);
    expect(byId.has("f-dog")).toBe(true);
    // And they are typed by classifyFactKind: language pref → style, personal → profile.
    expect(byId.get("f-lang")!.kind).toBe("style");
    expect(byId.get("f-dog")!.kind).toBe("profile");
    // No project slice was created (GLOBAL_ONLY never calls writeProject).
    const resolvedX = resolveProjectRoot(repoX);
    expect(await readProject(home, resolvedX.project_id)).toBeNull();
  });

  test("end-to-end: a freshly captured born-null fact reads back from the global store under GLOBAL_ONLY", async () => {
    // Simulate the un-anchored `记住 X` path: read (GLOBAL_ONLY) → append a
    // born-null fact → write (GLOBAL_ONLY) → read back. Proves the round-trip the
    // spy-based route tests could not: the fact actually persists + resurfaces.
    await writeGlobal(home, emptyGlobal());

    const before = await readMemory(home, GLOBAL_ONLY);
    before!.facts.push(makeFact({ id: "f-remember", text: "call me by my name Vic", kind: null }));
    await writeMemory(home, before!, GLOBAL_ONLY);

    const after = await readMemory(home, GLOBAL_ONLY);
    expect(after!.facts.map((f) => f.id)).toContain("f-remember");
  });
});

describe("real-path + undefined scopes (unchanged behavior)", () => {
  test("AC3 — a real path string resolves THAT project's slice", async () => {
    await writeGlobal(home, emptyGlobal());
    const resolvedX = resolveProjectRoot(repoX);
    const p = emptyProject(resolvedX);
    p.facts = [makeFact({ id: "f-proj", text: "anchored-repo fact", kind: null })];
    await writeProject(home, resolvedX.project_id, p);

    const mem = await readMemory(home, repoX);
    expect(mem!.facts.map((f) => f.id)).toContain("f-proj");
  });

  test("regression risk #3 — undefined resolves via process.cwd() (CLI / Stop-hook path)", async () => {
    await writeGlobal(home, emptyGlobal());
    // undefined must behave identically to explicitly passing process.cwd().
    // Both resolve the SAME project, so a global fact written under one is
    // visible under the other — proving undefined ⇒ process.cwd() (not GLOBAL_ONLY).
    const mem: CoreMemory = {
      ...emptyMemory(),
      facts: [makeFact({ id: "f-cwd", kind: "style" })],
    };
    await writeMemory(home, mem, undefined);

    const viaUndefined = await readMemory(home, undefined);
    const viaExplicitCwd = await readMemory(home, process.cwd());
    expect(viaUndefined!.facts.map((f) => f.id)).toEqual(
      viaExplicitCwd!.facts.map((f) => f.id),
    );
    // And it is NOT the GLOBAL_ONLY path — the merged read folds in the
    // process.cwd() project slice's fields (learned_rules array is present,
    // even if empty, from the real project read, not the GLOBAL_ONLY shortcut).
    expect(viaUndefined!.facts.map((f) => f.id)).toContain("f-cwd");
  });
});

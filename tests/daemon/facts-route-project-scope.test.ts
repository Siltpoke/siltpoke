/**
 * Facts-API project-scope resolution (memory-actions 404 fix).
 *
 * The Memory Book merges global + resolved-project facts on READ (memory.tsx),
 * but the action endpoints previously hardcoded GLOBAL_ONLY — so an untagged
 * fact living in a project slice was shown yet 404'd on approve/reject/retire/
 * kind. These tests prove the action path now resolves the SAME scope the read
 * path does (from the `?repo=` the client already sends) and threads it into
 * both read and write.
 *
 * See an internal design note
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountFactsRoutes } from "../../src/daemon/routes/facts";
import {
  GLOBAL_ONLY,
  readMemory,
  writeMemory,
  type CoreMemory,
  type Fact,
  type ProjectScope,
} from "../../src/memory/memory";
import { readGlobal, writeGlobal, emptyGlobal } from "../../src/memory/global";

const SECRET = "good";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-facts-pscope-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

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

function storedWith(facts: Fact[]): CoreMemory {
  return {
    schemaVersion: 2,
    long_term_summary: "",
    learned_rules: [],
    personality_drift: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0 },
    last_consolidated_at: "2026-07-08T00:00:00Z",
    consolidation_due_at: "2026-07-08T00:00:00Z",
    user_profile: { communication_style: "neutral", goals: [], constraints: [], prefs: {} },
    chat_sessions: [],
    facts,
    event_fragments: [],
    episodes: [],
  };
}

describe("facts API resolves the project scope from ?repo (not hardcoded GLOBAL_ONLY)", () => {
  test("threads the RESOLVED project_root into read AND write when ?repo maps to a real project", async () => {
    const PROJECT_ROOT = "/tmp/some-repo";
    const scopes: (ProjectScope | undefined)[] = [];
    const repoSeen: (string | undefined)[] = [];
    const app = new Hono();
    mountFactsRoutes(app, {
      homeBase: home,
      secret: SECRET,
      readMemory: async (_h, scope) => {
        scopes.push(scope);
        return storedWith([makeFact({ id: "f-p", status: "pending", kind: null })]);
      },
      writeMemory: async (_h, _m, scope) => {
        scopes.push(scope);
      },
      resolveProject: async (_h, repo) => {
        repoSeen.push(repo);
        return {
          project_id: null,
          proj_hash: repo ?? null,
          project_root: PROJECT_ROOT,
          display_name: null,
          source: "explicit" as const,
        };
      },
    });

    const res = await app.request("/api/facts/f-p/approve?repo=abc123", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);

    // The `?repo=` the client sends reaches the resolver.
    expect(repoSeen).toContain("abc123");
    // Every read/write uses the RESOLVED project root — NOT GLOBAL_ONLY.
    expect(scopes.length).toBeGreaterThan(0);
    for (const s of scopes) expect(s).toBe(PROJECT_ROOT);
  });

  test("falls back to GLOBAL_ONLY when the resolver yields no project_root (no ?repo)", async () => {
    const scopes: (ProjectScope | undefined)[] = [];
    const app = new Hono();
    mountFactsRoutes(app, {
      homeBase: home,
      secret: SECRET,
      readMemory: async (_h, scope) => {
        scopes.push(scope);
        return storedWith([makeFact({ id: "f-g", status: "pending", kind: "style" })]);
      },
      writeMemory: async (_h, _m, scope) => {
        scopes.push(scope);
      },
      resolveProject: async () => ({
        project_id: null,
        proj_hash: null,
        project_root: null,
        display_name: null,
        source: "none" as const,
      }),
    });

    const res = await app.request("/api/facts/f-g/approve", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    expect(scopes.length).toBeGreaterThan(0);
    for (const s of scopes) expect(s).toBe(GLOBAL_ONLY);
  });
});

describe("integration — real read/write against a project slice", () => {
  // A fake project root; writeMemory hashes it to its own slice under `home`.
  const PROJECT_ROOT = "/tmp/siltpoke-fake-repo-for-facts-pscope";
  const projStub = async (): Promise<{
    project_id: null;
    proj_hash: null;
    project_root: string;
    display_name: null;
    source: "explicit";
  }> => ({
    project_id: null,
    proj_hash: null,
    project_root: PROJECT_ROOT,
    display_name: null,
    source: "explicit",
  });

  async function seedUntaggedInSlice(id: string): Promise<void> {
    // Activate the v3 layout — writeMemory only SPLITS (global vs slice) when
    // global.json exists; without it, it falls back to the legacy monolith and
    // the fact would never reach a real slice.
    await writeGlobal(home, emptyGlobal());
    // An untagged (kind:null) fact then routes to the PROJECT slice via the split.
    await writeMemory(
      home,
      storedWith([makeFact({ id, text: "untagged pending", kind: null, status: "pending" })]),
      PROJECT_ROOT,
    );
  }

  test("approve on an untagged fact that lives in the project slice → 200, active in the slice (was 404)", async () => {
    await seedUntaggedInSlice("f-slice");
    const app = new Hono();
    mountFactsRoutes(app, {
      homeBase: home,
      secret: SECRET,
      readMemory,
      writeMemory,
      resolveProject: projStub,
    });

    const res = await app.request("/api/facts/f-slice/approve?repo=x", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);

    // Persisted back into the SAME project slice, now active.
    const after = await readMemory(home, PROJECT_ROOT);
    expect(after?.facts.find((f) => f.id === "f-slice")?.status).toBe("active");
    // NOT leaked into global.
    const g = await readGlobal(home);
    expect(g?.facts.find((f) => f.id === "f-slice")).toBeUndefined();
  });

  test("tagging an untagged slice fact as style promotes it into global (leaves the slice)", async () => {
    await seedUntaggedInSlice("f-promote");
    const app = new Hono();
    mountFactsRoutes(app, {
      homeBase: home,
      secret: SECRET,
      readMemory,
      writeMemory,
      resolveProject: projStub,
    });

    const res = await app.request("/api/facts/f-promote/kind?repo=x", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "style" }),
    });
    expect(res.status).toBe(200);

    // isGlobalFact flipped → writeMemoryV3Split moved it into global.
    const g = await readGlobal(home);
    expect(g?.facts.find((f) => f.id === "f-promote")?.kind).toBe("style");
    // The merged view still shows exactly one copy (no slice/global duplicate).
    const merged = await readMemory(home, PROJECT_ROOT);
    expect(merged?.facts.filter((f) => f.id === "f-promote").length).toBe(1);
  });
});

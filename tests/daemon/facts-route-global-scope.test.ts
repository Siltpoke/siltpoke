/**
 * Facts-API GLOBAL_ONLY scope (Leg A — T3, AC1/AC2).
 *
 * The dashboard/facts API has no project context. Under launchd the daemon's
 * cwd is `/` (an empty `/`-hash project slice). These tests prove the route
 * reads/writes the cwd-independent GLOBAL store via the GLOBAL_ONLY sentinel,
 * so user facts surface regardless of the daemon's cwd.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountFactsRoutes } from "../../src/daemon/routes/facts";
import {
  readMemory,
  writeMemory,
  GLOBAL_ONLY,
  type CoreMemory,
  type Fact,
  type ProjectScope,
} from "../../src/memory/memory";
import { writeGlobal, readGlobal, emptyGlobal } from "../../src/memory/global";

const SECRET = "good";

// Task 11 write-eligibility guard: these tests aren't exercising project
// resolution (that's facts-write-guard.test.ts's job) — inject a fixed
// "explicit" resolution so the guard added on every write handler doesn't
// 409 against this file's real-but-empty tmpdir homeBase.
const ELIGIBLE_PROJECT = async () => ({
  project_id: null,
  proj_hash: null,
  project_root: null,
  display_name: null,
  source: "explicit" as const,
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-facts-gscope-"));
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

describe("facts API reads the global store (cwd-independent)", () => {
  test("AC1/AC2 — GET /api/facts returns global facts even though process.cwd() slice is empty", async () => {
    // Seed ONLY the global store. process.cwd() (the test runner's repo) has no
    // matching project slice under this temp home — a cwd-based read would 0-out.
    const g = emptyGlobal();
    g.facts = [makeFact({ id: "f-style", text: "喜欢中文", kind: "style", status: "active" })];
    await writeGlobal(home, g);

    const app = new Hono();
    mountFactsRoutes(app, { homeBase: home, secret: SECRET, readMemory, writeMemory, resolveProject: ELIGIBLE_PROJECT });

    const res = await app.request("/api/facts", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { facts: Fact[] };
    expect(json.facts.map((f) => f.id)).toContain("f-style");
  });

  test("approve writes back to the GLOBAL store (round-trips a global fact)", async () => {
    const g = emptyGlobal();
    g.facts = [makeFact({ id: "f-p", text: "pending style", kind: "style", status: "pending" })];
    await writeGlobal(home, g);

    const app = new Hono();
    mountFactsRoutes(app, { homeBase: home, secret: SECRET, readMemory, writeMemory, resolveProject: ELIGIBLE_PROJECT });

    const res = await app.request("/api/facts/f-p/approve", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);

    // The status change persisted in the GLOBAL store (not a project slice).
    const after = await readGlobal(home);
    const f = after!.facts.find((x) => x.id === "f-p");
    expect(f?.status).toBe("active");
  });
});

describe("route threads GLOBAL_ONLY to its deps (contract)", () => {
  test("every read/write call passes the GLOBAL_ONLY sentinel", async () => {
    const scopes: (ProjectScope | undefined)[] = [];
    const stored: CoreMemory | null = {
      schemaVersion: 2,
      long_term_summary: "",
      learned_rules: [],
      personality_drift: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0 },
      last_consolidated_at: "2026-07-08T00:00:00Z",
      consolidation_due_at: "2026-07-08T00:00:00Z",
      user_profile: { communication_style: "neutral", goals: [], constraints: [], prefs: {} },
      chat_sessions: [],
      facts: [makeFact({ id: "f-p", status: "pending", kind: "style" })],
      event_fragments: [],
      episodes: [],
    };

    const app = new Hono();
    mountFactsRoutes(app, {
      homeBase: home,
      secret: SECRET,
      readMemory: async (_h, projectCwd) => {
        scopes.push(projectCwd);
        return stored;
      },
      writeMemory: async (_h, _m, projectCwd) => {
        scopes.push(projectCwd);
      },
      resolveProject: ELIGIBLE_PROJECT,
    });

    await app.request("/api/facts/f-p/approve", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });

    expect(scopes.length).toBeGreaterThan(0);
    for (const s of scopes) expect(s).toBe(GLOBAL_ONLY);
  });
});

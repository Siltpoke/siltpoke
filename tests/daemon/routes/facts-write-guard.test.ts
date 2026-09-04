// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Facts writes are ALWAYS allowed regardless of project resolution
 * (Task 16 — reverts Task 11's write-eligibility guard on this route).
 *
 * Facts are GLOBAL writes (writeMemory(..., GLOBAL_ONLY)) — they are never
 * project-scoped, so gating them behind project-resolution INTENTIONALITY
 * was wrong: on a brand-new install (source: "none", no project slice/index
 * yet) it 409'd every fact write, including a user's very first "call me
 * Alex". `resolveProject` is still accepted as a mount option (back-compat —
 * ~19 pre-existing test files inject a fixed stub) but the route no longer
 * calls it.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mountFactsRoutes } from "../../../src/daemon/routes/facts";
import type { CoreMemory, Fact } from "../../../src/memory/memory";

const SECRET = "s";

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "f-aaaaaaaa",
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

function makeMemory(facts: Fact[] = []): CoreMemory {
  return {
    schemaVersion: 2,
    long_term_summary: "",
    learned_rules: [],
    personality_drift: {
      snark: 0,
      patience: 0,
      style_strictness: 0,
      proactivity: 0,
    },
    last_consolidated_at: "2026-05-14T00:00:00.000Z",
    consolidation_due_at: "2026-05-21T00:00:00.000Z",
    user_profile: {
      communication_style: "neutral",
      goals: [],
      constraints: [],
      prefs: {},
    },
    chat_sessions: [],
    facts,
    event_fragments: [],
    episodes: [],
  };
}

describe("POST /api/facts — global writes are never gated by project resolution", () => {
  test("proceeds (201) even when the resolved project is only a recency guess (source: recent)", async () => {
    const app = new Hono();
    mountFactsRoutes(app, {
      homeBase: "/fake",
      secret: SECRET,
      readMemory: async () => makeMemory(),
      writeMemory: async () => {},
      resolveProject: async () => ({
        project_id: null,
        proj_hash: "abcdef012345",
        project_root: "/r",
        display_name: null,
        source: "recent",
      }),
    });

    const res = await app.request("/api/facts?repo=abcdef012345", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });

    expect(res.status).toBe(201);
  });

  test("proceeds (201) when the resolved project is an intentional selection (source: explicit)", async () => {
    const app = new Hono();
    mountFactsRoutes(app, {
      homeBase: "/fake",
      secret: SECRET,
      readMemory: async () => makeMemory(),
      writeMemory: async () => {},
      resolveProject: async () => ({
        project_id: "p-1",
        proj_hash: "abcdef012345",
        project_root: "/r",
        display_name: "r",
        source: "explicit",
      }),
    });

    const res = await app.request("/api/facts?repo=abcdef012345", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });

    expect(res.status).toBe(201);
  });

  test("proceeds (201) when the resolved project is the sticky pin (source: sticky)", async () => {
    const app = new Hono();
    mountFactsRoutes(app, {
      homeBase: "/fake",
      secret: SECRET,
      readMemory: async () => makeMemory(),
      writeMemory: async () => {},
      resolveProject: async () => ({
        project_id: "p-1",
        proj_hash: "abcdef012345",
        project_root: "/r",
        display_name: "r",
        source: "sticky",
      }),
    });

    const res = await app.request("/api/facts", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });

    expect(res.status).toBe(201);
  });

  test("proceeds (201) even when no project resolves at all (source: none) — brand-new-install case", async () => {
    // The concrete harm this test guards against: a fresh install has no
    // registered project (source: none) until the first repo review runs.
    // A global fact write (e.g. the user's very first "call me Alex") must
    // still succeed — it was never project-scoped in the first place.
    const app = new Hono();
    mountFactsRoutes(app, {
      homeBase: "/fake",
      secret: SECRET,
      readMemory: async () => makeMemory(),
      writeMemory: async () => {},
      resolveProject: async () => ({
        project_id: null,
        proj_hash: null,
        project_root: null,
        display_name: null,
        source: "none",
      }),
    });

    const res = await app.request("/api/facts", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });

    expect(res.status).toBe(201);
  });

  test("401s when the secret header is missing/wrong (auth runs BEFORE resolveProject — scope resolution never reached)", async () => {
    let called = false;
    const app = new Hono();
    mountFactsRoutes(app, {
      homeBase: "/fake",
      secret: SECRET,
      readMemory: async () => makeMemory(),
      writeMemory: async () => {},
      resolveProject: async () => {
        called = true;
        return {
          project_id: "p-1",
          proj_hash: "abcdef012345",
          project_root: "/r",
          display_name: "r",
          source: "explicit",
        };
      },
    });

    const res = await app.request("/api/facts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });

    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });

  test("POST /api/facts/:id/retire proceeds (200) regardless of project resolution (source: recent)", async () => {
    const app = new Hono();
    mountFactsRoutes(app, {
      homeBase: "/fake",
      secret: SECRET,
      readMemory: async () => makeMemory([makeFact({ id: "f-1", status: "active" })]),
      writeMemory: async () => {},
      resolveProject: async () => ({
        project_id: null,
        proj_hash: "abcdef012345",
        project_root: "/r",
        display_name: null,
        source: "recent",
      }),
    });

    const res = await app.request("/api/facts/f-1/retire", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });

    expect(res.status).toBe(200);
  });

  test("GET /api/facts is never guarded (reads proceed regardless of project resolution)", async () => {
    const app = new Hono();
    mountFactsRoutes(app, {
      homeBase: "/fake",
      secret: SECRET,
      readMemory: async () => makeMemory([makeFact({ id: "f-1" })]),
      writeMemory: async () => {},
      resolveProject: async () => ({
        project_id: null,
        proj_hash: null,
        project_root: null,
        display_name: null,
        source: "none",
      }),
    });

    const res = await app.request("/api/facts", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });

    expect(res.status).toBe(200);
  });
});

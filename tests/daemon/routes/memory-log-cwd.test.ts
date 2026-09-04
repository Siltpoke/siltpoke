// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mountMemoryLogRoute } from "../../../src/daemon/routes/memory-log";
import { type CoreMemory, GLOBAL_ONLY } from "../../../src/memory/memory";

const SECRET = "test-secret";

function makeMemory(): CoreMemory {
  return {
    schemaVersion: 2,
    long_term_summary: "",
    learned_rules: [],
    personality_drift: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0 },
    last_consolidated_at: "2026-05-14T00:00:00.000Z",
    consolidation_due_at: "2026-05-21T00:00:00.000Z",
    user_profile: { communication_style: "neutral", goals: [], constraints: [], prefs: {} },
    chat_sessions: [],
    facts: [],
    event_fragments: [],
    episodes: [],
  };
}

describe("/api/memory-log scope", () => {
  test("passes the resolved project scope into readMemory when ?repo= resolves", async () => {
    let seenHomeBase: unknown = "UNCALLED";
    let seenScope: unknown = "UNCALLED";
    const app = new Hono();
    mountMemoryLogRoute(app, {
      homeBase: "/fake/home",
      secret: SECRET,
      readMemory: async (home: string, scope?: unknown) => {
        seenHomeBase = home;
        seenScope = scope;
        return makeMemory();
      },
      loadCritiques: async () => [],
      // Injected resolver so the test controls resolution deterministically
      // instead of touching the real project-pin / repo-memory disk state.
      resolveScope: async () => "/resolved/project/root",
    });

    const res = await app.request("/api/memory-log?repo=abcdef012345", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });

    expect(res.status).toBe(200);
    expect(seenHomeBase).toBe("/fake/home");
    expect(seenScope).toBe("/resolved/project/root");
  });

  test("falls back to GLOBAL_ONLY scope when resolveScope returns null", async () => {
    let seenScope: unknown = "UNCALLED";
    const app = new Hono();
    mountMemoryLogRoute(app, {
      homeBase: "/fake/home",
      secret: SECRET,
      readMemory: async (_home: string, scope?: unknown) => {
        seenScope = scope;
        return makeMemory();
      },
      loadCritiques: async () => [],
      resolveScope: async () => null,
    });

    const res = await app.request("/api/memory-log", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });

    expect(res.status).toBe(200);
    expect(seenScope).toBe(GLOBAL_ONLY);
  });

  test("401s when the secret header is missing or wrong (readMemory never called)", async () => {
    let called = false;
    const app = new Hono();
    mountMemoryLogRoute(app, {
      homeBase: "/fake/home",
      secret: SECRET,
      readMemory: async () => {
        called = true;
        return null;
      },
      loadCritiques: async () => [],
      resolveScope: async () => "/resolved/project/root",
    });

    const res = await app.request("/api/memory-log");

    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });
});

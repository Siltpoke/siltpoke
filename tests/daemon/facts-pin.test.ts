// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountFactsRoutes } from "../../src/daemon/routes/facts";
import type { CoreMemory, Fact } from "../../src/memory/memory";

// ---------------------------------------------------------------------------
// Fixtures — copied verbatim from facts-route.test.ts (same harness shape).
// ---------------------------------------------------------------------------

const SECRET = "good";
const NOW_FROZEN = "2026-05-18T12:00:00.000Z";

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "f-aaaaaaaa",
    text: "user prefers terse responses",
    source_session_id: "s-bbbbbbbb",
    confidence: 0.8,
    status: "pending",
    created_at: "2026-05-15T00:00:00.000Z",
    last_seen_at: "2026-05-15T00:00:00.000Z",
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

function makeMemory(facts: Fact[]): CoreMemory {
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

interface Harness {
  app: Hono;
  homeBase: string;
  getStored: () => CoreMemory | null;
  writeCount: () => number;
  lastWritten: () => CoreMemory | null;
}

function buildHarness(initial: CoreMemory | null): Harness {
  let stored: CoreMemory | null = initial;
  let writes = 0;
  let lastWritten: CoreMemory | null = null;
  const homeBase = mkdtempSync(join(tmpdir(), "facts-pin-"));
  const app = new Hono();
  mountFactsRoutes(app, {
    homeBase,
    secret: SECRET,
    readMemory: async () => stored,
    writeMemory: async (_h, m) => {
      writes += 1;
      lastWritten = m;
      stored = m;
    },
    now: () => NOW_FROZEN,
    // Fixed "explicit" resolution — same rationale as facts-route.test.ts:
    // this harness isn't exercising project resolution.
    resolveProject: async () => ({
      project_id: null,
      proj_hash: null,
      project_root: null,
      display_name: null,
      source: "explicit" as const,
    }),
  });
  return {
    app,
    homeBase,
    getStored: () => stored,
    writeCount: () => writes,
    lastWritten: () => lastWritten,
  };
}

// ---------------------------------------------------------------------------
// POST /api/facts/:id/pin
// ---------------------------------------------------------------------------

describe("POST /api/facts/:id/pin", () => {
  let h: Harness;
  afterEach(() => {
    if (h?.homeBase) rmSync(h.homeBase, { recursive: true, force: true });
  });

  const post = (app: Hono, id: string, body: unknown, secret = SECRET) =>
    app.request(`/api/facts/${id}/pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": secret },
      body: JSON.stringify(body),
    });

  test("401 when secret missing", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1", status: "active" })]));
    const res = await h.app.request(`/api/facts/f-1/pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(401);
    expect(h.writeCount()).toBe(0);
  });

  test("401 when secret wrong", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1", status: "active" })]));
    const res = await post(h.app, "f-1", { pinned: true }, "bad");
    expect(res.status).toBe(401);
    expect(h.writeCount()).toBe(0);
  });

  test("404 on unknown id", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1", status: "active" })]));
    const res = await post(h.app, "nope", { pinned: true });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string; id: string };
    expect(json.error).toBe("not_found");
    expect(json.id).toBe("nope");
    expect(h.writeCount()).toBe(0);
  });

  test("400 invalid_body on non-boolean pinned", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1", status: "active" })]));
    const res = await post(h.app, "f-1", { pinned: "yes" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid_body");
    expect(h.writeCount()).toBe(0);
  });

  test("400 invalid_body when pinned is missing", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1", status: "active" })]));
    const res = await post(h.app, "f-1", {});
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid_body");
    expect(h.writeCount()).toBe(0);
  });

  test("200 pins an active fact, writeMemory called once", async () => {
    h = buildHarness(
      makeMemory([makeFact({ id: "f-1", status: "active", pinned: false })]),
    );
    const res = await post(h.app, "f-1", { pinned: true });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { fact: Fact };
    expect(json.fact.id).toBe("f-1");
    expect(json.fact.pinned).toBe(true);

    expect(h.writeCount()).toBe(1);
    const written = h.lastWritten()!;
    expect(written.facts.find((f) => f.id === "f-1")?.pinned).toBe(true);
  });

  test("200 unpins a pinned fact, writeMemory called once", async () => {
    h = buildHarness(
      makeMemory([makeFact({ id: "f-1", status: "active", pinned: true })]),
    );
    const res = await post(h.app, "f-1", { pinned: false });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { fact: Fact };
    expect(json.fact.pinned).toBe(false);
    expect(h.writeCount()).toBe(1);
  });

  test("idempotent — pin=true on an already-pinned fact returns 200 but does NOT write", async () => {
    h = buildHarness(
      makeMemory([makeFact({ id: "f-1", status: "active", pinned: true })]),
    );
    const res = await post(h.app, "f-1", { pinned: true });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { fact: Fact };
    expect(json.fact.pinned).toBe(true);
    expect(h.writeCount()).toBe(0);
  });

  test("409 already_retired when the fact is retired", async () => {
    h = buildHarness(
      makeMemory([makeFact({ id: "f-1", status: "retired", retired_reason: "user_rejected" })]),
    );
    const res = await post(h.app, "f-1", { pinned: true });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("already_retired");
    expect(h.writeCount()).toBe(0);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { BudgetSignal, QuietHoursSignal } from "../../src/daemon/routes/chat";
import { mountFactsRoutes } from "../../src/daemon/routes/facts";
import type { CoreMemory, Fact } from "../../src/memory/memory";
import type { MemoryEditResult } from "../../src/memory/nl-edit";

// ---------------------------------------------------------------------------
// Fixtures
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
  setStored: (m: CoreMemory | null) => void;
  writeCount: () => number;
  lastWritten: () => CoreMemory | null;
}

function buildHarness(initial: CoreMemory | null): Harness {
  let stored: CoreMemory | null = initial;
  let writes = 0;
  let lastWritten: CoreMemory | null = null;
  const homeBase = mkdtempSync(join(tmpdir(), "facts-route-"));
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
  });
  return {
    app,
    homeBase,
    getStored: () => stored,
    setStored: (m) => {
      stored = m;
    },
    writeCount: () => writes,
    lastWritten: () => lastWritten,
  };
}

// ---------------------------------------------------------------------------
// GET /api/facts
// ---------------------------------------------------------------------------

describe("GET /api/facts", () => {
  let h: Harness;

  afterEach(() => {
    if (h?.homeBase) rmSync(h.homeBase, { recursive: true, force: true });
  });

  test("401 when secret header missing", async () => {
    h = buildHarness(makeMemory([]));
    const res = await h.app.request("/api/facts");
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("unauthorized");
  });

  test("401 when secret header wrong", async () => {
    h = buildHarness(makeMemory([]));
    const res = await h.app.request("/api/facts", {
      headers: { "X-Siltpoke-Secret": "bad" },
    });
    expect(res.status).toBe(401);
  });

  test("200 empty array when memory is null", async () => {
    h = buildHarness(null);
    const res = await h.app.request("/api/facts", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { facts: Fact[] };
    expect(json.facts).toEqual([]);
  });

  test("200 empty array when memory has no facts", async () => {
    h = buildHarness(makeMemory([]));
    const res = await h.app.request("/api/facts", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { facts: Fact[] };
    expect(json.facts).toEqual([]);
  });

  test("200 returns all facts when no status filter", async () => {
    h = buildHarness(
      makeMemory([
        makeFact({ id: "f-1", status: "pending" }),
        makeFact({ id: "f-2", status: "active" }),
        makeFact({ id: "f-3", status: "retired" }),
      ]),
    );
    const res = await h.app.request("/api/facts", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { facts: Fact[] };
    expect(json.facts).toHaveLength(3);
    expect(json.facts.map((f) => f.id).sort()).toEqual(["f-1", "f-2", "f-3"]);
  });

  test("200 filters by status=pending", async () => {
    h = buildHarness(
      makeMemory([
        makeFact({ id: "f-1", status: "pending" }),
        makeFact({ id: "f-2", status: "active" }),
        makeFact({ id: "f-3", status: "retired" }),
      ]),
    );
    const res = await h.app.request("/api/facts?status=pending", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { facts: Fact[] };
    expect(json.facts).toHaveLength(1);
    expect(json.facts[0]?.id).toBe("f-1");
    expect(json.facts[0]?.status).toBe("pending");
  });

  test("200 filters by status=active", async () => {
    h = buildHarness(
      makeMemory([
        makeFact({ id: "f-1", status: "pending" }),
        makeFact({ id: "f-2", status: "active" }),
        makeFact({ id: "f-3", status: "retired" }),
      ]),
    );
    const res = await h.app.request("/api/facts?status=active", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { facts: Fact[] };
    expect(json.facts).toHaveLength(1);
    expect(json.facts[0]?.id).toBe("f-2");
  });

  test("200 filters by status=retired", async () => {
    h = buildHarness(
      makeMemory([
        makeFact({ id: "f-1", status: "pending" }),
        makeFact({ id: "f-2", status: "active" }),
        makeFact({ id: "f-3", status: "retired" }),
      ]),
    );
    const res = await h.app.request("/api/facts?status=retired", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { facts: Fact[] };
    expect(json.facts).toHaveLength(1);
    expect(json.facts[0]?.id).toBe("f-3");
  });

  test("200 sorts by created_at descending (newest first)", async () => {
    h = buildHarness(
      makeMemory([
        makeFact({ id: "f-old", created_at: "2026-05-10T00:00:00.000Z" }),
        makeFact({ id: "f-new", created_at: "2026-05-17T00:00:00.000Z" }),
        makeFact({ id: "f-mid", created_at: "2026-05-14T00:00:00.000Z" }),
      ]),
    );
    const res = await h.app.request("/api/facts", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { facts: Fact[] };
    expect(json.facts.map((f) => f.id)).toEqual(["f-new", "f-mid", "f-old"]);
  });

  test("400 invalid_status for garbage query param", async () => {
    h = buildHarness(makeMemory([]));
    const res = await h.app.request("/api/facts?status=garbage", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid_status");
  });
});

// ---------------------------------------------------------------------------
// POST /api/facts/:id/approve
// ---------------------------------------------------------------------------

describe("POST /api/facts/:id/approve", () => {
  let h: Harness;

  afterEach(() => {
    if (h?.homeBase) rmSync(h.homeBase, { recursive: true, force: true });
  });

  test("401 when secret missing", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1" })]));
    const res = await h.app.request("/api/facts/f-1/approve", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("401 when secret wrong", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1" })]));
    const res = await h.app.request("/api/facts/f-1/approve", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": "bad" },
    });
    expect(res.status).toBe(401);
  });

  test("404 when id unknown", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1" })]));
    const res = await h.app.request("/api/facts/f-unknown/approve", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string; id: string };
    expect(json.error).toBe("not_found");
    expect(json.id).toBe("f-unknown");
    expect(h.writeCount()).toBe(0);
  });

  test("404 when memory is null", async () => {
    h = buildHarness(null);
    const res = await h.app.request("/api/facts/f-1/approve", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string; id: string };
    expect(json.error).toBe("not_found");
    expect(json.id).toBe("f-1");
    expect(h.writeCount()).toBe(0);
  });

  test("200 happy path: pending → active, writeMemory called, last_seen_at bumped", async () => {
    h = buildHarness(
      makeMemory([
        makeFact({
          id: "f-1",
          status: "pending",
          last_seen_at: "2026-05-15T00:00:00.000Z",
        }),
      ]),
    );
    const res = await h.app.request("/api/facts/f-1/approve", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { fact: Fact };
    expect(json.fact.id).toBe("f-1");
    expect(json.fact.status).toBe("active");
    expect(json.fact.last_seen_at).toBe(NOW_FROZEN);

    expect(h.writeCount()).toBe(1);
    const written = h.lastWritten()!;
    const writtenFact = written.facts.find((f) => f.id === "f-1")!;
    expect(writtenFact.status).toBe("active");
    expect(writtenFact.last_seen_at).toBe(NOW_FROZEN);
  });

  test("409 not_pending when fact is already active (current_status echoed)", async () => {
    h = buildHarness(
      makeMemory([makeFact({ id: "f-1", status: "active" })]),
    );
    const res = await h.app.request("/api/facts/f-1/approve", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as {
      error: string;
      current_status: string;
    };
    expect(json.error).toBe("not_pending");
    expect(json.current_status).toBe("active");
    expect(h.writeCount()).toBe(0);
  });

  test("409 not_pending when fact is retired (current_status echoed)", async () => {
    h = buildHarness(
      makeMemory([
        makeFact({
          id: "f-1",
          status: "retired",
          retired_reason: "user_rejected",
        }),
      ]),
    );
    const res = await h.app.request("/api/facts/f-1/approve", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as {
      error: string;
      current_status: string;
    };
    expect(json.error).toBe("not_pending");
    expect(json.current_status).toBe("retired");
    expect(h.writeCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/facts/:id/retire
// ---------------------------------------------------------------------------

describe("POST /api/facts/:id/retire", () => {
  let h: Harness;

  afterEach(() => {
    if (h?.homeBase) rmSync(h.homeBase, { recursive: true, force: true });
  });

  test("401 when secret missing", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1" })]));
    const res = await h.app.request("/api/facts/f-1/retire", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("401 when secret wrong", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1" })]));
    const res = await h.app.request("/api/facts/f-1/retire", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": "bad" },
    });
    expect(res.status).toBe(401);
  });

  test("404 when id unknown", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1" })]));
    const res = await h.app.request("/api/facts/f-unknown/retire", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string; id: string };
    expect(json.error).toBe("not_found");
    expect(json.id).toBe("f-unknown");
    expect(h.writeCount()).toBe(0);
  });

  test("404 when memory is null", async () => {
    h = buildHarness(null);
    const res = await h.app.request("/api/facts/f-1/retire", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string; id: string };
    expect(json.error).toBe("not_found");
    expect(json.id).toBe("f-1");
    expect(h.writeCount()).toBe(0);
  });

  test("200 happy path: pending → retired (user_rejected), writeMemory called", async () => {
    h = buildHarness(
      makeMemory([
        makeFact({
          id: "f-1",
          status: "pending",
          last_seen_at: "2026-05-15T00:00:00.000Z",
        }),
      ]),
    );
    const res = await h.app.request("/api/facts/f-1/retire", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { fact: Fact };
    expect(json.fact.id).toBe("f-1");
    expect(json.fact.status).toBe("retired");
    expect(json.fact.retired_reason).toBe("user_rejected");
    // CLI parity: last_seen_at is NOT bumped on retire.
    expect(json.fact.last_seen_at).toBe("2026-05-15T00:00:00.000Z");

    expect(h.writeCount()).toBe(1);
    const written = h.lastWritten()!;
    const writtenFact = written.facts.find((f) => f.id === "f-1")!;
    expect(writtenFact.status).toBe("retired");
    expect(writtenFact.retired_reason).toBe("user_rejected");
    expect(writtenFact.last_seen_at).toBe("2026-05-15T00:00:00.000Z");
  });

  test("200 happy path: active → retired, writeMemory called", async () => {
    h = buildHarness(
      makeMemory([makeFact({ id: "f-1", status: "active" })]),
    );
    const res = await h.app.request("/api/facts/f-1/retire", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { fact: Fact };
    expect(json.fact.status).toBe("retired");
    expect(json.fact.retired_reason).toBe("user_rejected");
    expect(h.writeCount()).toBe(1);
  });

  test("200 idempotent already-retired: writeMemory NOT called, returns existing fact", async () => {
    const retiredFact = makeFact({
      id: "f-1",
      status: "retired",
      retired_reason: "user_rejected",
      last_seen_at: "2026-05-12T00:00:00.000Z",
    });
    h = buildHarness(makeMemory([retiredFact]));
    const res = await h.app.request("/api/facts/f-1/retire", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { fact: Fact };
    expect(json.fact.id).toBe("f-1");
    expect(json.fact.status).toBe("retired");
    expect(json.fact.retired_reason).toBe("user_rejected");
    expect(json.fact.last_seen_at).toBe("2026-05-12T00:00:00.000Z");

    // Idempotent — no write.
    expect(h.writeCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/facts/:id/reactivate
// ---------------------------------------------------------------------------

describe("POST /api/facts/:id/reactivate", () => {
  let h: Harness;

  afterEach(() => {
    if (h?.homeBase) rmSync(h.homeBase, { recursive: true, force: true });
  });

  test("401 when secret missing", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1", status: "retired" })]));
    const res = await h.app.request("/api/facts/f-1/reactivate", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("404 when id unknown", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1", status: "retired" })]));
    const res = await h.app.request("/api/facts/f-unknown/reactivate", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(404);
    expect(h.writeCount()).toBe(0);
  });

  test("200 happy: retired → active, retired_reason cleared, writeMemory called", async () => {
    h = buildHarness(
      makeMemory([
        makeFact({ id: "f-1", status: "retired", retired_reason: "user_rejected" }),
      ]),
    );
    const res = await h.app.request("/api/facts/f-1/reactivate", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { fact: Fact };
    expect(json.fact.status).toBe("active");
    expect(json.fact.retired_reason).toBeNull();

    expect(h.writeCount()).toBe(1);
    const written = h.lastWritten()!;
    expect(written.facts.find((f) => f.id === "f-1")!.status).toBe("active");
  });

  test("409 not_retired when fact is active, no write", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1", status: "active" })]));
    const res = await h.app.request("/api/facts/f-1/reactivate", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; current_status: string };
    expect(json.error).toBe("not_retired");
    expect(json.current_status).toBe("active");
    expect(h.writeCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/facts (create)
// ---------------------------------------------------------------------------

describe("POST /api/facts", () => {
  let h: Harness;
  afterEach(() => {
    if (h?.homeBase) rmSync(h.homeBase, { recursive: true, force: true });
  });

  function post(app: Hono, body: unknown, secret = SECRET) {
    return app.request("/api/facts", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": secret, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("401 when secret missing", async () => {
    h = buildHarness(makeMemory([]));
    const res = await post(h.app, { text: "x" }, "");
    expect(res.status).toBe(401);
    expect(h.writeCount()).toBe(0);
  });

  test("400 on empty/blank text", async () => {
    h = buildHarness(makeMemory([]));
    const res = await post(h.app, { text: "   " });
    expect(res.status).toBe(400);
    expect(h.writeCount()).toBe(0);
  });

  test("201 creates a pending fact and persists it", async () => {
    h = buildHarness(makeMemory([]));
    const res = await post(h.app, { text: "User prefers pink" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { fact: Fact };
    expect(json.fact.status).toBe("pending");
    expect(json.fact.text).toBe("User prefers pink");
    expect(json.fact.confidence).toBe(0.9); // default for user-typed add
    expect(json.fact.learned_from).toEqual({ stream: "user", session_id: null });
    expect(h.writeCount()).toBe(1);
    expect(h.lastWritten()?.facts.some((f) => f.id === json.fact.id)).toBe(true);
  });

  test("201 supersede path links old fact but leaves it active", async () => {
    const old = makeFact({ id: "f-old", status: "active" });
    h = buildHarness(makeMemory([old]));
    const res = await post(h.app, { text: "new", supersedes: "f-old" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { fact: Fact };
    expect(json.fact.supersedes).toBe("f-old");
    const oldAfter = h.lastWritten()?.facts.find((f) => f.id === "f-old");
    expect(oldAfter?.superseded_by).toBe(json.fact.id);
    expect(oldAfter?.status).toBe("active"); // not retired until approved
    expect(oldAfter?.invalid_at).toBeNull();
  });

  test("404 when supersede target is missing", async () => {
    h = buildHarness(makeMemory([]));
    const res = await post(h.app, { text: "new", supersedes: "f-ghost" });
    expect(res.status).toBe(404);
    expect(h.writeCount()).toBe(0);
  });

  test("409 when supersede target is not active (retired)", async () => {
    h = buildHarness(
      makeMemory([makeFact({ id: "f-ret", status: "retired" })]),
    );
    const res = await post(h.app, { text: "new", supersedes: "f-ret" });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; current_status: string };
    expect(json.error).toBe("not_active");
    expect(json.current_status).toBe("retired");
    expect(h.writeCount()).toBe(0);
  });

  test("409 when supersede target is pending", async () => {
    h = buildHarness(
      makeMemory([makeFact({ id: "f-pend", status: "pending" })]),
    );
    const res = await post(h.app, { text: "new", supersedes: "f-pend" });
    expect(res.status).toBe(409);
    expect(h.writeCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/facts/:id/restate (reconfirm)
// ---------------------------------------------------------------------------

describe("POST /api/facts/:id/restate", () => {
  let h: Harness;
  afterEach(() => {
    if (h?.homeBase) rmSync(h.homeBase, { recursive: true, force: true });
  });

  function restate(app: Hono, id: string, secret = SECRET) {
    return app.request(`/api/facts/${id}/restate`, {
      method: "POST",
      headers: { "X-Siltpoke-Secret": secret },
    });
  }

  test("401 when secret missing", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1", status: "active" })]));
    const res = await restate(h.app, "f-1", "");
    expect(res.status).toBe(401);
    expect(h.writeCount()).toBe(0);
  });

  test("200 reconfirms an active fact (clocks refreshed, status unchanged)", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1", status: "active" })]));
    const res = await restate(h.app, "f-1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { fact: Fact };
    expect(json.fact.status).toBe("active");
    expect(json.fact.last_confirmed_at).toBe(NOW_FROZEN);
    expect(json.fact.last_seen_at).toBe(NOW_FROZEN);
  });

  test("200 restating a pending fact approves it (→ active)", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1", status: "pending" })]));
    const res = await restate(h.app, "f-1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { fact: Fact };
    expect(json.fact.status).toBe("active");
  });

  test("404 when fact not found", async () => {
    h = buildHarness(makeMemory([]));
    const res = await restate(h.app, "f-ghost");
    expect(res.status).toBe(404);
    expect(h.writeCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/facts/parse (NL intent parse — never writes)
// ---------------------------------------------------------------------------

describe("POST /api/facts/parse", () => {
  let homeBase: string | undefined;
  afterEach(() => {
    if (homeBase) rmSync(homeBase, { recursive: true, force: true });
    homeBase = undefined;
  });

  function buildParseHarness(opts: {
    facts: Fact[];
    parseFn?: (text: string, active: Fact[]) => Promise<MemoryEditResult>;
    checkSendGate?: () => Promise<BudgetSignal | QuietHoursSignal | null>;
  }): Hono {
    homeBase = mkdtempSync(join(tmpdir(), "facts-parse-"));
    const app = new Hono();
    let writes = 0;
    mountFactsRoutes(app, {
      homeBase,
      secret: SECRET,
      readMemory: async () => makeMemory(opts.facts),
      writeMemory: async () => {
        writes += 1;
      },
      now: () => NOW_FROZEN,
      parseFn: opts.parseFn,
      checkSendGate: opts.checkSendGate,
    });
    // Expose write count via a property on the app for no-write assertions.
    (app as unknown as { _writes: () => number })._writes = () => writes;
    return app;
  }

  function postParse(app: Hono, body: unknown, secret = SECRET) {
    return app.request("/api/facts/parse", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": secret, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("401 when secret missing", async () => {
    const app = buildParseHarness({ facts: [] });
    const res = await postParse(app, { text: "记得我喜欢粉红色" }, "");
    expect(res.status).toBe(401);
  });

  test("400 on empty text", async () => {
    const app = buildParseHarness({ facts: [] });
    const res = await postParse(app, { text: "   " });
    expect(res.status).toBe(400);
  });

  test("200 add classification (no contradicted fact)", async () => {
    const app = buildParseHarness({
      facts: [],
      parseFn: async () => ({
        candidate_claim: "User prefers pink",
        classification: "add",
        target_fact_id: null,
        confidence: 0.9,
      }),
    });
    const res = await postParse(app, { text: "记得我喜欢粉红色" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      candidate: string;
      classification: string;
      confidence: number;
      targetFactId: string | null;
      contradictedFact: unknown;
    };
    expect(json.classification).toBe("add");
    expect(json.candidate).toBe("User prefers pink");
    expect(json.confidence).toBe(0.9);
    expect(json.contradictedFact).toBeNull();
    expect((app as unknown as { _writes: () => number })._writes()).toBe(0);
  });

  test("200 restate returns the matched fact", async () => {
    const existing = makeFact({
      id: "f-pink",
      status: "active",
      text: "User prefers pink",
    });
    const app = buildParseHarness({
      facts: [existing],
      parseFn: async () => ({
        candidate_claim: "User likes pink",
        classification: "restate",
        target_fact_id: "f-pink",
        confidence: 0.8,
      }),
    });
    const res = await postParse(app, { text: "我还是喜欢粉色" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      classification: string;
      targetFactId: string;
      contradictedFact: { id: string; text: string };
    };
    expect(json.classification).toBe("restate");
    expect(json.targetFactId).toBe("f-pink");
    expect(json.contradictedFact).toEqual({ id: "f-pink", text: "User prefers pink" });
  });

  test("200 contradict returns the contradicted fact", async () => {
    const existing = makeFact({
      id: "f-blue",
      status: "active",
      text: "User prefers blue",
    });
    const app = buildParseHarness({
      facts: [existing],
      parseFn: async () => ({
        candidate_claim: "User prefers pink",
        classification: "contradict",
        target_fact_id: "f-blue",
        confidence: 0.85,
      }),
    });
    const res = await postParse(app, { text: "其实我喜欢粉色不是蓝色" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      classification: string;
      contradictedFact: { id: string; text: string };
    };
    expect(json.classification).toBe("contradict");
    expect(json.contradictedFact).toEqual({ id: "f-blue", text: "User prefers blue" });
    expect((app as unknown as { _writes: () => number })._writes()).toBe(0);
  });

  test("200 paused when budget gate blocks (parseFn never called)", async () => {
    let parseCalled = false;
    const app = buildParseHarness({
      facts: [],
      parseFn: async () => {
        parseCalled = true;
        return {
          candidate_claim: "x",
          classification: "add",
          target_fact_id: null,
          confidence: 0.5,
        };
      },
      checkSendGate: async () => ({ blocked: "budget", used_pct: 120 }),
    });
    const res = await postParse(app, { text: "记一条" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { paused: boolean; reason: string };
    expect(json.paused).toBe(true);
    expect(json.reason).toBe("budget");
    expect(parseCalled).toBe(false);
  });

  test("200 paused when quiet-hours gate blocks", async () => {
    const app = buildParseHarness({
      facts: [],
      checkSendGate: async () => ({ blocked: "quiet_hours" }),
    });
    const res = await postParse(app, { text: "记一条" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { paused: boolean; reason: string };
    expect(json.paused).toBe(true);
    expect(json.reason).toBe("quiet_hours");
  });

  test("502 when the parse fn throws (honest failure, no write)", async () => {
    const app = buildParseHarness({
      facts: [],
      parseFn: async () => {
        throw new Error("brain timeout");
      },
    });
    const res = await postParse(app, { text: "记一条" });
    expect(res.status).toBe(502);
    expect((app as unknown as { _writes: () => number })._writes()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/facts/:id/kind — re-tag (style/profile)
// ---------------------------------------------------------------------------

describe("POST /api/facts/:id/kind", () => {
  let h: Harness;
  afterEach(() => {
    if (h?.homeBase) rmSync(h.homeBase, { recursive: true, force: true });
  });

  const post = (app: Hono, id: string, body: unknown, secret = SECRET) =>
    app.request(`/api/facts/${id}/kind`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": secret },
      body: JSON.stringify(body),
    });

  test("401 when secret missing/wrong", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1" })]));
    const res = await post(h.app, "f-1", { kind: "style" }, "bad");
    expect(res.status).toBe(401);
    expect(h.writeCount()).toBe(0);
  });

  test("400 on invalid kind", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1" })]));
    const res = await post(h.app, "f-1", { kind: "bogus" });
    expect(res.status).toBe(400);
    expect(h.writeCount()).toBe(0);
  });

  test("404 on unknown id", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1" })]));
    const res = await post(h.app, "nope", { kind: "style" });
    expect(res.status).toBe(404);
    expect(h.writeCount()).toBe(0);
  });

  test("200 persists the new kind", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1", kind: null })]));
    const res = await post(h.app, "f-1", { kind: "profile" });
    expect(res.status).toBe(200);
    expect(h.lastWritten()?.facts.find((f) => f.id === "f-1")?.kind).toBe("profile");
    expect(h.writeCount()).toBe(1);
  });

  test("idempotent — same kind returns 200 but does NOT write", async () => {
    h = buildHarness(makeMemory([makeFact({ id: "f-1", kind: "style" })]));
    const res = await post(h.app, "f-1", { kind: "style" });
    expect(res.status).toBe(200);
    expect(h.writeCount()).toBe(0);
  });
});

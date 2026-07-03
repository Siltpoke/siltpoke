/**
 * Integration tests for GET /api/memory-log — Memory Book
 *
 * Mirrors the facts-route.test.ts harness pattern:
 *   - readMemory is injected (in-memory mock, no disk I/O)
 *   - loadCritiques is injected (in-memory mock)
 *   - homeBase is a temp dir (for future critique-file tests)
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mountMemoryLogRoute } from "../../src/daemon/routes/memory-log";
import type { CoreMemory, Fact } from "../../src/memory/memory";
import type { EventFragment } from "../../src/memory/event-fragment";
import type { MemoryEvent } from "../../src/memory/memory-log";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET = "test-secret-memlog";

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "f-aaaaaaaa",
    text: "user prefers terse responses",
    source_session_id: "s-bbbbbbbb",
    confidence: 0.8,
    status: "active",
    created_at: "2026-06-01T00:00:00.000Z",
    last_seen_at: "2026-06-01T00:00:00.000Z",
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

function makeMemory(facts: Fact[], eventFragments: EventFragment[] = []): CoreMemory {
  return {
    schemaVersion: 2,
    long_term_summary: "",
    learned_rules: [],
    personality_drift: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0 },
    last_consolidated_at: "2026-05-14T00:00:00.000Z",
    consolidation_due_at: "2026-05-21T00:00:00.000Z",
    user_profile: { communication_style: "neutral", goals: [], constraints: [], prefs: {} },
    chat_sessions: [],
    facts,
    event_fragments: eventFragments,
    episodes: [],
  };
}

function makeFragment(overrides: Partial<EventFragment> = {}): EventFragment {
  return {
    id: "ev-route-01",
    text: "shipped the episodic slot",
    created_at: "2026-06-15T00:00:00.000Z",
    occurred_at: "2026-06-14T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z", // far future → active under real now
    sources: [{ kind: "commit", ref: "abc1234def" }],
    entities: [],
    confidence: 0.7,
    learned_from_stream: "commit",
    ...overrides,
  };
}

interface Harness {
  app: Hono;
  homeBase: string;
  setMemory: (m: CoreMemory | null) => void;
}

function buildHarness(initial: CoreMemory | null = null): Harness {
  let stored: CoreMemory | null = initial;
  const homeBase = mkdtempSync(join(tmpdir(), "memory-log-route-"));
  const app = new Hono();
  mountMemoryLogRoute(app, {
    homeBase,
    secret: SECRET,
    readMemory: async () => stored,
    loadCritiques: async () => [],
  });
  return {
    app,
    homeBase,
    setMemory: (m) => {
      stored = m;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/memory-log", () => {
  let h: Harness;

  afterEach(() => {
    if (h?.homeBase) rmSync(h.homeBase, { recursive: true, force: true });
  });

  test("401 when secret header missing", async () => {
    h = buildHarness(makeMemory([]));
    const res = await h.app.request("/api/memory-log");
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("unauthorized");
  });

  test("401 when secret header wrong", async () => {
    h = buildHarness(makeMemory([]));
    const res = await h.app.request("/api/memory-log", {
      headers: { "X-Siltpoke-Secret": "bad-secret" },
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("unauthorized");
  });

  test("200 with empty events when memory is null", async () => {
    h = buildHarness(null);
    const res = await h.app.request("/api/memory-log", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { events: MemoryEvent[] };
    expect(Array.isArray(json.events)).toBe(true);
    expect(json.events).toHaveLength(0);
  });

  test("200 with empty events when memory has no facts", async () => {
    h = buildHarness(makeMemory([]));
    const res = await h.app.request("/api/memory-log", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { events: MemoryEvent[] };
    expect(Array.isArray(json.events)).toBe(true);
    expect(json.events).toHaveLength(0);
  });

  test("200 + seeded fact appears as a semantic event", async () => {
    const fact = makeFact({
      id: "f-seed-01",
      text: "the user prefers short commit messages",
      status: "active",
      created_at: "2026-06-10T10:00:00.000Z",
      save_reason: "explicit preference",
    });
    h = buildHarness(makeMemory([fact]));

    const res = await h.app.request("/api/memory-log", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { events: MemoryEvent[] };
    expect(Array.isArray(json.events)).toBe(true);
    expect(json.events.length).toBeGreaterThan(0);

    const semantic = json.events.find((e) => e.id === "f-seed-01");
    expect(semantic).toBeDefined();
    expect(semantic?.type).toBe("semantic");
    expect(semantic?.text).toBe("the user prefers short commit messages");
    expect(semantic?.status).toBe("active");
    expect(semantic?.why).toBe("explicit preference");
  });

  test("events are sorted newest-first by ts", async () => {
    h = buildHarness(
      makeMemory([
        makeFact({ id: "f-old", created_at: "2026-05-01T00:00:00.000Z" }),
        makeFact({ id: "f-new", created_at: "2026-06-20T00:00:00.000Z" }),
        makeFact({ id: "f-mid", created_at: "2026-06-01T00:00:00.000Z" }),
      ]),
    );
    const res = await h.app.request("/api/memory-log", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { events: MemoryEvent[] };
    const ids = json.events.map((e) => e.id);
    expect(ids).toEqual(["f-new", "f-mid", "f-old"]);
  });

  test("200 + active event fragment appears as an episodic event; expired one is excluded", async () => {
    h = buildHarness(
      makeMemory(
        [],
        [
          makeFragment({ id: "ev-active", expires_at: "2099-01-01T00:00:00.000Z" }),
          makeFragment({ id: "ev-expired", expires_at: "2020-01-01T00:00:00.000Z" }),
        ],
      ),
    );
    const res = await h.app.request("/api/memory-log", {
      headers: { "X-Siltpoke-Secret": SECRET },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { events: MemoryEvent[] };

    const active = json.events.find((e) => e.id === "ev-active");
    expect(active).toBeDefined();
    expect(active?.type).toBe("episodic");
    expect(active?.ts).toBe("2026-06-14T00:00:00.000Z"); // occurred_at
    expect(json.events.find((e) => e.id === "ev-expired")).toBeUndefined();
  });
});

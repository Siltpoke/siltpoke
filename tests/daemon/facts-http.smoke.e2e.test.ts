/**
 * Smoke for the facts HTTP endpoints.
 *
 * Boots a real daemon on a free port, seeds memory with known facts via
 * `writeMemory`, and exercises the full GET / approve / retire sequence
 * against real HTTP — including the auth, idempotency, and error paths.
 *
 * A manual curl checklist mirrors this sequence.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startDaemon,
  stopDaemon,
  type DaemonHandle,
} from "../../src/daemon/server";
import { writeMemory, emptyMemory } from "../../src/memory/memory";
import type { CoreMemory, Fact } from "../../src/memory/memory";

const SECRET = "smoke-secret-deadbeef";

function makeFact(over: Partial<Fact> & Pick<Fact, "id" | "status">): Fact {
  return {
    id: over.id,
    text: `fact ${over.id}`,
    source_session_id: "sess-1",
    confidence: 0.9,
    status: over.status,
    created_at: over.created_at ?? "2026-05-15T00:00:00.000Z",
    last_seen_at: over.last_seen_at ?? "2026-05-15T00:00:00.000Z",
    supersedes: null,
    superseded_by: null,
    pinned: false,
    recall_count: 0,
    retired_reason: over.retired_reason ?? null,
    stability: "durable",
    learned_from: null,
    last_confirmed_at: null,
    expires_at: null,
        save_reason: null,
    invalid_at: null,
    events: [],
  };
}

function makeMemory(facts: Fact[]): CoreMemory {
  return { ...emptyMemory(), facts };
}

async function boot(facts: Fact[]) {
  const dir = mkdtempSync(join(tmpdir(), "facts-http-smoke-"));
  await writeMemory(dir, makeMemory(facts));
  const handle = await startDaemon({
    port: 0,
    hostname: "127.0.0.1",
    lockPath: join(dir, "siltpoked.lock"),
    pidPath: join(dir, "siltpoked.pid"),
    markerDir: join(dir, "markers"),
    secret: SECRET,
    homeBase: dir,
  });
  return { handle, baseUrl: `http://127.0.0.1:${handle.server.port}`, dir };
}

const headers = (override?: Record<string, string>) => ({
  "X-Siltpoke-Secret": SECRET,
  ...override,
});

describe("facts HTTP smoke (real port + real disk)", () => {
  let handle: DaemonHandle | null = null;

  afterEach(async () => {
    if (handle) {
      try {
        await stopDaemon(handle);
      } catch {
        // ignore teardown errors
      }
    }
    handle = null;
  });

  test("auth: 401 without secret + 401 with wrong secret + 200 with right secret", async () => {
    const b = await boot([makeFact({ id: "f-1", status: "pending" })]);
    handle = b.handle;

    const noAuth = await fetch(`${b.baseUrl}/api/facts`);
    expect(noAuth.status).toBe(401);

    const wrongAuth = await fetch(`${b.baseUrl}/api/facts`, {
      headers: { "X-Siltpoke-Secret": "wrong" },
    });
    expect(wrongAuth.status).toBe(401);

    const ok = await fetch(`${b.baseUrl}/api/facts`, { headers: headers() });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { facts: Fact[] };
    expect(body.facts).toHaveLength(1);
    expect(body.facts[0]?.id).toBe("f-1");
  });

  test("GET ?status filter + invalid_status 400", async () => {
    const b = await boot([
      makeFact({ id: "f-pending", status: "pending" }),
      makeFact({ id: "f-active", status: "active" }),
      makeFact({
        id: "f-retired",
        status: "retired",
        retired_reason: "user_rejected",
      }),
    ]);
    handle = b.handle;

    const pending = await fetch(`${b.baseUrl}/api/facts?status=pending`, {
      headers: headers(),
    });
    expect(pending.status).toBe(200);
    const pendingBody = (await pending.json()) as { facts: Fact[] };
    expect(pendingBody.facts).toHaveLength(1);
    expect(pendingBody.facts[0]?.id).toBe("f-pending");

    const bad = await fetch(`${b.baseUrl}/api/facts?status=garbage`, {
      headers: headers(),
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: string };
    expect(badBody.error).toBe("invalid_status");
  });

  test("approve happy path + 409 on second approve (strict) + 404 on unknown id", async () => {
    const b = await boot([makeFact({ id: "f-1", status: "pending" })]);
    handle = b.handle;

    const first = await fetch(`${b.baseUrl}/api/facts/f-1/approve`, {
      method: "POST",
      headers: headers(),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { fact: Fact };
    expect(firstBody.fact.status).toBe("active");

    const second = await fetch(`${b.baseUrl}/api/facts/f-1/approve`, {
      method: "POST",
      headers: headers(),
    });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as {
      error: string;
      current_status: string;
    };
    expect(secondBody.error).toBe("not_pending");
    expect(secondBody.current_status).toBe("active");

    const missing = await fetch(`${b.baseUrl}/api/facts/nope/approve`, {
      method: "POST",
      headers: headers(),
    });
    expect(missing.status).toBe(404);
  });

  test("retire happy path (pending→retired) + idempotent 200 on already-retired", async () => {
    const b = await boot([makeFact({ id: "f-1", status: "pending" })]);
    handle = b.handle;

    const first = await fetch(`${b.baseUrl}/api/facts/f-1/retire`, {
      method: "POST",
      headers: headers(),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { fact: Fact };
    expect(firstBody.fact.status).toBe("retired");
    expect(firstBody.fact.retired_reason).toBe("user_rejected");

    // Idempotent second retire — still 200, same retired_reason
    const second = await fetch(`${b.baseUrl}/api/facts/f-1/retire`, {
      method: "POST",
      headers: headers(),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { fact: Fact };
    expect(secondBody.fact.status).toBe("retired");
    expect(secondBody.fact.retired_reason).toBe("user_rejected");
  });

  test("retire active → retired (covers `*` source state)", async () => {
    const b = await boot([makeFact({ id: "f-1", status: "active" })]);
    handle = b.handle;

    const r = await fetch(`${b.baseUrl}/api/facts/f-1/retire`, {
      method: "POST",
      headers: headers(),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { fact: Fact };
    expect(body.fact.status).toBe("retired");
    expect(body.fact.retired_reason).toBe("user_rejected");
  });

  test("GET sort desc by created_at (newest first)", async () => {
    const b = await boot([
      makeFact({
        id: "f-old",
        status: "active",
        created_at: "2026-04-01T00:00:00.000Z",
      }),
      makeFact({
        id: "f-new",
        status: "active",
        created_at: "2026-05-15T00:00:00.000Z",
      }),
      makeFact({
        id: "f-mid",
        status: "active",
        created_at: "2026-05-01T00:00:00.000Z",
      }),
    ]);
    handle = b.handle;

    const r = await fetch(`${b.baseUrl}/api/facts`, { headers: headers() });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { facts: Fact[] };
    expect(body.facts.map((f) => f.id)).toEqual(["f-new", "f-mid", "f-old"]);
  });
});

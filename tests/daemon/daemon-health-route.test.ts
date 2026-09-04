/**
 * API route tests — GET /api/daemon-health.
 *
 * Stubs the boot-build + git-probe seam via deps so the test never shells out.
 * Asserts the envelope shape + each state ("current" / "behind" / "unknown")
 * maps correctly through the route.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { BootBuild, GitProbe } from "../../src/daemon/build-state";
import { mountDaemonHealthRoute } from "../../src/daemon/routes/daemon-health";

interface HealthData {
  bootSha: string | null;
  bootTime: string | null;
  headSha: string | null;
  commitsBehind: number | null;
  state: "current" | "behind" | "unknown";
  pid: number;
  startedAt: string;
}

/** Deterministic stand-in for the serving process's identity. */
const IDENTITY = { pid: 4242, startedAt: "2026-06-13T09:00:00.000Z" };

function buildApp(boot: BootBuild, probe: Partial<GitProbe>): Hono {
  const app = new Hono();
  const fullProbe: GitProbe = {
    headSha: () => null,
    isAncestor: () => null,
    countBetween: () => null,
    ...probe,
  };
  mountDaemonHealthRoute(app, { readBootBuild: () => boot, gitProbe: fullProbe, processIdentity: () => IDENTITY });
  return app;
}

async function get(app: Hono): Promise<{ status: number; data: HealthData; success: boolean }> {
  const res = await app.request("/api/daemon-health");
  const json = (await res.json()) as { success: boolean; data: HealthData };
  return { status: res.status, data: json.data, success: json.success };
}

describe("GET /api/daemon-health", () => {
  test("current — bootSha === headSha → state current, commitsBehind 0", async () => {
    const app = buildApp(
      { bootSha: "abc", bootTime: "2026-06-13T00:00:00Z" },
      { headSha: () => "abc" },
    );
    const { status, success, data } = await get(app);
    expect(status).toBe(200);
    expect(success).toBe(true);
    expect(data).toEqual({
      bootSha: "abc",
      bootTime: "2026-06-13T00:00:00Z",
      headSha: "abc",
      commitsBehind: 0,
      state: "current",
      // Process identity is deliberately separate from bootSha/bootTime: two
      // processes booted from the same commit report identical boot fields, so
      // only these can answer "is this still the same process?" — the question
      // `siltpoked restart` has to answer to tell a real restart from a no-op.
      pid: IDENTITY.pid,
      startedAt: IDENTITY.startedAt,
    });
  });

  test("behind — ancestor with N between → state behind, commitsBehind N", async () => {
    const app = buildApp(
      { bootSha: "boot", bootTime: "2026-06-12T00:00:00Z" },
      { headSha: () => "head", isAncestor: () => true, countBetween: () => 5 },
    );
    const { data } = await get(app);
    expect(data.state).toBe("behind");
    expect(data.commitsBehind).toBe(5);
    expect(data.bootSha).toBe("boot");
    expect(data.headSha).toBe("head");
  });

  test("unknown — non-ancestor (force-push) → state unknown, commitsBehind null", async () => {
    const app = buildApp(
      { bootSha: "boot", bootTime: null },
      { headSha: () => "head", isAncestor: () => false },
    );
    const { data } = await get(app);
    expect(data.state).toBe("unknown");
    expect(data.commitsBehind).toBeNull();
  });

  test("unknown — non-git checkout (bootSha null) → state unknown, still 200", async () => {
    const app = buildApp(
      { bootSha: null, bootTime: null },
      { headSha: () => "head" },
    );
    const { status, data } = await get(app);
    expect(status).toBe(200);
    expect(data.bootSha).toBeNull();
    expect(data.state).toBe("unknown");
    expect(data.commitsBehind).toBeNull();
  });

  test("unknown — request-time git error (headSha throws) → 200, state unknown", async () => {
    const app = buildApp(
      { bootSha: "boot", bootTime: null },
      {
        headSha: () => {
          throw new Error("git exploded");
        },
      },
    );
    const { status, data } = await get(app);
    expect(status).toBe(200);
    expect(data.headSha).toBeNull();
    expect(data.state).toBe("unknown");
    expect(data.commitsBehind).toBeNull();
  });

  test("unknown — countBetween throws mid-derivation → 200, state unknown (not 500)", async () => {
    const app = buildApp(
      { bootSha: "boot", bootTime: null },
      {
        headSha: () => "head",
        isAncestor: () => true,
        countBetween: () => {
          throw new Error("git rev-list exploded");
        },
      },
    );
    const { status, data } = await get(app);
    expect(status).toBe(200);
    expect(data.state).toBe("unknown");
    expect(data.commitsBehind).toBeNull();
  });
});

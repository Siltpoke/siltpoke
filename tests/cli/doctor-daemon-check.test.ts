/**
 * Doctor daemon-staleness check.
 *
 * Tests the pure state→row mapping for all 4 cases (current / behind /
 * unknown / daemon-down) plus the async fetch wrapper's graceful-skip on
 * fetch failure / non-200 / malformed payload. No live daemon — fetch is
 * stubbed via the injectable fetchFn. Implementation:
 * src/cli/doctor-daemon-check.ts.
 */
import { test, expect, describe } from "bun:test";
import {
  mapDaemonHealthToCheck,
  checkDaemonStaleness,
  type DaemonHealth,
} from "../../src/cli/doctor-daemon-check";

// Build a Response stub the wrapper consumes (res.ok + res.json()).
function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

// ── pure mapping: 4 states ──────────────────────────────────────────────────

describe("doctor daemon-staleness — state→row mapping", () => {
  test("current → ✓ pass with up-to-date + short SHA (first 8 chars)", () => {
    const health: DaemonHealth = {
      bootSha: "0e8e2e1abcdef1234567890",
      bootTime: "2026-06-13T09:00:00.000Z",
      headSha: "0e8e2e1abcdef1234567890",
      commitsBehind: 0,
      state: "current",
    };
    const r = mapDaemonHealthToCheck(health);
    expect(r.pass).toBe(true);
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("daemon up-to-date (0e8e2e1a)");
  });

  test("behind → ⚠ warn with N commits behind + restart (pass stays true — warn-only A7)", () => {
    const health: DaemonHealth = {
      bootSha: "aaaaaaa1111",
      bootTime: "2026-06-13T04:00:00.000Z",
      headSha: "bbbbbbb2222",
      commitsBehind: 3,
      state: "behind",
    };
    const r = mapDaemonHealthToCheck(health);
    expect(r.pass).toBe(true);
    expect(r.status).toBe("warn");
    expect(r.detail).toBe("daemon 3 commits behind — restart");
  });

  test("behind with non-numeric commitsBehind → '?' (never renders 'null commits')", () => {
    const health = {
      bootSha: "aaa",
      bootTime: null,
      headSha: "bbb",
      commitsBehind: null,
      state: "behind",
    } as unknown as DaemonHealth;
    const r = mapDaemonHealthToCheck(health);
    expect(r.detail).toBe("daemon ? commits behind — restart");
    expect(r.detail).not.toContain("null");
  });

  test("unknown → ◦ info neutral 'version unknown' line, never a number (A6)", () => {
    const health: DaemonHealth = {
      bootSha: null,
      bootTime: null,
      headSha: null,
      commitsBehind: null,
      state: "unknown",
    };
    const r = mapDaemonHealthToCheck(health);
    expect(r.pass).toBe(true);
    expect(r.status).toBe("info");
    expect(r.detail).toBe("daemon build version unknown (not a git checkout)");
    expect(r.detail).not.toMatch(/\d/);
  });

  test("daemon down (health === null) → ◦ info 'skipped (daemon down)'", () => {
    const r = mapDaemonHealthToCheck(null);
    expect(r.pass).toBe(true);
    expect(r.status).toBe("info");
    expect(r.detail).toBe("skipped (daemon down)");
  });
});

// ── async fetch wrapper: graceful skip ──────────────────────────────────────

describe("doctor daemon-staleness — fetch wrapper", () => {
  test("happy path: parses envelope and maps state", async () => {
    const r = await checkDaemonStaleness({
      fetchFn: async () =>
        jsonResponse({
          success: true,
          data: {
            bootSha: "1234567890abcdef",
            bootTime: null,
            headSha: "1234567890abcdef",
            commitsBehind: 0,
            state: "current",
          },
        }),
    });
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("daemon up-to-date (12345678)");
  });

  test("behind state flows through the wrapper to a ⚠ row", async () => {
    const r = await checkDaemonStaleness({
      fetchFn: async () =>
        jsonResponse({
          success: true,
          data: { bootSha: "x", bootTime: null, headSha: "y", commitsBehind: 5, state: "behind" },
        }),
    });
    expect(r.status).toBe("warn");
    expect(r.detail).toBe("daemon 5 commits behind — restart");
  });

  test("fetch throws (connection refused) → skipped (daemon down)", async () => {
    const r = await checkDaemonStaleness({
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(r.detail).toBe("skipped (daemon down)");
    expect(r.status).toBe("info");
  });

  test("non-200 response → skipped (daemon down)", async () => {
    const r = await checkDaemonStaleness({
      fetchFn: async () => jsonResponse({ error: "boom" }, false),
    });
    expect(r.detail).toBe("skipped (daemon down)");
  });

  test("malformed payload (missing data.state) → skipped (daemon down)", async () => {
    const r = await checkDaemonStaleness({
      fetchFn: async () => jsonResponse({ success: true, data: {} }),
    });
    expect(r.detail).toBe("skipped (daemon down)");
  });

  test("success:false envelope → skipped (daemon down)", async () => {
    const r = await checkDaemonStaleness({
      fetchFn: async () =>
        jsonResponse({ success: false, data: { state: "current", bootSha: "z" } }),
    });
    expect(r.detail).toBe("skipped (daemon down)");
  });

  test("out-of-contract state string → skipped (daemon down), not trusted/mis-rendered", async () => {
    const r = await checkDaemonStaleness({
      fetchFn: async () =>
        jsonResponse({ success: true, data: { state: "broken_state", bootSha: "z", commitsBehind: 0 } }),
    });
    expect(r.detail).toBe("skipped (daemon down)");
  });
});

// ── shortSha null-bootSha fallback (unreachable for "current" in practice) ───

describe("doctor daemon-staleness — null bootSha label", () => {
  test("current with null bootSha → '(no sha)' label, never 'unknown'", () => {
    const health: DaemonHealth = {
      bootSha: null,
      bootTime: null,
      headSha: null,
      commitsBehind: 0,
      state: "current",
    };
    const r = mapDaemonHealthToCheck(health);
    expect(r.detail).toBe("daemon up-to-date ((no sha))");
    expect(r.detail).not.toContain("unknown");
  });
});

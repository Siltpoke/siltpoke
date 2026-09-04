/**
 * Doctor daemon checks (staleness / alive / autostart).
 *
 * Staleness: pure state→row mapping for all 4 cases (current / behind /
 * unknown / daemon-down) plus the async fetch wrapper's graceful-skip on
 * fetch failure / non-200 / malformed payload. No live daemon — fetch is
 * stubbed via the injectable fetchFn.
 *
 * Alive (track #6 T5, AC11; opt-in semantics from the daemon-opt-in slice):
 * /api/ping probe — up → pass; down + daemon.enabled=false (the default) →
 * ◦ info "daemon: off (opt-in...)", never fails; down + daemon.enabled=true
 * → ✗ genuine fail (the user opted in and it should be reachable).
 *
 * Autostart (track #6 T5, AC11): plist/unit presence — info-only in every
 * state (installed / not installed / unsupported platform), never fails.
 *
 * Implementation: src/cli/doctor-daemon-check.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAutostart,
  checkDaemonAlive,
  checkDaemonStaleness,
  type DaemonHealth,
  mapDaemonHealthToCheck,
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

// ── daemon-alive check (/api/ping probe, warn-only) ─────────────────────────

describe("doctor daemon-alive — /api/ping probe", () => {
  const OFF_DETAIL = "daemon: off (opt-in — open /siltpoke-dashboard to enable)";
  const ENABLED_UNREACHABLE_DETAIL =
    "daemon.enabled is true but /api/ping is unreachable — try /siltpoke-restart-daemon";

  test("daemon up (200 on /api/ping) → ✓ pass, no detail", async () => {
    const r = await checkDaemonAlive({
      fetchFn: async () => ({ ok: true } as Response),
    });
    expect(r.name).toBe("daemon alive (/api/ping)");
    expect(r.pass).toBe(true);
    expect(r.status).toBe("pass");
    expect(r.detail).toBeNull();
  });

  test("down + daemon.enabled=false (default) → ◦ info 'daemon: off (opt-in...)', pass stays true", async () => {
    const r = await checkDaemonAlive({
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
      loadDaemonConfigFn: async () => ({ enabled: false }),
    });
    expect(r.pass).toBe(true);
    expect(r.status).toBe("info");
    expect(r.detail).toBe(OFF_DETAIL);
  });

  test("non-200 response + daemon.enabled=false → ◦ info 'daemon: off (opt-in...)' (never a red fail)", async () => {
    const r = await checkDaemonAlive({
      fetchFn: async () => ({ ok: false } as Response),
      loadDaemonConfigFn: async () => ({ enabled: false }),
    });
    expect(r.pass).toBe(true);
    expect(r.status).toBe("info");
    expect(r.detail).toBe(OFF_DETAIL);
  });

  test("down + daemon.enabled=true → ✗ genuine fail (opted in but unreachable)", async () => {
    const r = await checkDaemonAlive({
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
      loadDaemonConfigFn: async () => ({ enabled: true }),
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toBe(ENABLED_UNREACHABLE_DETAIL);
  });

  test("probes the injectable ping URL", async () => {
    const seen: string[] = [];
    await checkDaemonAlive({
      daemonPingUrl: "http://127.0.0.1:1/api/ping",
      fetchFn: async (input) => {
        seen.push(String(input));
        return { ok: true } as Response;
      },
    });
    expect(seen).toEqual(["http://127.0.0.1:1/api/ping"]);
  });
});

// ── autostart check (plist/unit presence, info-only) ────────────────────────

describe("doctor autostart — plist/unit presence", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "siltpoke-doctor-autostart-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const NOT_INSTALLED_DETAIL = "not installed — run `/siltpoke-setup`";

  test("darwin, plist present → ✓ pass 'installed'", () => {
    const plist = join(tmp, "io.siltpoke.daemon.plist");
    writeFileSync(plist, "<plist/>");
    const r = checkAutostart({ platform: "darwin", autostartPath: plist });
    expect(r.name).toBe("daemon autostart configured");
    expect(r.pass).toBe(true);
    expect(r.status).toBe("pass");
    expect(r.detail).toBe(`installed (${plist})`);
  });

  test("darwin, plist absent → ◦ info 'not installed' with setup hint (never fails)", () => {
    const r = checkAutostart({
      platform: "darwin",
      autostartPath: join(tmp, "io.siltpoke.daemon.plist"),
    });
    expect(r.pass).toBe(true);
    expect(r.status).toBe("info");
    expect(r.detail).toBe(NOT_INSTALLED_DETAIL);
  });

  test("linux, unit present → ✓ pass 'installed'", () => {
    const unit = join(tmp, "siltpoked.service");
    writeFileSync(unit, "[Unit]");
    const r = checkAutostart({ platform: "linux", autostartPath: unit });
    expect(r.pass).toBe(true);
    expect(r.status).toBe("pass");
    expect(r.detail).toBe(`installed (${unit})`);
  });

  test("linux, unit absent → ◦ info 'not installed'", () => {
    const r = checkAutostart({
      platform: "linux",
      autostartPath: join(tmp, "siltpoked.service"),
    });
    expect(r.pass).toBe(true);
    expect(r.status).toBe("info");
    expect(r.detail).toBe(NOT_INSTALLED_DETAIL);
  });

  test("unsupported platform (win32) → ◦ info skip note", () => {
    const r = checkAutostart({ platform: "win32" });
    expect(r.pass).toBe(true);
    expect(r.status).toBe("info");
    expect(r.detail).toBe("skipped (autostart unsupported on win32)");
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

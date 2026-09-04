// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Boot-level proof that trace retention actually runs.
 *
 * `startDaemon` armed retention as `setInterval(..., 24h)` with no leading
 * call, so the first eviction was due a full day after boot — and the timer
 * restarts from zero on every daemon restart. Measured on the author's machine
 * 2026-08-23: the oldest span file in `~/.siltpoke/traces` was dated 07-06,
 * **48 days** old against a `retentionDays: 30` policy, and `spillover/` had
 * grown to 1.8 GB across 84 day-directories reaching back to 2026-05-21.
 * Nothing had ever been evicted, because the sweep had never once fired.
 *
 * Asserting on the interval's existence proves nothing about that — a timer
 * that never reaches its deadline is indistinguishable from a correct one at
 * the call site. So this boots the real daemon against a real directory and
 * looks at the disk.
 *
 * The `resetNavAvailability()` teardown is required of every file that boots a
 * daemon — see the header of `tests/daemon/progress-boot-wiring.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonHandle, startDaemon, stopDaemon } from "../../src/daemon/server";
import { resetNavAvailability } from "../../src/web/routes/nav";

/** Subtract N days from today → "YYYY-MM-DD". */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

describe("daemon boot — trace retention fires immediately, not 24h later", () => {
  let handle: DaemonHandle | null = null;

  afterEach(async () => {
    if (handle) {
      try {
        await stopDaemon(handle);
      } catch {}
    }
    handle = null;
    resetNavAvailability();
  });

  /** Collect everything written to console.error while `fn` runs. */
  async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await fn();
    } finally {
      console.error = original;
    }
    return lines;
  }

  async function boot(homeBase: string): Promise<void> {
    handle = await startDaemon({
      port: 0,
      hostname: "127.0.0.1",
      lockPath: join(homeBase, "siltpoked.lock"),
      pidPath: join(homeBase, "siltpoked.pid"),
      markerDir: join(homeBase, "markers"),
      secret: "test-secret",
      homeBase,
    });
  }

  test("an over-age span file and its spillover day are gone once boot returns", async () => {
    const home = mkdtempSync(join(tmpdir(), "retention-boot-"));
    const traces = join(home, "traces");
    mkdirSync(traces, { recursive: true });

    const staleJsonl = join(traces, `${daysAgo(45)}.jsonl`);
    writeFileSync(staleJsonl, "{}\n", "utf8");

    const staleSpillDay = join(traces, "spillover", daysAgo(45));
    mkdirSync(staleSpillDay, { recursive: true });
    const staleSpill = join(staleSpillDay, "trace-a-span-a-output.json");
    writeFileSync(staleSpill, "x".repeat(1000), "utf8");

    const freshJsonl = join(traces, `${daysAgo(1)}.jsonl`);
    writeFileSync(freshJsonl, "{}\n", "utf8");

    await boot(home);

    expect(existsSync(staleJsonl)).toBe(false);
    expect(existsSync(staleSpill)).toBe(false);
    expect(existsSync(freshJsonl)).toBe(true);
  });

  test("the policy it armed with is announced, and the size cap is off unless configured", async () => {
    // C2 + I1. On 2026-08-23 `retention_days: 120` was set to hold a research
    // corpus open, and ~1.4 GB inside that window was deleted anyway by a size
    // cap that defaulted to 500 MB — a number nobody had chosen — and nothing
    // said so. Two separate silences: the policy was unknowable, and the
    // deletion was unknowable.
    //
    // Asserting on the announcement rather than on surviving files is
    // deliberate: any fixture small enough for a test is also far under 500 MB,
    // so "nothing was deleted" would have been green under the old default too.
    // The log line names the cap, so it can tell `off` from `500`.
    const home = mkdtempSync(join(tmpdir(), "retention-boot-policy-"));
    mkdirSync(join(home, "traces"), { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ traces: { retention_days: 120 } }),
      "utf8",
    );

    const lines = await captureStderr(() => boot(home));
    const armed = lines.find((l) => l.includes("trace retention"));

    expect(armed).toBeDefined();
    expect(armed).toContain("120");
    expect(armed?.toLowerCase()).toContain("off");
    expect(armed).not.toContain("500");
  });

  test("an eviction is always reported — never silent", async () => {
    const home = mkdtempSync(join(tmpdir(), "retention-boot-loud-"));
    const traces = join(home, "traces");
    mkdirSync(traces, { recursive: true });
    writeFileSync(join(traces, `${daysAgo(45)}.jsonl`), "x".repeat(4096), "utf8");

    const lines = await captureStderr(() => boot(home));
    const evicted = lines.find((l) => l.includes("evicted"));

    expect(evicted).toBeDefined();
    expect(evicted).toContain("1");
  });

  test("a traces path that cannot be read does not stop the daemon booting", async () => {
    // I4. `existsSync` is true for a plain file, so the sweep threw ENOTDIR —
    // which at boot means no daemon, a stale lock and pidfile, and a launchd
    // crash-flap. A trace dir that cannot be read is a reason to evict nothing.
    const home = mkdtempSync(join(tmpdir(), "retention-boot-enotdir-"));
    writeFileSync(join(home, "traces"), "i am a file, not a directory", "utf8");

    await boot(home);

    expect(handle).not.toBeNull();
    expect(handle?.server.port).toBeGreaterThan(0);
  });

  test("config.json can hold retention open past the default 30 days", async () => {
    const home = mkdtempSync(join(tmpdir(), "retention-boot-cfg-"));
    const traces = join(home, "traces");
    mkdirSync(traces, { recursive: true });

    // 45 days old: evicted under the default, kept under this config.
    const oldJsonl = join(traces, `${daysAgo(45)}.jsonl`);
    writeFileSync(oldJsonl, "{}\n", "utf8");

    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ traces: { retention_days: 120 } }),
      "utf8",
    );

    await boot(home);

    expect(existsSync(oldJsonl)).toBe(true);
  });
});

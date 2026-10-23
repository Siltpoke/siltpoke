/**
 * The Change model window names days in this machine's time,
 * checked in three time zones in child processes — a test
 * run only where the machine happens to be (CI runs in UTC) cannot see a UTC
 * day slipping in ([5]).
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const PROBE = join(import.meta.dir, "fixtures", "model-window-tz-probe.ts");

for (const tz of ["America/Los_Angeles", "Asia/Shanghai", "UTC"]) {
  test(`a list saved at 11:30 pm or 0:30 am on Oct 15 says Oct 15 — TZ=${tz}`, () => {
    const r = Bun.spawnSync([process.execPath, PROBE], { env: { ...process.env, TZ: tz } });
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString()) as Array<{ savedOn: string; qoder: string }>;
    expect(out).toHaveLength(2);
    for (const o of out) {
      expect(o.savedOn).toBe("2026-10-15");
      expect(o.qoder).toBe("qoder — timed out; showing the list saved 2026-10-15");
    }
  });
}

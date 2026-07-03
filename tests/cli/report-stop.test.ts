import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { stopReport } from "../../src/cli/report-stop";

describe("stopReport", () => {
  let dir: string;
  let bgProc: ReturnType<typeof Bun.spawn> | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rstop-"));
  });

  afterEach(() => {
    if (bgProc) {
      try {
        bgProc.kill();
      } catch {}
    }
    bgProc = null;
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns error when no pidfile exists", () => {
    const r = stopReport([join(dir, "siltpoked.pid"), join(dir, "report.pid")]);
    expect(r.killed).toBe(false);
    expect(r.source).toBeNull();
    expect(r.error).toContain("no pidfile");
  });

  test("prefers siltpoked.pid over report.pid when both exist", () => {
    // Spawn a sleeping child process we can SIGTERM.
    bgProc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const pid = bgProc.pid!;
    writeFileSync(join(dir, "siltpoked.pid"), String(pid));
    writeFileSync(join(dir, "report.pid"), "999999");
    const r = stopReport([join(dir, "siltpoked.pid"), join(dir, "report.pid")]);
    expect(r.killed).toBe(true);
    expect(r.pid).toBe(pid);
    expect(r.source).toContain("siltpoked.pid");
  });

  test("falls back to report.pid when siltpoked.pid is missing", () => {
    bgProc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const pid = bgProc.pid!;
    writeFileSync(join(dir, "report.pid"), String(pid));
    const r = stopReport([join(dir, "siltpoked.pid"), join(dir, "report.pid")]);
    expect(r.killed).toBe(true);
    expect(r.pid).toBe(pid);
    expect(r.source).toContain("report.pid");
  });

  test("returns error if pidfile contains junk", () => {
    writeFileSync(join(dir, "siltpoked.pid"), "not-a-number");
    const r = stopReport([join(dir, "siltpoked.pid"), join(dir, "report.pid")]);
    expect(r.killed).toBe(false);
    expect(r.error).toContain("empty or invalid");
  });
});

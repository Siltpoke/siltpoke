import { describe, test, expect, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRetention } from "../../src/observability/retention";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `siltpoke-retention-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a fake JSONL file with given content (for size control). */
function writeFile(dir: string, date: string, content = "x".repeat(1000)): string {
  const path = join(dir, `${date}.jsonl`);
  writeFileSync(path, content, "utf8");
  return path;
}

/** Subtract N days from today → "YYYY-MM-DD" string. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  dirs.length = 0;
});

describe("runRetention", () => {
  test("deletes 3 old files, keeps 2 recent files", () => {
    const dir = makeTmpDir();
    dirs.push(dir);

    // 3 old files (31, 40, 60 days ago)
    const old1 = writeFile(dir, daysAgo(31));
    const old2 = writeFile(dir, daysAgo(40));
    const old3 = writeFile(dir, daysAgo(60));
    // 2 new files (1, 5 days ago)
    const new1 = writeFile(dir, daysAgo(1));
    const new2 = writeFile(dir, daysAgo(5));

    const result = runRetention({ dir, retentionDays: 30, maxStorageMB: 500 });

    expect(result.deletedFiles).toBe(3);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(existsSync(old1)).toBe(false);
    expect(existsSync(old2)).toBe(false);
    expect(existsSync(old3)).toBe(false);
    expect(existsSync(new1)).toBe(true);
    expect(existsSync(new2)).toBe(true);
  });

  test("size cap evicts oldest files until under limit", () => {
    const dir = makeTmpDir();
    dirs.push(dir);

    // 3 recent files, each 400KB — total 1.2MB; cap is 1MB
    const f1 = writeFile(dir, daysAgo(3), "a".repeat(400_000));
    const _f2 = writeFile(dir, daysAgo(2), "b".repeat(400_000));
    const f3 = writeFile(dir, daysAgo(1), "c".repeat(400_000));

    const result = runRetention({ dir, retentionDays: 30, maxStorageMB: 1 });

    // Should delete at least 1 file (oldest) to get under 1MB
    expect(result.deletedFiles).toBeGreaterThanOrEqual(1);
    // Oldest file (f1) should be gone
    expect(existsSync(f1)).toBe(false);
    // Newest file should survive
    expect(existsSync(f3)).toBe(true);
  });

  test("returns zeros when dir does not exist", () => {
    const result = runRetention({ dir: "/tmp/nonexistent-siltpoke-test-dir", retentionDays: 30 });
    expect(result.deletedFiles).toBe(0);
    expect(result.freedBytes).toBe(0);
  });

  test("does not throw when the traces path is a file, not a directory", () => {
    // I4 — `existsSync` returns true for a file, so the unguarded
    // `readdirSync` threw ENOTDIR. Harmless while the sweep never ran; once it
    // runs synchronously at daemon boot, a throw here means the daemon does
    // not start, leaves a stale lock + pidfile, and crash-flaps under launchd.
    const parent = makeTmpDir();
    dirs.push(parent);
    const notADir = join(parent, "traces");
    writeFileSync(notADir, "i am a file", "utf8");

    const result = runRetention({ dir: notADir, retentionDays: 30, maxStorageMB: 500 });
    expect(result).toEqual({ deletedFiles: 0, freedBytes: 0 });
  });

  test("does not throw when the traces directory is unreadable", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    writeFile(dir, daysAgo(45));
    chmodSync(dir, 0o000);
    try {
      const result = runRetention({ dir, retentionDays: 30, maxStorageMB: 500 });
      expect(result.deletedFiles).toBe(0);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test("no deletions when all files are recent", () => {
    const dir = makeTmpDir();
    dirs.push(dir);

    writeFile(dir, daysAgo(1));
    writeFile(dir, daysAgo(2));

    const result = runRetention({ dir, retentionDays: 30, maxStorageMB: 500 });
    expect(result.deletedFiles).toBe(0);
    expect(result.freedBytes).toBe(0);
  });
});

/**
 * Spillover eviction.
 *
 * `Tracer.writeSpillover` parks any setInput/setOutput payload over 8 KB in
 * `traces/spillover/<YYYY-MM-DD>/<trace>-<span>-<role>.json`. Retention only
 * ever matched `^\d{4}-\d{2}-\d{2}\.jsonl$` at the top level, so that whole
 * subtree was invisible to both the age cutoff and the size cap. Measured on
 * this machine 2026-08-23: `traces/` held 2.0 GB, of which `spillover/` was
 * 1.8 GB across 84 day-directories reaching back to 2026-05-21 — nothing had
 * ever been evicted. Both halves are asserted here because either one alone
 * still lets the subtree grow without bound.
 */
describe("runRetention — spillover subtree", () => {
  /** Write a spillover payload under `spillover/<date>/`, return its path. */
  function writeSpill(dir: string, date: string, name: string, content = "x".repeat(1000)): string {
    const dayDir = join(dir, "spillover", date);
    mkdirSync(dayDir, { recursive: true });
    const path = join(dayDir, name);
    writeFileSync(path, content, "utf8");
    return path;
  }

  test("age cutoff evicts spillover days older than retentionDays", () => {
    const dir = makeTmpDir();
    dirs.push(dir);

    const oldSpill = writeSpill(dir, daysAgo(45), "trace-a-span-a-output.json");
    const newSpill = writeSpill(dir, daysAgo(2), "trace-b-span-b-output.json");

    const result = runRetention({ dir, retentionDays: 30, maxStorageMB: 500 });

    expect(existsSync(oldSpill)).toBe(false);
    expect(existsSync(newSpill)).toBe(true);
    expect(result.deletedFiles).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(0);
  });

  test("size cap counts spillover bytes, not just JSONL bytes", () => {
    const dir = makeTmpDir();
    dirs.push(dir);

    // 100 KB of JSONL — on its own, far under a 1 MB cap.
    writeFile(dir, daysAgo(1), "j".repeat(100_000));
    // 1.2 MB of spillover across two recent days — over the cap by itself.
    const oldestSpill = writeSpill(dir, daysAgo(3), "trace-a-span-a-output.json", "a".repeat(600_000));
    const newestSpill = writeSpill(dir, daysAgo(2), "trace-b-span-b-output.json", "b".repeat(600_000));

    const result = runRetention({ dir, retentionDays: 30, maxStorageMB: 1 });

    // Nothing is past the age cutoff, so eviction can only come from the cap
    // having seen the spillover bytes at all.
    expect(result.deletedFiles).toBeGreaterThanOrEqual(1);
    expect(existsSync(oldestSpill)).toBe(false);
    expect(existsSync(newestSpill)).toBe(true);
  });

  test("an emptied spillover day-directory is removed, not left behind", () => {
    const dir = makeTmpDir();
    dirs.push(dir);

    const oldDay = join(dir, "spillover", daysAgo(45));
    writeSpill(dir, daysAgo(45), "trace-a-span-a-output.json");

    runRetention({ dir, retentionDays: 30, maxStorageMB: 500 });

    expect(existsSync(oldDay)).toBe(false);
  });

  test("within one day the cap evicts spillover before the span file", () => {
    const dir = makeTmpDir();
    dirs.push(dir);

    // One day, two units: a small span file and a big spillover payload.
    // 1 MB cap; dropping the spillover alone gets under it.
    const jsonl = writeFile(dir, daysAgo(3), "j".repeat(50_000));
    const spill = writeSpill(dir, daysAgo(3), "trace-a-span-a-output.json", "a".repeat(1_200_000));

    runRetention({ dir, retentionDays: 30, maxStorageMB: 1 });

    expect(existsSync(spill)).toBe(false);
    expect(existsSync(jsonl)).toBe(true);
  });

  test("omitting maxStorageMB disables size eviction — same tree, cap set, evicts", () => {
    // C2 — the 2026-08-23 shape. `retention_days: 120` was set to hold a
    // research corpus open; `max_storage_mb` was never set, silently defaulted
    // to 500, and evicted ~1.4 GB inside that window.
    //
    // The assertion is a CONTRAST, not a single run: an identical tree is swept
    // twice, differing only in whether a cap is passed. Asserting "nothing was
    // deleted" on its own would pass under the old 500 MB default too — the
    // fixture is under 2 MB, nowhere near it — so it would have been green
    // before the fix and green after, proving nothing.
    function seed(): { dir: string; jsonl: string; spill: string } {
      const dir = makeTmpDir();
      dirs.push(dir);
      const jsonl = writeFile(dir, daysAgo(3), "j".repeat(600_000));
      const spill = writeSpill(dir, daysAgo(3), "t-a-output.json", "a".repeat(1_200_000));
      return { dir, jsonl, spill };
    }

    const uncapped = seed();
    const uncappedResult = runRetention({ dir: uncapped.dir, retentionDays: 120 });

    const capped = seed();
    const cappedResult = runRetention({ dir: capped.dir, retentionDays: 120, maxStorageMB: 1 });

    expect(uncappedResult.deletedFiles).toBe(0);
    expect(existsSync(uncapped.jsonl)).toBe(true);
    expect(existsSync(uncapped.spill)).toBe(true);

    // Same tree, same age policy, cap set → the cap does fire. This is what
    // makes the first half a real assertion rather than a fixture too small to
    // reach any limit.
    expect(cappedResult.deletedFiles).toBeGreaterThan(0);
    expect(existsSync(capped.spill)).toBe(false);
  });

  test("a non-date entry under spillover/ is left alone", () => {
    const dir = makeTmpDir();
    dirs.push(dir);

    const spilloverDir = join(dir, "spillover");
    mkdirSync(spilloverDir, { recursive: true });
    const stray = join(spilloverDir, "README.txt");
    writeFileSync(stray, "not a day directory", "utf8");

    const result = runRetention({ dir, retentionDays: 30, maxStorageMB: 500 });

    expect(existsSync(stray)).toBe(true);
    expect(result.deletedFiles).toBe(0);
  });
});

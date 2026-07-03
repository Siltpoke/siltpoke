import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

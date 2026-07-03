import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256, getCached, setCached } from "../../src/repo-memory/cache.ts";

describe("cache", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "siltpoke-cache-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("sha256 is deterministic for same input", () => {
    const h1 = sha256("hello world");
    const h2 = sha256("hello world");
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  test("sha256 differs for different inputs", () => {
    expect(sha256("foo")).not.toBe(sha256("bar"));
  });

  test("getCached returns null for missing hash", async () => {
    const result = await getCached(tmp, "nonexistent-hash");
    expect(result).toBeNull();
  });

  test("set+get roundtrip returns stored content", async () => {
    const hash = sha256("test content");
    const content = "# Summary\n\nSome content here.";
    await setCached(tmp, hash, content);
    const retrieved = await getCached(tmp, hash);
    expect(retrieved).toBe(content);
  });
});

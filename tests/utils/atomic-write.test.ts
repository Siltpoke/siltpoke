import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWrite } from "../../src/utils/atomic-write";

describe("atomicWrite", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-"));
  });

  test("writes the content to the target path", () => {
    const target = join(dir, "out.txt");
    atomicWrite(target, "hello");
    expect(readFileSync(target, "utf8")).toBe("hello");
  });

  test("temp file is gone after rename", () => {
    const target = join(dir, "out.txt");
    atomicWrite(target, "data");
    const entries = readdirSync(dir);
    const leftoverTmp = entries.find((e) => e.startsWith(".tmp-"));
    expect(leftoverTmp).toBeUndefined();
  });

  test("overwrites an existing file atomically", () => {
    const target = join(dir, "out.txt");
    atomicWrite(target, "first");
    atomicWrite(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
  });

  test("creates parent dirs if missing", () => {
    const target = join(dir, "nested", "deep", "out.txt");
    atomicWrite(target, "x");
    expect(readFileSync(target, "utf8")).toBe("x");
  });
});

/**
 * Index config: allowRoots default ($HOME) + timeout.
 */
import { test, expect, describe } from "bun:test";
import { homedir } from "node:os";
import { indexConfigSchema, resolveAllowRoots } from "../../src/config/index-config";

describe("indexConfigSchema", () => {
  test("defaults: empty allowRoots + 10min timeout", () => {
    const cfg = indexConfigSchema.parse({});
    expect(cfg.allowRoots).toEqual([]);
    expect(cfg.timeoutMs).toBe(600_000);
  });

  test("accepts configured allowRoots + timeout", () => {
    const cfg = indexConfigSchema.parse({ allowRoots: ["/work", "/code"], timeoutMs: 120_000 });
    expect(cfg.allowRoots).toEqual(["/work", "/code"]);
    expect(cfg.timeoutMs).toBe(120_000);
  });

  test("rejects non-positive timeout", () => {
    expect(() => indexConfigSchema.parse({ timeoutMs: 0 })).toThrow();
    expect(() => indexConfigSchema.parse({ timeoutMs: -5 })).toThrow();
  });
});

describe("resolveAllowRoots — $HOME default", () => {
  test("empty config → [$HOME]", () => {
    expect(resolveAllowRoots(indexConfigSchema.parse({}))).toEqual([homedir()]);
  });

  test("configured roots override the default", () => {
    const cfg = indexConfigSchema.parse({ allowRoots: ["/work"] });
    expect(resolveAllowRoots(cfg)).toEqual(["/work"]);
  });
});

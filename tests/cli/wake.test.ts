import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWake, consumeWake } from "../../src/cli/wake";

let tmpHome: string;
let homeBase: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-wake-"));
  homeBase = join(tmpHome, ".siltpoke");
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test("runWake writes wake.json with future expiry", async () => {
  const now = new Date("2026-05-14T12:00:00Z");
  const r = await runWake({ homeBase, ttlMs: 60_000, now: () => now });
  expect(existsSync(r.wake_path)).toBe(true);
  expect(r.expires_at_ms).toBe(now.getTime() + 60_000);
});

test("consumeWake returns true and deletes file when fresh", async () => {
  const now = new Date("2026-05-14T12:00:00Z");
  await runWake({ homeBase, ttlMs: 60_000, now: () => now });
  const ok = await consumeWake(homeBase, now);
  expect(ok).toBe(true);
  expect(existsSync(join(homeBase, "wake.json"))).toBe(false);
});

test("consumeWake returns false on missing file", async () => {
  const ok = await consumeWake(homeBase, new Date());
  expect(ok).toBe(false);
});

test("consumeWake returns false on expired wake (and still deletes)", async () => {
  const t0 = new Date("2026-05-14T12:00:00Z");
  await runWake({ homeBase, ttlMs: 60_000, now: () => t0 });
  const later = new Date(t0.getTime() + 120_000);
  const ok = await consumeWake(homeBase, later);
  expect(ok).toBe(false);
  expect(existsSync(join(homeBase, "wake.json"))).toBe(false);
});

test("consumeWake returns false on malformed wake.json", async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(homeBase, { recursive: true });
  writeFileSync(join(homeBase, "wake.json"), "not json");
  const ok = await consumeWake(homeBase, new Date());
  expect(ok).toBe(false);
});

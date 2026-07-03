import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSkipState,
  writeSkipState,
  emptySkipState,
  pruneExpired,
  type SkipState,
} from "../../src/state/skip-state";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-skip-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("readSkipState returns empty state when file missing", async () => {
  const state = await readSkipState(tmp);
  expect(state.schemaVersion).toBe(1);
  expect(state.entries).toEqual({});
});

test("write then read round-trips state", async () => {
  const state: SkipState = {
    schemaVersion: 1,
    entries: {
      "sess-a": { hash: "abc", updated_at_ms: 1000 },
      "sess-b": { hash: "def", updated_at_ms: 2000 },
    },
  };
  await writeSkipState(tmp, state);
  const got = await readSkipState(tmp);
  expect(got.entries["sess-a"]?.hash).toBe("abc");
  expect(got.entries["sess-b"]?.hash).toBe("def");
});

test("readSkipState returns empty state on malformed JSON", async () => {
  writeFileSync(join(tmp, "skip-state.json"), "not json");
  const state = await readSkipState(tmp);
  expect(state.entries).toEqual({});
});

test("readSkipState returns empty state on wrong schemaVersion", async () => {
  writeFileSync(
    join(tmp, "skip-state.json"),
    JSON.stringify({ schemaVersion: 2, entries: { x: { hash: "h", updated_at_ms: 1 } } }),
  );
  const state = await readSkipState(tmp);
  expect(state.entries).toEqual({});
});

test("pruneExpired drops entries older than ttl", () => {
  const now = 10_000_000;
  const state: SkipState = {
    schemaVersion: 1,
    entries: {
      old: { hash: "x", updated_at_ms: now - 2 * 60 * 60 * 1000 }, // 2h
      fresh: { hash: "y", updated_at_ms: now - 30 * 60 * 1000 }, // 30 min
    },
  };
  const pruned = pruneExpired(state, 60 * 60 * 1000, now);
  expect(pruned.entries.old).toBeUndefined();
  expect(pruned.entries.fresh).toBeDefined();
});

test("emptySkipState produces a valid empty state", () => {
  const s = emptySkipState();
  expect(s.schemaVersion).toBe(1);
  expect(s.entries).toEqual({});
});

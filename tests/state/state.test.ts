import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeState, readState, isStale, type FaceState } from "../../src/state/state";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-state-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const sample: FaceState = {
  schemaVersion: 1,
  mood: "happy",
  pose: "base",
  bubble_short: "all good",
  severity: "info",
  confidence: "high",
  last_updated_ms: Date.now(),
  last_session_id: "abc-123",
};

test("writeState creates a valid JSON file", async () => {
  await writeState(tmp, sample);
  const raw = readFileSync(join(tmp, "state.json"), "utf8");
  expect(JSON.parse(raw).schemaVersion).toBe(1);
});

test("readState round-trips writeState output", async () => {
  await writeState(tmp, sample);
  const got = await readState(tmp);
  expect(got).toEqual(sample);
});

test("readState returns null when file missing", async () => {
  expect(await readState(tmp)).toBeNull();
});

test("readState returns null when JSON malformed", async () => {
  writeFileSync(join(tmp, "state.json"), "not json");
  expect(await readState(tmp)).toBeNull();
});

test("readState returns null when schemaVersion missing or != 1", async () => {
  writeFileSync(join(tmp, "state.json"), JSON.stringify({ ...sample, schemaVersion: 99 }));
  expect(await readState(tmp)).toBeNull();

  writeFileSync(
    join(tmp, "state.json"),
    JSON.stringify({ mood: "happy" }),
  );
  expect(await readState(tmp)).toBeNull();
});

test("readState returns null when required fields missing", async () => {
  const partial = { schemaVersion: 1, mood: "happy" };
  writeFileSync(join(tmp, "state.json"), JSON.stringify(partial));
  expect(await readState(tmp)).toBeNull();
});

test("isStale: fresh under maxAgeMs", () => {
  const fresh: FaceState = { ...sample, last_updated_ms: Date.now() };
  expect(isStale(fresh, 30_000)).toBe(false);
});

test("isStale: old beyond maxAgeMs", () => {
  const old: FaceState = { ...sample, last_updated_ms: Date.now() - 60_000 };
  expect(isStale(old, 30_000)).toBe(true);
});

test("concurrent writes do not corrupt file (last writer wins, file always parseable)", async () => {
  const a: FaceState = { ...sample, mood: "happy", last_session_id: "a" };
  const b: FaceState = { ...sample, mood: "annoyed", last_session_id: "b" };
  await Promise.all([writeState(tmp, a), writeState(tmp, b)]);
  const got = await readState(tmp);
  expect(got).not.toBeNull();
  expect(["a", "b"]).toContain(got!.last_session_id);
});

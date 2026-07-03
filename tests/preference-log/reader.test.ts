import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPreferenceLog, countBySignal } from "../../src/preference-log/reader";
import type { PreferenceLogEntry } from "../../src/preference-log/types";

let tmp: string;
let logPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-preflog-reader-"));
  logPath = join(tmp, "preference-log.jsonl");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeEntry(
  overrides: Partial<PreferenceLogEntry> & { critique_id: string; signal: PreferenceLogEntry["signal"] },
): PreferenceLogEntry {
  return {
    ts: new Date().toISOString(),
    reason_text: null,
    critique_snapshot: {},
    diff_snapshot_sha: null,
    intent_at_critique: null,
    reflexion_rule_fired: null,
    ...overrides,
  };
}

function writeLog(entries: PreferenceLogEntry[]): void {
  mkdirSync(tmp, { recursive: true });
  writeFileSync(logPath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

test("empty file → empty array", async () => {
  writeFileSync(logPath, "");
  const result = await readPreferenceLog({ path: logPath });
  expect(result).toEqual([]);
});

test("non-existent file → empty array (no throw)", async () => {
  const result = await readPreferenceLog({ path: join(tmp, "missing.jsonl") });
  expect(result).toEqual([]);
});

test("reads all entries from file", async () => {
  const entries = [
    makeEntry({ critique_id: "c-001", signal: "ack" }),
    makeEntry({ critique_id: "c-002", signal: "dismiss" }),
    makeEntry({ critique_id: "c-003", signal: "forward" }),
  ];
  writeLog(entries);

  const result = await readPreferenceLog({ path: logPath });
  expect(result).toHaveLength(3);
  expect(result[0].critique_id).toBe("c-001");
  expect(result[1].critique_id).toBe("c-002");
  expect(result[2].critique_id).toBe("c-003");
});

test("filters by signal", async () => {
  const entries = [
    makeEntry({ critique_id: "c-001", signal: "ack" }),
    makeEntry({ critique_id: "c-002", signal: "dismiss" }),
    makeEntry({ critique_id: "c-003", signal: "ack" }),
  ];
  writeLog(entries);

  const result = await readPreferenceLog({ path: logPath, signal: "ack" });
  expect(result).toHaveLength(2);
  expect(result.every((e) => e.signal === "ack")).toBe(true);
});

test("filters by critique_id", async () => {
  const entries = [
    makeEntry({ critique_id: "c-target", signal: "ack" }),
    makeEntry({ critique_id: "c-other", signal: "dismiss" }),
    makeEntry({ critique_id: "c-target", signal: "forward" }),
  ];
  writeLog(entries);

  const result = await readPreferenceLog({ path: logPath, critique_id: "c-target" });
  expect(result).toHaveLength(2);
  expect(result.every((e) => e.critique_id === "c-target")).toBe(true);
});

test("limit truncates from tail", async () => {
  const entries = [
    makeEntry({ critique_id: "c-001", signal: "ack" }),
    makeEntry({ critique_id: "c-002", signal: "dismiss" }),
    makeEntry({ critique_id: "c-003", signal: "forward" }),
    makeEntry({ critique_id: "c-004", signal: "feedback" }),
  ];
  writeLog(entries);

  const result = await readPreferenceLog({ path: logPath, limit: 2 });
  expect(result).toHaveLength(2);
  // Should be the last 2 entries
  expect(result[0].critique_id).toBe("c-003");
  expect(result[1].critique_id).toBe("c-004");
});

test("skips malformed lines without throwing", async () => {
  const validEntry = makeEntry({ critique_id: "c-ok", signal: "ack" });
  writeFileSync(
    logPath,
    `not-valid-json\n${JSON.stringify(validEntry)}\n{broken\n`,
  );

  const result = await readPreferenceLog({ path: logPath });
  expect(result).toHaveLength(1);
  expect(result[0].critique_id).toBe("c-ok");
});

test("countBySignal returns correct counts", async () => {
  const entries = [
    makeEntry({ critique_id: "c-001", signal: "ack" }),
    makeEntry({ critique_id: "c-002", signal: "ack" }),
    makeEntry({ critique_id: "c-003", signal: "dismiss" }),
    makeEntry({ critique_id: "c-004", signal: "forward" }),
    makeEntry({ critique_id: "c-005", signal: "feedback" }),
    makeEntry({ critique_id: "c-006", signal: "forward" }),
  ];
  writeLog(entries);

  const counts = await countBySignal({ path: logPath });
  expect(counts.ack).toBe(2);
  expect(counts.dismiss).toBe(1);
  expect(counts.forward).toBe(2);
  expect(counts.feedback).toBe(1);
});

test("countBySignal returns zeroes for empty file", async () => {
  writeFileSync(logPath, "");
  const counts = await countBySignal({ path: logPath });
  expect(counts).toEqual({ ack: 0, dismiss: 0, forward: 0, feedback: 0 });
});

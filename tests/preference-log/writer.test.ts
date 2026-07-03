import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPreferenceEntry } from "../../src/preference-log/writer";
import type { PreferenceLogEntry } from "../../src/preference-log/types";

let tmp: string;
let logPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-preflog-writer-"));
  logPath = join(tmp, "preference-log.jsonl");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("appends entry to file at provided path", async () => {
  await appendPreferenceEntry(
    {
      critique_id: "c-abc1",
      signal: "ack",
      reason_text: null,
      critique_snapshot: { severity: "medium" },
      diff_snapshot_sha: null,
      intent_at_critique: null,
      reflexion_rule_fired: null,
    },
    { path: logPath },
  );

  expect(existsSync(logPath)).toBe(true);
  const raw = readFileSync(logPath, "utf8");
  const entry = JSON.parse(raw.trim()) as PreferenceLogEntry;
  expect(entry.critique_id).toBe("c-abc1");
  expect(entry.signal).toBe("ack");
  expect(entry.reason_text).toBeNull();
  expect(entry.critique_snapshot).toEqual({ severity: "medium" });
});

test("ts defaults to now (ISO string) when omitted", async () => {
  const before = new Date().toISOString();
  await appendPreferenceEntry(
    {
      critique_id: "c-ts01",
      signal: "dismiss",
      reason_text: "wrong",
      critique_snapshot: {},
      diff_snapshot_sha: null,
      intent_at_critique: null,
      reflexion_rule_fired: null,
    },
    { path: logPath },
  );
  const after = new Date().toISOString();

  const raw = readFileSync(logPath, "utf8");
  const entry = JSON.parse(raw.trim()) as PreferenceLogEntry;
  expect(entry.ts >= before).toBe(true);
  expect(entry.ts <= after).toBe(true);
});

test("creates parent directory if missing", async () => {
  const nested = join(tmp, "a", "b", "c", "preference-log.jsonl");

  await appendPreferenceEntry(
    {
      critique_id: "c-nested",
      signal: "forward",
      reason_text: null,
      critique_snapshot: {},
      diff_snapshot_sha: "sha1234",
      intent_at_critique: null,
      reflexion_rule_fired: null,
    },
    { path: nested },
  );

  expect(existsSync(nested)).toBe(true);
  const raw = readFileSync(nested, "utf8");
  const entry = JSON.parse(raw.trim()) as PreferenceLogEntry;
  expect(entry.critique_id).toBe("c-nested");
  expect(entry.diff_snapshot_sha).toBe("sha1234");
});

test("appends multiple entries as separate JSONL lines", async () => {
  await appendPreferenceEntry(
    {
      critique_id: "c-m1",
      signal: "ack",
      reason_text: null,
      critique_snapshot: {},
      diff_snapshot_sha: null,
      intent_at_critique: null,
      reflexion_rule_fired: null,
    },
    { path: logPath },
  );
  await appendPreferenceEntry(
    {
      critique_id: "c-m2",
      signal: "dismiss",
      reason_text: "irrelevant",
      critique_snapshot: { confidence: "low" },
      diff_snapshot_sha: null,
      intent_at_critique: "refactor",
      reflexion_rule_fired: null,
    },
    { path: logPath },
  );

  const lines = readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  expect(lines).toHaveLength(2);
  const e1 = JSON.parse(lines[0]) as PreferenceLogEntry;
  const e2 = JSON.parse(lines[1]) as PreferenceLogEntry;
  expect(e1.critique_id).toBe("c-m1");
  expect(e2.critique_id).toBe("c-m2");
  expect(e2.intent_at_critique).toBe("refactor");
});

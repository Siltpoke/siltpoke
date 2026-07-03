import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFewShotIndex } from "../../src/few-shot/build-index";
import { loadIndex } from "../../src/few-shot/index";
import { createStubEmbedder } from "../../src/few-shot/embedder";
import type { PreferenceLogEntry } from "../../src/preference-log/types";

let tmp: string;
let logPath: string;
let indexPath: string;
const embedder = createStubEmbedder();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-build-index-"));
  logPath = join(tmp, "preference-log.jsonl");
  indexPath = join(tmp, "few-shot-index.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeEntry(
  critique_id: string,
  signal: PreferenceLogEntry["signal"] = "dismiss",
  reason_text: string | null = null,
): PreferenceLogEntry {
  return {
    ts: new Date().toISOString(),
    critique_id,
    signal,
    reason_text,
    critique_snapshot: { severity: "low", message: `test ${critique_id}` },
    diff_snapshot_sha: null,
    intent_at_critique: null,
    reflexion_rule_fired: null,
  };
}

function writeLog(entries: PreferenceLogEntry[]): void {
  mkdirSync(tmp, { recursive: true });
  writeFileSync(
    logPath,
    `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
}

test("empty preference log → empty index, entriesAdded=0", async () => {
  writeLog([]);
  const result = await buildFewShotIndex({
    preferenceLogPath: logPath,
    indexPath,
    embedder,
  });
  expect(result.entriesAdded).toBe(0);
  expect(result.totalEntries).toBe(0);
});

test("only dismiss entries are indexed (ack/forward ignored)", async () => {
  writeLog([
    makeEntry("c-dismiss", "dismiss"),
    makeEntry("c-ack", "ack"),
    makeEntry("c-forward", "forward"),
  ]);
  const result = await buildFewShotIndex({
    preferenceLogPath: logPath,
    indexPath,
    embedder,
  });
  expect(result.entriesAdded).toBe(1);
  const index = await loadIndex(indexPath);
  expect(index).toHaveLength(1);
  expect(index[0]?.id).toBe("c-dismiss");
});

test("already-indexed entries are skipped on rebuild", async () => {
  writeLog([makeEntry("c-001", "dismiss"), makeEntry("c-002", "dismiss")]);
  // Build once
  await buildFewShotIndex({ preferenceLogPath: logPath, indexPath, embedder });
  // Build again — same log
  const result = await buildFewShotIndex({
    preferenceLogPath: logPath,
    indexPath,
    embedder,
  });
  expect(result.entriesAdded).toBe(0);
  expect(result.totalEntries).toBe(2);
});

test("incremental add picks up newly dismissed entries only", async () => {
  writeLog([makeEntry("c-001", "dismiss")]);
  await buildFewShotIndex({ preferenceLogPath: logPath, indexPath, embedder });

  // Add a new entry to the log
  writeLog([makeEntry("c-001", "dismiss"), makeEntry("c-002", "dismiss")]);
  const result = await buildFewShotIndex({
    preferenceLogPath: logPath,
    indexPath,
    embedder,
  });
  expect(result.entriesAdded).toBe(1);
  expect(result.totalEntries).toBe(2);
});

test("reason_text is stored in index entry", async () => {
  writeLog([makeEntry("c-rtext", "dismiss", "too generic")]);
  await buildFewShotIndex({ preferenceLogPath: logPath, indexPath, embedder });
  const index = await loadIndex(indexPath);
  expect(index[0]?.reason_text).toBe("too generic");
});

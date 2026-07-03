import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIndex, saveIndex } from "../../src/few-shot/index";
import type { FewShotIndexEntry } from "../../src/few-shot/types";

let tmp: string;
let indexPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-few-shot-index-"));
  indexPath = join(tmp, "few-shot-index.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeEntry(id: string): FewShotIndexEntry {
  return {
    id,
    embedding: [0.1, 0.2, 0.3],
    signal: "dismiss",
    reason_text: "too noisy",
    critique_summary: `summary for ${id}`,
    ts: new Date().toISOString(),
  };
}

test("loadIndex returns empty array when file does not exist", async () => {
  const result = await loadIndex(join(tmp, "nonexistent.json"));
  expect(result).toEqual([]);
});

test("saveIndex + loadIndex roundtrip preserves all fields", async () => {
  const entries: FewShotIndexEntry[] = [makeEntry("c-001"), makeEntry("c-002")];
  await saveIndex(entries, indexPath);
  const loaded = await loadIndex(indexPath);
  expect(loaded).toHaveLength(2);
  expect(loaded[0]?.id).toBe("c-001");
  expect(loaded[1]?.id).toBe("c-002");
  expect(loaded[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
  expect(loaded[0]?.reason_text).toBe("too noisy");
  expect(loaded[0]?.signal).toBe("dismiss");
});

test("saveIndex creates parent directory when missing", async () => {
  const nested = join(tmp, "nested", "deep", "index.json");
  await saveIndex([makeEntry("c-xyz")], nested);
  const loaded = await loadIndex(nested);
  expect(loaded).toHaveLength(1);
  expect(loaded[0]?.id).toBe("c-xyz");
});

test("loadIndex returns empty array on malformed JSON", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(indexPath, "not valid json{{{{");
  const loaded = await loadIndex(indexPath);
  expect(loaded).toEqual([]);
});

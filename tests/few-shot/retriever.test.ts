import { test, expect } from "bun:test";
import { findNearest } from "../../src/few-shot/retriever";
import type { FewShotIndexEntry } from "../../src/few-shot/types";

function makeEntry(id: string, embedding: number[]): FewShotIndexEntry {
  return {
    id,
    embedding,
    signal: "dismiss",
    reason_text: null,
    critique_summary: `summary for ${id}`,
    ts: "2026-01-01T00:00:00Z",
  };
}

// Simple 2D embeddings for deterministic tests
const entries: FewShotIndexEntry[] = [
  makeEntry("a", [1, 0]),   // pointing right
  makeEntry("b", [0, 1]),   // pointing up
  makeEntry("c", [-1, 0]),  // pointing left
  makeEntry("d", [0, -1]),  // pointing down
];

test("k=2 returns exactly 2 results", () => {
  const results = findNearest([1, 0], entries, 2);
  expect(results).toHaveLength(2);
});

test("nearest result is the identical vector (similarity ≈ 1)", () => {
  const results = findNearest([1, 0], entries, 1);
  expect(results[0]?.entry.id).toBe("a");
  expect(results[0]?.similarity).toBeCloseTo(1.0, 5);
});

test("results are sorted descending by similarity", () => {
  const results = findNearest([1, 0], entries, 4);
  for (let i = 0; i < results.length - 1; i++) {
    expect(results[i]?.similarity).toBeGreaterThanOrEqual(results[i + 1]?.similarity);
  }
});

test("opposite vector has similarity ≈ -1", () => {
  const results = findNearest([-1, 0], entries, 4);
  // last result should be "a" with similarity ≈ -1
  const last = results[results.length - 1]!;
  expect(last.entry.id).toBe("a");
  expect(last.similarity).toBeCloseTo(-1.0, 5);
});

test("empty index returns empty array", () => {
  const results = findNearest([1, 0], [], 3);
  expect(results).toEqual([]);
});

test("k larger than index size returns all entries", () => {
  const results = findNearest([1, 0], entries, 100);
  expect(results).toHaveLength(entries.length);
});

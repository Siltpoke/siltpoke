import { test, expect, describe, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enqueuePending,
  readPending,
  writePending,
  pendingCritiqueSchema,
  type PendingCritique,
} from "../../src/memory/pending-queue";

const mkEntry = (id: string): PendingCritique => ({
  critique_id: id, session_id: "s1", created_sha: "abc", created_at: "2026-07-15T00:00:00Z",
  hooks_elapsed: 0, status: "pending", severity: "medium", finding_text: "add a null check at foo.ts:42",
  anchors: [{ file: "foo.ts", line: 42, tool: "tsc", fingerprint: "fp1" }],
  distil_attempts: 0,
});

test("enqueue then read round-trips, carrying anchors + finding_text (AC6)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pq-"));
  const p = join(dir, "pending-critiques.jsonl");
  await enqueuePending(p, mkEntry("c-1"));
  const got = await readPending(p);
  expect(got).toHaveLength(1);
  expect(got[0].anchors[0].fingerprint).toBe("fp1");
  expect(got[0].finding_text).toContain("null check");
});

test("corrupt file reads as empty, never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pq-"));
  const p = join(dir, "pending-critiques.jsonl");
  await writeFile(p, "{not json\n");
  expect(await readPending(p)).toEqual([]);
});

test("writePending atomically replaces the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pq-"));
  const p = join(dir, "pending-critiques.jsonl");
  await enqueuePending(p, mkEntry("c-1"));
  await writePending(p, []);
  expect(await readPending(p)).toEqual([]);
});

const base = {
  critique_id: "c-1", session_id: "s", created_sha: null,
  created_at: new Date(0).toISOString(), hooks_elapsed: 0,
  status: "pending", severity: "high", finding_text: "f",
  anchors: [{ file: "a.ts", line: 1, tool: "tsc", fingerprint: "fp" }],
};

describe("distil_attempts", () => {
  it("defaults to 0 when an old line omits it", () => {
    const parsed = pendingCritiqueSchema.parse(base);
    expect(parsed.distil_attempts).toBe(0);
  });
  it("round-trips an explicit value", () => {
    const parsed = pendingCritiqueSchema.parse({ ...base, distil_attempts: 2 });
    expect(parsed.distil_attempts).toBe(2);
  });
});

test("pendingCritiqueSchema accepts an optional capture_id and rejects a bad one", () => {
  const base = { critique_id: "c-1", session_id: "s", created_sha: null, created_at: "t",
    hooks_elapsed: 0, status: "pending", severity: "low", finding_text: "x", anchors: [] };
  expect(pendingCritiqueSchema.parse({ ...base, capture_id: "case1-ab12" }).capture_id).toBe("case1-ab12");
  expect(pendingCritiqueSchema.parse(base).capture_id).toBeUndefined();
  expect(() => pendingCritiqueSchema.parse({ ...base, capture_id: "bad-id" })).toThrow();
});

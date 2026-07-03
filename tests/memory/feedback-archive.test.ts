import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendFeedbackArchive,
  feedbackArchivePath,
  type FeedbackArchiveEntry,
} from "../../src/memory/feedback-archive";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-archive-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const sample: FeedbackArchiveEntry = {
  ts: "2026-05-14T18:00:00Z",
  critique_id: "c-a7b3",
  verdict: "dismissed",
  reason: "already null-checked",
};

test("appendFeedbackArchive creates file on first append", async () => {
  const path = feedbackArchivePath(tmp);
  expect(existsSync(path)).toBe(false);
  await appendFeedbackArchive(tmp, sample);
  expect(existsSync(path)).toBe(true);
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw.trim());
  expect(parsed.critique_id).toBe("c-a7b3");
  expect(parsed.verdict).toBe("dismissed");
});

test("appendFeedbackArchive appends to existing file (no truncation)", async () => {
  await appendFeedbackArchive(tmp, { ...sample, critique_id: "c-1111" });
  await appendFeedbackArchive(tmp, { ...sample, critique_id: "c-2222" });
  await appendFeedbackArchive(tmp, { ...sample, critique_id: "c-3333" });
  const raw = readFileSync(feedbackArchivePath(tmp), "utf8");
  const lines = raw.trim().split("\n");
  expect(lines).toHaveLength(3);
  expect(JSON.parse(lines[0]!).critique_id).toBe("c-1111");
  expect(JSON.parse(lines[2]!).critique_id).toBe("c-3333");
});

test("appendFeedbackArchive persists reflection metadata", async () => {
  const withReflection: FeedbackArchiveEntry = {
    ...sample,
    reflection: {
      rule_id: "lr-001",
      rule_category: "null_check",
      confidence: "high",
    },
  };
  await appendFeedbackArchive(tmp, withReflection);
  const raw = readFileSync(feedbackArchivePath(tmp), "utf8");
  const parsed = JSON.parse(raw.trim());
  expect(parsed.reflection.rule_id).toBe("lr-001");
  expect(parsed.reflection.confidence).toBe("high");
});

test("appendFeedbackArchive creates basePath if missing", async () => {
  const nested = join(tmp, "deep", "nested", "dir");
  await appendFeedbackArchive(nested, sample);
  expect(existsSync(feedbackArchivePath(nested))).toBe(true);
});

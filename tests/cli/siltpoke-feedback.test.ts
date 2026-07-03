/**
 * Tests for siltpoke-feedback CLI runner
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFeedback } from "../../src/cli/siltpoke-feedback";

let tmp: string;
let logPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-feedback-cli-"));
  mkdirSync(tmp, { recursive: true });
  logPath = join(tmp, "preference-log.jsonl");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("runFeedback", () => {
  test("returns ok:true with the critique_id", async () => {
    const result = await runFeedback({
      critiqueId: "c-abc",
      text: "this is wrong because we want explicit nulls",
      logPath,
    });
    expect(result.ok).toBe(true);
    expect(result.critique_id).toBe("c-abc");
  });

  test("writes preference-log entry with signal=feedback", async () => {
    await runFeedback({
      critiqueId: "c-abc",
      text: "good catch, missed the API path traversal",
      logPath,
    });
    const raw = readFileSync(logPath, "utf8");
    const entry = JSON.parse(raw.trim()) as {
      signal: string;
      critique_id: string;
      reason_text: string;
    };
    expect(entry.signal).toBe("feedback");
    expect(entry.critique_id).toBe("c-abc");
  });

  test("writes reason_text from provided text", async () => {
    const text = "the null check is missing";
    await runFeedback({ critiqueId: "c-xyz", text, logPath });
    const raw = readFileSync(logPath, "utf8");
    const entry = JSON.parse(raw.trim()) as { reason_text: string };
    expect(entry.reason_text).toBe(text);
  });

  test("appends multiple entries without overwriting", async () => {
    await runFeedback({ critiqueId: "c-1", text: "first feedback", logPath });
    await runFeedback({ critiqueId: "c-2", text: "second feedback", logPath });
    const raw = readFileSync(logPath, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]!) as { critique_id: string };
    const second = JSON.parse(lines[1]!) as { critique_id: string };
    expect(first.critique_id).toBe("c-1");
    expect(second.critique_id).toBe("c-2");
  });

  test("entry includes a ts timestamp", async () => {
    await runFeedback({ critiqueId: "c-ts", text: "test", logPath });
    const raw = readFileSync(logPath, "utf8");
    const entry = JSON.parse(raw.trim()) as { ts: string };
    expect(typeof entry.ts).toBe("string");
    expect(entry.ts.length).toBeGreaterThan(0);
  });
});

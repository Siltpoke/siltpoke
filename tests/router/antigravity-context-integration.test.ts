// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Integration coverage for the readEvents() chokepoint wiring
 * (normalizeCodexEvents(e) ?? normalizeAntigravityEvents(e) ?? [e]) against
 * the real committed agy fixture — proves extractChangedFiles /
 * extractLatestUserMessage / extractTranscriptTurns see agy transcripts
 * transparently, the same way codex-transcript.test.ts proves it for Codex.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractChangedFiles, extractLatestUserMessage } from "../../src/router/context";
import { extractTranscriptTurns } from "../../src/router/extract-turns";

const FIXTURE_SRC = join(import.meta.dir, "..", "fixtures", "agy", "transcript-code-edit.jsonl");

describe("agy transcript -> extractChangedFiles/extractLatestUserMessage/extractTranscriptTurns", () => {
  function withFixture(fn: (path: string) => Promise<void>): () => Promise<void> {
    return async () => {
      const tmp = mkdtempSync(join(tmpdir(), "siltpoke-agy-context-"));
      const fixturePath = join(tmp, "transcript_full.jsonl");
      copyFileSync(FIXTURE_SRC, fixturePath);
      try {
        await fn(fixturePath);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };
  }

  test(
    "extractChangedFiles surfaces the write_to_file TargetFile as a Write tool_use path",
    withFixture(async (fixturePath) => {
      const files = await extractChangedFiles(fixturePath);
      expect(files).toEqual(["/Users/v/agy-gap-test/calc.py"]);
    }),
  );

  test(
    "extractLatestUserMessage returns the LAST user turn, unwrapped",
    withFixture(async (fixturePath) => {
      const msg = await extractLatestUserMessage(fixturePath);
      expect(msg).toBe("好 帮我把你刚刚create的删掉吧");
    }),
  );

  test(
    "extractTranscriptTurns yields the ordered user/assistant sequence, skipping unrecognized steps",
    withFixture(async (fixturePath) => {
      const turns = await extractTranscriptTurns(fixturePath);
      expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant", "user", "assistant"]);
      expect(turns[0]!.text).toBe(
        "create a file calc.py with an add function that has a bug: it returns a minus b instead of a plus b",
      );
      expect(turns[1]!.text).toBe("[tool Write] /Users/v/agy-gap-test/calc.py");
      expect(turns[2]!.text).toContain("performs subtraction");
      expect(turns[3]!.text).toBe("好 帮我把你刚刚create的删掉吧");
      expect(turns[4]!.text).toBe(
        "I have deleted the [calc.py](file:///Users/v/agy-gap-test/calc.py) file as requested.",
      );
    }),
  );
});

describe("readEvents chokepoint composes Codex ?? Antigravity ?? raw without cross-contamination", () => {
  test("a file mixing one Claude-shaped line and one agy USER_INPUT line normalizes both correctly", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "siltpoke-mixed-"));
    try {
      const p = join(tmp, "mixed.jsonl");
      const lines = [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name: "Write", input: { file_path: "/tmp/claude-file.ts" } }],
          },
        }),
        JSON.stringify({
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          created_at: "2026-07-10T00:00:00Z",
          content: "<USER_REQUEST>\nfix the bug\n</USER_REQUEST>",
        }),
      ];
      writeFileSync(p, `${lines.join("\n")}\n`);
      const files = await extractChangedFiles(p);
      expect(files).toEqual(["/tmp/claude-file.ts"]);
      const msg = await extractLatestUserMessage(p);
      expect(msg).toBe("fix the bug");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

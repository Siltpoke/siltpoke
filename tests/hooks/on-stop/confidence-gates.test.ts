import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../../../src/hooks/on-stop";
import type { BrainOutput } from "../../../src/brain/schema";
import { seedEditedFile } from "./_shared";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-hook-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test("confidence=high writes critique markdown + state bubble (regression)", async () => {
  const transcriptPath = join(tmpHome, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Edit", input: { file_path: "src/dummy.ts" } }] },
    })}\n`,
  );
  const projectCwd = join(tmpHome, "phigh");
  seedEditedFile(projectCwd);
  const fakeBrain: BrainOutput = {
    mood: "annoyed",
    pose: "arms_crossed",
    bubble_short: "high-conf bubble",
    bubble_long: "",
    critique_for_claude: "queries.py:47 bad join",
    severity: "high",
    confidence: "high",
    xp_earned_events: [],
    evidence: [],
      reasoning: "test fixture",
  };
  await runHook({
    rawJson: JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-high",
      transcript_path: transcriptPath,
      cwd: projectCwd,
    }),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async () => ({
      output: fakeBrain,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_cost_usd: 0,
      },
    }),
  });
  const state = JSON.parse(
    readFileSync(join(projectCwd, ".siltpoke", "state.json"), "utf8"),
  );
  expect(state.bubble_short).toBe("high-conf bubble");
  const today = new Date().toISOString().slice(0, 10);
  // critique now lives per-project under {cwd}/.siltpoke/critiques/
  const archiveDir = join(projectCwd, ".siltpoke", "critiques", "archive", today);
  expect(existsSync(archiveDir)).toBe(true);
});

test("confidence=medium suppresses critique markdown but keeps state bubble", async () => {
  const transcriptPath = join(tmpHome, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Edit", input: { file_path: "src/dummy.ts" } }] },
    })}\n`,
  );
  const projectCwd = join(tmpHome, "pmed");
  seedEditedFile(projectCwd);
  const fakeBrain: BrainOutput = {
    mood: "watching",
    pose: "base",
    bubble_short: "medium-conf bubble",
    bubble_long: "",
    critique_for_claude: "maybe this",
    severity: "medium",
    confidence: "medium",
    xp_earned_events: [],
    evidence: [],
      reasoning: "test fixture",
  };
  await runHook({
    rawJson: JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-med",
      transcript_path: transcriptPath,
      cwd: projectCwd,
    }),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async () => ({
      output: fakeBrain,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_cost_usd: 0,
      },
    }),
  });
  const state = JSON.parse(
    readFileSync(join(projectCwd, ".siltpoke", "state.json"), "utf8"),
  );
  expect(state.bubble_short).toBe("medium-conf bubble");
  expect(
    existsSync(join(tmpHome, ".siltpoke", "critiques", "history.jsonl")),
  ).toBe(false);
});

// Characterization FLIPPED 2026-06-11: the old behavior wrote state.json with
// an empty bubble; an empty effective bubble now skips the state write
// entirely (jsonl telemetry still written).
test("confidence=low suppresses critique AND skips the empty-bubble state write", async () => {
  const transcriptPath = join(tmpHome, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Edit", input: { file_path: "src/dummy.ts" } }] },
    })}\n`,
  );
  const projectCwd = join(tmpHome, "plow");
  seedEditedFile(projectCwd);
  const fakeBrain: BrainOutput = {
    mood: "idle",
    pose: "base",
    bubble_short: "this should NOT appear",
    bubble_long: "",
    critique_for_claude: "",
    severity: "info",
    confidence: "low",
    xp_earned_events: [],
    evidence: [],
      reasoning: "test fixture",
  };
  await runHook({
    rawJson: JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-low",
      transcript_path: transcriptPath,
      cwd: projectCwd,
    }),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async () => ({
      output: fakeBrain,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_cost_usd: 0,
      },
    }),
  });
  // NO state/activity write for the empty effective bubble.
  expect(existsSync(join(projectCwd, ".siltpoke", "state.json"))).toBe(false);
  expect(
    existsSync(join(tmpHome, ".siltpoke", "critiques", "history.jsonl")),
  ).toBe(false);
  // Brain output still preserved in log for audit (jsonl telemetry kept).
  const log = readFileSync(
    join(tmpHome, ".siltpoke", "brain-calls.jsonl"),
    "utf8",
  );
  expect(log).toContain('"this should NOT appear"');
  expect(log).toContain('"gating_decision":"low"');
  expect(log).toContain('"bubble_suppressed":true');
});

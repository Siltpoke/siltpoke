// Shared test fixtures + helpers for on-stop hook test files.
// Extracted from tests/hooks/on-stop.test.ts.
//
// Helpers take tmpHome as an explicit arg (vs closing over a module var)
// so each test file's own tmpHome from beforeEach() drives the fixture.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrainOutput } from "../../../src/brain/schema";

/**
 * Build a synthetic Stop-event payload + write a 2-line transcript
 * (user msg + assistant reply with one Edit tool_use). Returns the event
 * object ready to JSON.stringify into runHook's rawJson.
 *
 * `name` is used as the unique transcript filename + cwd subdir.
 */
export function eventWithProj(
  tmpHome: string,
  name: string,
  sessionId: string = "sess-m10",
) {
  const transcriptPath = join(tmpHome, `${name}.jsonl`);
  // Edit a real file under cwd so the Stop hook's pruneMissing (drops paths gone
  // from disk) keeps it — a fake relative path would resolve to nothing → skip.
  const cwd = join(tmpHome, name);
  const editedPath = join(cwd, "src", "dummy.ts");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(editedPath, "export const dummy = 1;\n");
  writeFileSync(
    transcriptPath,
    JSON.stringify({
      type: "user",
      message: { role: "user", content: `msg ${name}` },
    }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `reply ${name}` }, { type: "tool_use", name: "Edit", input: { file_path: editedPath } }] },
      }) +
      "\n",
  );
  return {
    hook_event_name: "Stop",
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
  };
}

/**
 * Create the `src/dummy.ts` file the inline transcripts say was Edit'd, under a
 * test's cwd — so the Stop hook's pruneMissing (drops changed-file paths gone
 * from disk) keeps it instead of pruning a non-existent placeholder → empty
 * changedFiles → hook skips. Call once per test after its cwd is known.
 */
export function seedEditedFile(cwd: string, rel: string = "src/dummy.ts"): void {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "export const dummy = 1;\n");
}

export const noopUsage = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  input_tokens: 100,
  output_tokens: 200,
  total_cost_usd: 0.001,
};

export const fakeBrainOutput: BrainOutput = {
  mood: "happy",
  pose: "base",
  bubble_short: "ok",
  bubble_long: "",
  critique_for_claude: "",
  severity: "info",
  confidence: "high",
  xp_earned_events: [],
  evidence: [],
  reasoning: "test fixture",
};

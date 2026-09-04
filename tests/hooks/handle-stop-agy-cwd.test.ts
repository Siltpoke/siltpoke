// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Integration guard for the agy `-p` cwd re-anchor (resolveHostCwd wired into
 * handleStopHook). The pure resolveHostCwd unit is covered separately; this
 * asserts the WIRING ORDER: because the re-anchor runs before stateBase is
 * derived, an agy event whose payload cwd (agy's config dir) does NOT contain
 * the edit writes its pet state under the EDITED FILE'S repo, not the wrong
 * dir. A codex control proves the re-anchor is scoped to antigravity.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainCallResult } from "../../src/brain/brain";
import type { BrainOutput } from "../../src/brain/schema";
import { handleStopHook } from "../../src/hooks/handle-stop";
import type { HookEvent } from "../../src/router/router";
import { makeGitRepo } from "../_shared/git-fixture";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-agy-cwd-"));
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

const noopUsage = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  input_tokens: 100,
  output_tokens: 50,
  total_cost_usd: 0.001,
};

function fakeBrainOutput(): BrainOutput {
  return {
    mood: "happy",
    pose: "base",
    bubble_short: "ok",
    bubble_long: "",
    critique_for_claude: "something actionable",
    severity: "medium",
    confidence: "high",
    xp_earned_events: [],
    evidence: [],
  };
}

/** A repo holding one edited file + a transcript editing it. */
function setup(): { repo: string; wrongCwd: string; transcriptPath: string } {
  const repo = join(tmpHome, "realrepo");
  // A REAL repo, not a bare `.git` directory. `findGitRoot` was happy with the
  // marker alone, but the ⏱ review-unit gate runs `rev-parse HEAD` against it
  // and an empty `.git` answers `not_a_git_repo` — the hook would skip before
  // the re-anchor this test is about ever mattered.
  makeGitRepo(repo);
  const edited = join(repo, "token.ts");
  writeFileSync(edited, "export const x = 1;\n");
  // The codex control below writes state under this one, so it needs to get
  // past the same gate.
  const wrongCwd = join(tmpHome, "gemini-config"); // simulates ~/.gemini/config
  makeGitRepo(wrongCwd);
  const transcriptPath = join(tmpHome, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: edited } }] },
    })}\n`,
  );
  return { repo, wrongCwd, transcriptPath };
}

test("agy `-p`: payload cwd doesn't contain the edit → pet state writes under the edited file's repo, not the wrong dir", async () => {
  const { repo, wrongCwd, transcriptPath } = setup();
  const event: HookEvent = {
    hook_event_name: "Stop",
    session_id: "sess-agy",
    transcript_path: transcriptPath,
    cwd: wrongCwd,
    siltpoke_host: "antigravity",
  };
  await handleStopHook(event, {
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async (): Promise<BrainCallResult> => ({ output: fakeBrainOutput(), usage: noopUsage }),
  });

  expect(existsSync(join(repo, ".siltpoke", "state.json"))).toBe(true);
  expect(existsSync(join(wrongCwd, ".siltpoke", "state.json"))).toBe(false);
});

test("codex control: siltpoke_host !== antigravity → NO re-anchor, state writes under the payload cwd", async () => {
  const { repo, wrongCwd, transcriptPath } = setup();
  const event: HookEvent = {
    hook_event_name: "Stop",
    session_id: "sess-codex",
    transcript_path: transcriptPath,
    cwd: wrongCwd,
    siltpoke_host: "codex",
  };
  await handleStopHook(event, {
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async (): Promise<BrainCallResult> => ({ output: fakeBrainOutput(), usage: noopUsage }),
  });

  expect(existsSync(join(wrongCwd, ".siltpoke", "state.json"))).toBe(true);
  expect(existsSync(join(repo, ".siltpoke", "state.json"))).toBe(false);
});

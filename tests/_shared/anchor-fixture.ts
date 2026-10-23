// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Fixtures for the review-unit anchor tests (handle-stop-review-anchor.test.ts).
 *
 * Split out so the spec file stays under the 400-LOC cap; `git-fixture.ts` is
 * deliberately left as git-only, so the `.siltpoke` state half lives here.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrainOutput } from "../../src/brain/schema";
import type { RunCriticDeps } from "../../src/critic/run-critic";
import type { HookEvent } from "../../src/router/router";
import { BrainError, type BrainCallResult } from "../../src/brain/brain";
import { commitAll, headSha, makeGitRepo } from "./git-fixture";

export const noopUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  total_cost_usd: 0,
};

export function makeFakeBrainOutput(overrides: Partial<BrainOutput> = {}): BrainOutput {
  return {
    mood: "happy",
    pose: "base",
    bubble_short: "looks fine",
    severity: "info",
    confidence: "high",
    ...overrides,
  } as BrainOutput;
}

/** Assistant turn with only text — no tool_use — so the code-change gate vetoes. */
export function makeTranscriptNoEdit(dir: string): string {
  const transcriptPath = join(dir, "transcript-nocode.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "just chatting, no edits" }] },
    })}\n`,
  );
  return transcriptPath;
}

/** Assistant turn showing an Edit of `filePath`, so the code-change gate passes. */
export function makeTranscriptWithEdit(dir: string, filePath: string): string {
  const transcriptPath = join(dir, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", name: "Edit", input: { file_path: filePath } },
        ],
      },
    })}\n`,
  );
  return transcriptPath;
}

/** A git repo with pet state and an anchor pinned at its current HEAD. */
export function seedAnchoredRepo(
  home: string,
  name: string,
): { projectCwd: string; stateBase: string; baseHead: string } {
  const projectCwd = join(home, name);
  makeGitRepo(projectCwd);
  const stateBase = join(projectCwd, ".siltpoke");
  mkdirSync(stateBase, { recursive: true });
  // Seeded so the first-touch welcome branch is out of the picture.
  writeFileSync(
    join(stateBase, "state.json"),
    JSON.stringify({ schemaVersion: 1, mood: "happy", pose: "base", bubble_short: "hi" }),
  );
  // Pinned to the current HEAD so the gate has a real unit to name, rather
  // than falling into the range-less `anchor_unusable` path.
  const baseHead = headSha(projectCwd);
  writeFileSync(
    join(stateBase, "review-anchor.json"),
    JSON.stringify({ head: baseHead, tree: "", reviewedAt: new Date().toISOString() }),
  );
  return { projectCwd, stateBase, baseHead };
}

/** Commit a file, and write a transcript showing the agent editing it. */
export function commitAgentEdit(
  home: string,
  projectCwd: string,
  fileName: string,
  message: string,
): { movedHead: string; transcriptPath: string } {
  const editedPath = join(projectCwd, fileName);
  writeFileSync(editedPath, `export const x = "${fileName}";\n`);
  commitAll(projectCwd, message);
  return {
    movedHead: headSha(projectCwd),
    transcriptPath: makeTranscriptWithEdit(home, editedPath),
  };
}

export function anchorHead(stateBase: string): string {
  return JSON.parse(readFileSync(join(stateBase, "review-anchor.json"), "utf8")).head;
}

type Tools = Awaited<ReturnType<NonNullable<RunCriticDeps["runToolsFn"]>>>;

/** No tool produced usable output → HARD_SUPPRESS at the abstention floor. */
export function toolsAbstain(): Tools {
  return {
    tsc: { tool: "tsc", status: "not_applicable", parsed: [], raw: "" },
    eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
    "git-diff": { tool: "git-diff", status: "not_applicable", parsed: [], raw: "" },
    ripgrep: { tool: "ripgrep", status: "not_applicable", parsed: [], raw: "" },
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  };
}

/** A real finding → NORMAL, so the phase actually reaches the Brain. */
export function toolsWithFinding(): Tools {
  return {
    tsc: {
      tool: "tsc",
      status: "ok",
      parsed: [
        {
          file: "src/dummy.ts",
          line: 5,
          col: 1,
          severity: "error",
          code: "TS2322",
          message: "Type mismatch.",
        },
      ],
      raw: "src/dummy.ts(5,1): error TS2322",
    },
    eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
    "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
    ripgrep: { tool: "ripgrep", status: "not_applicable", parsed: [], raw: "" },
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  };
}

/**
 * Clean tools + diff hunks → PASSIVE_BUBBLE. Since gate step [1] only a change
 * with nothing reviewable in it gets there (a code hunk goes to NORMAL whatever
 * the tools said), so the hunk is a docs file.
 */
export function toolsCleanRefactor(): Tools {
  return {
    tsc: { tool: "tsc", status: "ok", parsed: [], raw: "" },
    eslint: { tool: "eslint", status: "ok", parsed: [], raw: "" },
    "git-diff": {
      tool: "git-diff",
      status: "ok",
      parsed: [
        {
          file: "clean-refactor.md",
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          header: "@@ -1,0 +1,1 @@",
          body: "+a line of docs",
        },
      ],
      raw: "@@ -1,0 +1,1 @@\n+a line of docs",
    },
    ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  };
}


/**
 * A Brain that fails the way a spawn failure does: `exitCode: null`, empty
 * streams, the message in `spawnError`. The payload is deliberately plain —
 * these tests inject the call, which bypasses the guarded wrapper that would
 * classify it, so a verbatim Windows stderr would be inert decoration that
 * reads like coverage the test does not have. Classification is tested for real
 * in tests/brain/failure-classify.test.ts.
 */
export function failingBrain(onCall: () => void): () => Promise<BrainCallResult> {
  return async () => {
    onCall();
    throw new BrainError("spawn failed", undefined, {
      exitCode: null,
      stderr: "",
      stdout: "",
      spawnError: "spawn failed",
    });
  };
}

/**
 * A provider that refuses BEFORE spawning anything — the agy over-cap shape: a
 * `code`, and deliberately no `failure` field, since no subprocess ever ran.
 */
export function abstainingBrain(onCall: () => void): () => Promise<BrainCallResult> {
  return async () => {
    onCall();
    throw new BrainError(
      "agy -p: merged prompt too large",
      undefined,
      undefined,
      "agy_prompt_too_large",
    );
  };
}

/** The Stop event these tests fire; only the four fields the hook reads. */
export function stopEvent(
  sessionId: string,
  projectCwd: string,
  transcriptPath: string,
): HookEvent {
  return {
    hook_event_name: "Stop",
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: projectCwd,
  };
}

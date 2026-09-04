// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Build-2 wiring integration tests.
 *
 * Exercises the REAL enqueue path (not a re-test of enqueuePending in
 * isolation): drives a full handleStopHook() call on the live
 * tool-augmented (SILTPOKE_TOOL_AUGMENTED=1) NORMAL-accepted branch, with
 * the Brain fully stubbed (AC8: no LLM call), and asserts the pending
 * queue on disk gets a real entry with a non-empty line fingerprint read
 * from a real file on disk.
 *
 * Harness mirrors tests/hooks/handle-stop.test.ts's
 * "tool-augmented path (flag ON)" describe block.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleStopHook } from "../../src/hooks/handle-stop";
import type { HookEvent } from "../../src/router/router";
import type { BrainOutput } from "../../src/brain/schema";
import type { BrainCallResult } from "../../src/brain/brain";
import type { RunCriticDeps } from "../../src/critic/run-critic";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";
import { readPending, pendingQueuePath } from "../../src/memory/pending-queue";
import { makeGitRepo } from "../_shared/git-fixture";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-b2wire-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function makeTranscriptWithEdit(dir: string, editedPath: string): string {
  const transcriptPath = join(dir, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", name: "Edit", input: { file_path: editedPath } },
        ],
      },
    })}\n`,
  );
  return transcriptPath;
}

function makeStopEvent(sessionId: string, transcriptPath: string, cwd: string): HookEvent {
  // The ⏱ review-unit gate asks git whether a unit of work closed, so a cwd
  // git knows nothing about is answered with `not_a_git_repo` before anything
  // else in this test can run. A real user's cwd is a repo; this makes the
  // fixture one too. See tests/_shared/git-fixture.ts.
  makeGitRepo(cwd);
  return {
    hook_event_name: "Stop",
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
  };
}

const noopUsage = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  input_tokens: 100,
  output_tokens: 50,
  total_cost_usd: 0.001,
};

function makeFakeBrainOutput(overrides?: Partial<BrainOutput>): BrainOutput {
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
    ...overrides,
  };
}

const m112Env = (homeDir: string): NodeJS.ProcessEnv => ({
  HOME: homeDir,
  SILTPOKE_TOOL_AUGMENTED: "1",
});

function makeWithTscError(
  snippet: string,
): Record<ToolName, ToolResult> & { securityFindings: never[]; owaspHints: never[]; webSearchSources: never[] } {
  return {
    tsc: {
      tool: "tsc",
      status: "ok",
      parsed: [
        {
          file: "x.ts",
          line: 3,
          col: 1,
          severity: "error",
          code: "TS2322",
          message: "Type mismatch.",
        },
      ],
      raw: `x.ts(3,1): error TS2322\n${snippet}`,
    },
    eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
    "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
    ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  };
}

describe("Build-2 wiring — enqueue on the live tool-augmented Stop-hook path", () => {
  test("NORMAL accepted with evidence → real file read, pending queue gets 1 entry with non-empty fingerprint", async () => {
    const projectCwd = join(tmpHome, "b2-normal");
    // Git-init BEFORE anything resolves a project root — creating `.git`
    // moves that root, and per-repo memory is keyed on it.
    makeGitRepo(projectCwd);
    mkdirSync(projectCwd, { recursive: true });

    // Real file on disk — the enqueue path reads THIS file's current
    // content to compute the line-content fingerprint (not a stub).
    const realFilePath = join(projectCwd, "x.ts");
    writeFileSync(
      realFilePath,
      ["const a = 1;", "const b = 2;", 'const y: number = "nope";', "const c = 3;"].join("\n") + "\n",
    );

    const transcriptPath = makeTranscriptWithEdit(tmpHome, realFilePath);
    const REAL_SNIPPET = 'const y: number = "nope";';

    let writeCritiqueCalled = false;

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(REAL_SNIPPET),
      callBrainFn: async (): Promise<BrainCallResult> => ({
        output: makeFakeBrainOutput({
          mood: "annoyed",
          bubble_short: "Type error found",
          severity: "medium",
          confidence: "high",
          evidence: [
            {
              tool: "tsc",
              file: "x.ts",
              line: 3,
              snippet: REAL_SNIPPET,
            },
          ],
        }),
        usage: noopUsage,
      }),
      writeCritiqueFn: async (_basePath, _input) => {
        writeCritiqueCalled = true;
        return { id: "c-b2-normal", path: join(projectCwd, ".siltpoke", "fake.md") };
      },
    };

    await handleStopHook(
      makeStopEvent("sess-b2-normal", transcriptPath, projectCwd),
      {
        env: m112Env(tmpHome),
        brainFn: async (): Promise<BrainCallResult> => ({
          output: makeFakeBrainOutput(),
          usage: noopUsage,
        }),
        m112Deps: deps,
        // Real spawnSync side effects on darwin — stub so this fired-path
        // test never shells out or pops a real notification.
        menubarDeps: { exec: () => {} },
      },
    );

    expect(writeCritiqueCalled).toBe(true);

    const stateBase = join(projectCwd, ".siltpoke");
    const pending = await readPending(pendingQueuePath(stateBase));

    expect(pending.length).toBe(1);
    expect(pending[0]!.critique_id).toBe("c-b2-normal");
    expect(pending[0]!.status).toBe("pending");
    expect(pending[0]!.anchors.length).toBe(1);
    expect(pending[0]!.anchors[0]!.file).toBe("x.ts");
    expect(pending[0]!.anchors[0]!.fingerprint).not.toBe("");
  });

  test("NORMAL accepted with evidence=[] → nothing enqueued, hook does not throw", async () => {
    // guardCritique rejects NORMAL-mode critiques with an empty evidence
    // array (see src/critic/evidence-guard.ts), so this exercises the
    // PASSIVE_BUBBLE-shaped "no evidence" branch via HARD_SUPPRESS instead —
    // confirms the enqueue guard (`out.evidence.length > 0`) never fires
    // and, more importantly, that the Build-2 wiring introduces no crash
    // when there is nothing to enqueue.
    const projectCwd = join(tmpHome, "b2-empty");
    // Git-init BEFORE anything resolves a project root — creating `.git`
    // moves that root, and per-repo memory is keyed on it.
    makeGitRepo(projectCwd);
    mkdirSync(projectCwd, { recursive: true });
    const dummyPath = join(tmpHome, "dummy.ts");
    writeFileSync(dummyPath, "export const dummy = 1;\n");
    const transcriptPath = makeTranscriptWithEdit(tmpHome, dummyPath);

    const deps: RunCriticDeps = {
      runToolsFn: async () => ({
        tsc: { tool: "tsc", status: "not_applicable", parsed: [], raw: "" },
        eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
        "git-diff": { tool: "git-diff", status: "not_applicable", parsed: [], raw: "" },
        ripgrep: { tool: "ripgrep", status: "not_applicable", parsed: [], raw: "" },
        securityFindings: [] as never[],
        owaspHints: [] as never[],
        webSearchSources: [] as never[],
      }),
      callBrainFn: async (): Promise<BrainCallResult> => ({
        output: makeFakeBrainOutput(),
        usage: noopUsage,
      }),
      writeCritiqueFn: async () => ({ id: "c-b2-empty", path: "/tmp" }),
    };

    await expect(
      handleStopHook(makeStopEvent("sess-b2-empty", transcriptPath, projectCwd), {
        env: m112Env(tmpHome),
        brainFn: async (): Promise<BrainCallResult> => ({
          output: makeFakeBrainOutput(),
          usage: noopUsage,
        }),
        m112Deps: deps,
        menubarDeps: { exec: () => {} },
      }),
    ).resolves.toBeUndefined();

    const stateBase = join(projectCwd, ".siltpoke");
    const pending = await readPending(pendingQueuePath(stateBase));
    expect(pending.length).toBe(0);
  });
});

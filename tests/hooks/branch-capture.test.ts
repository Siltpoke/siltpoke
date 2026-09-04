// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Track: menu-bar-pet, T1 — branch capture on fired brain-call rows.
 *
 * Part 1: parseCall — branch parses through / defaults to null (historical
 * rows never carried this field).
 * Part 2: handleStopHook — a fired (NORMAL accepted) row carries the branch
 * captured via the injectable opts.gitBranch seam (tests never shell out).
 */
import { expect, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseCall } from "../../src/state/critic-event-log-parse";
import {
  handleStopHook,
  defaultCaptureBranch,
} from "../../src/hooks/handle-stop";
import type { HookEvent } from "../../src/router/router";
import type { BrainOutput } from "../../src/brain/schema";
import type { CallBrainOptions, BrainCallResult } from "../../src/brain/brain";
import type { RunCriticDeps } from "../../src/critic/run-critic";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";
import { makeGitRepo } from "../_shared/git-fixture";

// ---------------------------------------------------------------------------
// Part 1: parseCall
// ---------------------------------------------------------------------------

test("branch parses when present", () => {
  const call = parseCall({
    timestamp: "2026-07-08T10:00:00Z",
    session_id: "s1",
    cwd: "/repo",
    critique_id: "c1",
    bubble_short: "x",
    severity: "low",
    branch: "feat/menubar",
  });
  expect(call?.branch).toBe("feat/menubar");
});

test("branch defaults to null when absent (historical row)", () => {
  const call = parseCall({
    timestamp: "2026-07-08T10:00:00Z",
    session_id: "s1",
    cwd: "/repo",
    bubble_short: "x",
  });
  expect(call?.branch).toBeNull();
});

// ---------------------------------------------------------------------------
// Part 2: handleStopHook fired-row branch capture
// ---------------------------------------------------------------------------

function makeTranscriptWithEdit(dir: string): string {
  const editedPath = join(dir, "dummy.ts");
  writeFileSync(editedPath, "export const dummy = 1;\n");
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

function makeStopEvent(
  sessionId: string,
  transcriptPath: string,
  cwd: string,
): HookEvent {
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

function makeWithTscError(snippet: string): Record<ToolName, ToolResult> & {
  securityFindings: never[];
  owaspHints: never[];
  webSearchSources: never[];
} {
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
      raw: `src/dummy.ts(5,1): error TS2322\n${snippet}`,
    },
    eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
    "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
    ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  };
}

test("fired row (NORMAL accepted) carries branch via injected opts.gitBranch seam", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-branch-cap-"));
  try {
    const projectCwd = join(tmpHome, "proj");
    // Git-init BEFORE anything resolves a project root — creating `.git`
    // moves that root, and per-repo memory is keyed on it.
    makeGitRepo(projectCwd);
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    const REAL_SNIPPET = "const x: string = 42;";

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
              file: "src/dummy.ts",
              line: 5,
              snippet: REAL_SNIPPET,
            },
          ],
        }),
        usage: noopUsage,
      }),
      writeCritiqueFn: async (_basePath, _input) => ({
        id: "c-branch-test",
        path: join(projectCwd, ".siltpoke", "fake.md"),
      }),
    };

    await handleStopHook(
      makeStopEvent("sess-branch", transcriptPath, projectCwd),
      {
        env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
        brainFn: async (_opts: CallBrainOptions): Promise<BrainCallResult> => ({
          output: makeFakeBrainOutput(),
          usage: noopUsage,
        }),
        m112Deps: deps,
        gitBranch: () => "feat/x",
        // T5 side effects (menu-bar refresh + osascript notification) are
        // real spawnSync calls on darwin — stub them so this test never
        // shells out or pops a real notification on the dev machine.
        menubarDeps: { exec: () => {} },
      },
    );

    const log = readFileSync(
      join(tmpHome, ".siltpoke", "brain-calls.jsonl"),
      "utf8",
    );
    const lines = log.trim().split("\n").filter((l) => l.length > 0);
    const firedLine = lines
      .map((l) => JSON.parse(l))
      .find((row) => row.critic_path_decision === "NORMAL" && row.m112_accepted === true);
    expect(firedLine).toBeDefined();
    expect(firedLine.branch).toBe("feat/x");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Slice B (T4): authorFamily capture on fired rows — the builder-family the
// timeline/swiftbar tag reads. Sourced from brain-config's authorFamily; here
// via config.author_family (the SILTPOKE_HOST path is proven by the live AC1
// smoke + brain-config unit tests). Persisted independent of the reviewer
// provider so the tag survives a reviewer override.
// ---------------------------------------------------------------------------

test("fired row carries authorFamily = the builder host (SILTPOKE_HOST)", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-authorfam-"));
  const prevHost = process.env.SILTPOKE_HOST;
  process.env.SILTPOKE_HOST = "codebuddy"; // builder host this run
  try {
    const projectCwd = join(tmpHome, "proj");
    // Git-init BEFORE anything resolves a project root — creating `.git`
    // moves that root, and per-repo memory is keyed on it.
    makeGitRepo(projectCwd);
    const transcriptPath = makeTranscriptWithEdit(tmpHome);
    const REAL_SNIPPET = "const x: string = 42;";

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(REAL_SNIPPET),
      callBrainFn: async (): Promise<BrainCallResult> => ({
        output: makeFakeBrainOutput({
          mood: "annoyed",
          bubble_short: "Type error found",
          severity: "medium",
          confidence: "high",
          evidence: [{ tool: "tsc", file: "src/dummy.ts", line: 5, snippet: REAL_SNIPPET }],
        }),
        usage: noopUsage,
      }),
      writeCritiqueFn: async (_basePath, _input) => ({
        id: "c-authorfam-test",
        path: join(projectCwd, ".siltpoke", "fake.md"),
      }),
    };

    await handleStopHook(makeStopEvent("sess-authorfam", transcriptPath, projectCwd), {
      env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
      brainFn: async (): Promise<BrainCallResult> => ({ output: makeFakeBrainOutput(), usage: noopUsage }),
      m112Deps: deps,
      gitBranch: () => "feat/x",
      menubarDeps: { exec: () => {} },
    });

    const log = readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8");
    const firedLine = log
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
      .find((row) => row.critic_path_decision === "NORMAL" && row.m112_accepted === true);
    expect(firedLine).toBeDefined();
    expect(firedLine.authorFamily).toBe("codebuddy");
  } finally {
    if (prevHost === undefined) delete process.env.SILTPOKE_HOST;
    else process.env.SILTPOKE_HOST = prevHost;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Part 3: the REAL default branch-capture guard (no injected stub) — this is
// the production shell-out path that every other test bypasses via
// opts.gitBranch. Exercises the two guard arms directly.
// ---------------------------------------------------------------------------

test("defaultCaptureBranch → null for a fresh non-git dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-nongit-"));
  try {
    // No `git init` — `git rev-parse` exits non-zero, guard returns null.
    expect(defaultCaptureBranch(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultCaptureBranch → non-null branch string in a real git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-gitrepo-"));
  try {
    const run = (args: string[]): void => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
      }
    };
    // -b main pins the branch name so the assertion is deterministic across
    // machines whose git init.defaultBranch differs (master vs main).
    run(["init", "-b", "main"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    writeFileSync(join(dir, "f.txt"), "x\n");
    run(["add", "f.txt"]);
    run(["commit", "-m", "init"]);

    expect(defaultCaptureBranch(dir)).toBe("main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

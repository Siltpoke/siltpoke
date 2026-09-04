// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Does the Stop hook actually hand the critic a confined changed-file set?
//
// tests/router/changed-files-confine.test.ts proves the extractor filters.
// This proves the HOOK asks it to — a distinction that matters here because
// every pre-existing handle-stop test edits a file in the tmp root while its
// cwd is a subdirectory, so all of them land in the all-dropped fail-safe and
// none of them ever exercise the filter. A green handle-stop suite says nothing
// about this wiring; only an assertion on what runTools receives does.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleStopHook } from "../../src/hooks/handle-stop";
import type { HookEvent } from "../../src/router/router";
import type { RunCriticDeps } from "../../src/critic/run-critic";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";
import type { BrainCallResult } from "../../src/brain/brain";
import type { BrainOutput } from "../../src/brain/schema";
import { makeGitRepo } from "../_shared/git-fixture";

let tmpHome: string;
let projectCwd: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-confine-hook-"));
  projectCwd = join(tmpHome, "proj");
  // A real repo: the ⏱ review-unit gate answers a non-repo cwd with
  // `not_a_git_repo` and skips before the critic runs at all.
  makeGitRepo(projectCwd);
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function transcriptEditing(paths: string[]): string {
  const p = join(tmpHome, "transcript.jsonl");
  writeFileSync(
    p,
    JSON.stringify({
      type: "assistant",
      message: {
        content: paths.map((file_path) => ({
          type: "tool_use",
          name: "Edit",
          input: { file_path },
        })),
      },
    }) + "\n",
  );
  return p;
}

const allNotApplicable = (): Record<ToolName, ToolResult> & {
  securityFindings: never[]; owaspHints: never[]; webSearchSources: never[];
} => ({
  tsc: { tool: "tsc", status: "not_applicable", parsed: [], raw: "" },
  eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
  "git-diff": { tool: "git-diff", status: "not_applicable", parsed: [], raw: "" },
  ripgrep: { tool: "ripgrep", status: "not_applicable", parsed: [], raw: "" },
  securityFindings: [], owaspHints: [], webSearchSources: [],
});

const fakeBrain: BrainOutput = {
  mood: "happy", pose: "base", bubble_short: "ok", bubble_long: "",
  critique_for_claude: "something actionable", severity: "medium",
  confidence: "high", xp_earned_events: [], evidence: [],
};

/** Run the hook and return the changed-file list the critic's tool stage saw. */
async function changedFilesSeenByCritic(
  transcriptPath: string,
  overrides?: Partial<HookEvent> & { cwd?: string },
): Promise<string[]> {
  let seen: string[] | null = null;
  const deps: RunCriticDeps = {
    runToolsFn: async (args: { changedFiles: string[] }) => {
      seen = args.changedFiles;
      return allNotApplicable();
    },
    callBrainFn: async (): Promise<BrainCallResult> => ({
      output: fakeBrain,
      usage: {
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        input_tokens: 10, output_tokens: 5, total_cost_usd: 0.001,
      },
    }),
    writeCritiqueFn: async () => ({ id: "c-confine", path: join(tmpHome, "c.md") }),
  };
  const event: HookEvent = {
    hook_event_name: "Stop",
    session_id: "sess-confine",
    transcript_path: transcriptPath,
    cwd: projectCwd,
    ...overrides,
  };
  await handleStopHook(event, {
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
    m112Deps: deps,
    menubarDeps: { exec: () => {} },
  });
  if (seen === null) throw new Error("runToolsFn never ran — the hook took another path");
  return seen;
}

test("the /tmp build log never reaches the critic, the real edit does", async () => {
  const real = join(projectCwd, "real.ts");
  writeFileSync(real, "export const a = 1;\n");
  const log = join(tmpHome, "ci-2-signal.log");
  writeFileSync(log, "x\n".repeat(600)); // the god-file shape, on disk so pruneMissing keeps it
  const seen = await changedFilesSeenByCritic(transcriptEditing([real, log]));
  expect(seen).toContain(real);
  expect(seen).not.toContain(log);
});

test("agy `-p` with a wrong cwd: the re-anchor still finds the repo, and the critic still sees the real edit", async () => {
  // The confinement must NOT run before the cwd re-anchor. If it did, every
  // path would resolve outside the (wrong) payload cwd, the all-dropped
  // fail-safe would hand the list back unfiltered, and `resolveHostCwd` would
  // anchor on the LEXICOGRAPHICALLY first absolute path — `unionPaths` sorts,
  // so `<tmp>/aaa-build.log` beats `<tmp>/realrepo/token.ts`. The review cwd
  // would become the log's own directory and the second, post-re-anchor
  // confinement would then drop the real edit as "outside", leaving the critic
  // reviewing nothing but the build log. That is the bug this file fixes,
  // re-entering through the wiring.
  const repo = join(tmpHome, "realrepo");
  // A REAL repo, not a bare `.git` marker — `rev-parse HEAD` has to work.
  makeGitRepo(repo);
  const edited = join(repo, "token.ts");
  writeFileSync(edited, "export const x = 1;\n");
  const wrongCwd = join(tmpHome, "gemini-config"); // stands in for ~/.gemini/config
  makeGitRepo(wrongCwd);
  const log = join(tmpHome, "aaa-build.log"); // sorts BEFORE realrepo/
  writeFileSync(log, "x\n".repeat(600));

  const seen = await changedFilesSeenByCritic(transcriptEditing([edited, log]), {
    cwd: wrongCwd,
    siltpoke_host: "antigravity",
  });
  expect(seen).toContain(edited);
  expect(seen).not.toContain(log);
});

test("positive control: with the real edit removed, the fail-safe hands the log through", async () => {
  // Confirms the assertion above is the filter firing, not the log being
  // dropped for some unrelated reason (missing on disk, parse failure).
  const log = join(tmpHome, "ci-2-signal.log");
  writeFileSync(log, "x\n".repeat(600));
  const seen = await changedFilesSeenByCritic(transcriptEditing([log]));
  expect(seen).toEqual([log]);
});

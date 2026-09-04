// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Wires `buildAntiExamplesBlock` (src/few-shot/inject.ts)
 * into `buildPromptContext` (src/hooks/handle-stop.ts). Before this wiring,
 * `assembleSystemPromptWithFunnel` was NEVER called with a populated
 * `antiExamplesBlock`, so the ANTI_EXAMPLES fence — despite being fully
 * implemented in prompt-assembly.ts — could never fire. Brain kept
 * re-raising critiques the user had already dismissed.
 *
 * Exercises the REAL seam: `buildPromptContext` reads a real
 * `<homeBase>/few-shot-index.json` off disk (via `buildAntiExamplesBlock` →
 * `getAntiExamples` → `loadIndex`), so a fixture seeded here proves the
 * production code path, not a mock echoing itself.
 *
 * `SILTPOKE_EMBED_STUB=1` forces the deterministic hash-based stub embedder
 * (see src/few-shot/embedder.ts `defaultEmbedder` — the same env var already
 * used by tests/cli/demo-seed.test.ts) so similarity is exact and
 * reproducible instead of depending on the real ONNX model.
 */
process.env.SILTPOKE_EMBED_STUB = "1";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPromptContext, handleStopHook } from "../../src/hooks/handle-stop";
import { packContext } from "../../src/router/context";
import { DEFAULT_COST_CONFIG } from "../../src/brain/cost-config";
import { saveIndex } from "../../src/few-shot/index";
import { createStubEmbedder } from "../../src/few-shot/embedder";
import type { FewShotIndexEntry } from "../../src/few-shot/types";
import type { HookEvent } from "../../src/router/router";
import type { BrainCallResult, CallBrainOptions } from "../../src/brain/brain";
import type { BrainOutput } from "../../src/brain/schema";
import type { RunCriticDeps } from "../../src/critic/run-critic";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";
import { makeGitRepo } from "../_shared/git-fixture";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-anti-examples-wiring-"));
  mkdirSync(join(tmpHome, ".siltpoke"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function stopEvent(cwd: string): HookEvent {
  // The ⏱ review-unit gate asks git whether a unit of work closed, so a cwd
  // git knows nothing about is answered with `not_a_git_repo` before anything
  // else in this test can run. A real user's cwd is a repo; this makes the
  // fixture one too. See tests/_shared/git-fixture.ts.
  makeGitRepo(cwd);
  return {
    hook_event_name: "Stop",
    session_id: "sess-anti-examples",
    transcript_path: join(cwd, "transcript.jsonl"),
    cwd,
  };
}

const embedder = createStubEmbedder();

/** The current review's diff bundle — this is `queryText` in production (see wiring). */
const BUNDLE_TEXT = `diff --git a/src/foo.ts b/src/foo.ts
@@ -1,3 +1,3 @@
-function foo(x: any) { return x; }
+function foo(x: unknown) { return x; }
`;

function makeMatchingEntries(qvec: number[], count: number): FewShotIndexEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `dismissed-${i}`,
    embedding: qvec,
    signal: "dismiss" as const,
    reason_text: "already intentional, not a bug",
    critique_summary: "Flagged 'any' type usage — user dismissed as intentional",
    ts: "2026-07-01T00:00:00Z",
  }));
}

function makeUnrelatedEntries(count: number): FewShotIndexEntry[] {
  // One-hot vectors in dimensions the stub embedder's hash-based output for
  // BUNDLE_TEXT is vanishingly unlikely to concentrate mass on — deterministic
  // low similarity, not a hash-collision assumption (mirrors the established
  // pattern in tests/few-shot/inject.test.ts).
  return Array.from({ length: count }, (_, i) => ({
    id: `unrelated-${i}`,
    embedding: new Array(384).fill(0).map((_v, d) => (d === i ? 1 : 0)),
    signal: "dismiss" as const,
    reason_text: null,
    critique_summary: "Flagged an unrelated database migration concern",
    ts: "2026-07-01T00:00:00Z",
  }));
}

test("positive control: a relevant dismissed critique surfaces the ANTI_EXAMPLES fence", async () => {
  const projectCwd = join(tmpHome, "proj");
  // Git-init BEFORE anything resolves a project root — creating `.git`
  // moves that root, and per-repo memory is keyed on it.
  makeGitRepo(projectCwd);
  mkdirSync(projectCwd, { recursive: true });

  const qvec = await embedder.embed(BUNDLE_TEXT);
  await saveIndex(
    makeMatchingEntries(qvec, 10),
    join(tmpHome, ".siltpoke", "few-shot-index.json"),
  );

  const ctx = await buildPromptContext(
    join(tmpHome, ".siltpoke"),
    stopEvent(projectCwd),
    BUNDLE_TEXT,
    DEFAULT_COST_CONFIG,
  );

  expect(ctx.systemPrompt).toContain("ANTI_EXAMPLES");
  expect(ctx.systemPrompt).toContain("User dismissed similar past critiques");
  expect(ctx.systemPrompt).toContain("already intentional, not a bug");
});

test("negative control: only unrelated dismissed critiques do NOT surface the fence", async () => {
  const projectCwd = join(tmpHome, "proj");
  // Git-init BEFORE anything resolves a project root — creating `.git`
  // moves that root, and per-repo memory is keyed on it.
  makeGitRepo(projectCwd);
  mkdirSync(projectCwd, { recursive: true });

  await saveIndex(
    makeUnrelatedEntries(10),
    join(tmpHome, ".siltpoke", "few-shot-index.json"),
  );

  const ctx = await buildPromptContext(
    join(tmpHome, ".siltpoke"),
    stopEvent(projectCwd),
    BUNDLE_TEXT,
    DEFAULT_COST_CONFIG,
  );

  expect(ctx.systemPrompt).not.toContain("ANTI_EXAMPLES");
  expect(ctx.systemPrompt).not.toContain("User dismissed similar past critiques");
});

test("negative control: no few-shot index at all does NOT surface the fence", async () => {
  const projectCwd = join(tmpHome, "proj");
  // Git-init BEFORE anything resolves a project root — creating `.git`
  // moves that root, and per-repo memory is keyed on it.
  makeGitRepo(projectCwd);
  mkdirSync(projectCwd, { recursive: true });
  // No few-shot-index.json written at all — loadIndex() returns [] and the
  // MIN_ENTRIES gate short-circuits before any similarity check.

  const ctx = await buildPromptContext(
    join(tmpHome, ".siltpoke"),
    stopEvent(projectCwd),
    BUNDLE_TEXT,
    DEFAULT_COST_CONFIG,
  );

  expect(ctx.systemPrompt).not.toContain("ANTI_EXAMPLES");
});

// ---------------------------------------------------------------------------
// Default-path (tool-augmented) wiring — Task B critical #1 fix.
//
// The tests above exercise `buildPromptContext` directly, which is exactly
// what a review found insufficient: `buildPromptContext`'s OWN returned
// `systemPrompt` is only ever consumed by the legacy
// (`SILTPOKE_TOOL_AUGMENTED=0`) fallback path. Under the DEFAULT config,
// `handleStopHook` takes the tool-augmented branch, which assembles its OWN
// system prompt a second time inside `runNormalPhase`
// (src/critic/phases/normal.ts) — and that second assembly never received
// the anti-examples block before this fix. These tests drive the real
// `handleStopHook` entry point (SILTPOKE_TOOL_AUGMENTED left at its default,
// "1") and capture the systemPrompt actually handed to the Brain call via an
// injected `callBrainFn`, so a regression that re-severs the
// `antiExamplesBlock` thread (BrainContext → runNormalPhase →
// assembleSystemPromptWithFunnel) fails this test even though
// `buildPromptContext`'s own return value would still look correct.
// ---------------------------------------------------------------------------

const REAL_SNIPPET = "const x: string = 42;";

function fakeBrainOutput(): BrainOutput {
  return {
    mood: "annoyed",
    pose: "base",
    bubble_short: "Type error found",
    bubble_long: "",
    critique_for_claude: "something actionable",
    severity: "medium",
    confidence: "high",
    xp_earned_events: [],
    // Evidence guard requires a verbatim substring of the tool corpus; a
    // real snippet keeps this test in the NORMAL/accepted branch rather than
    // being rejected before it tells us anything about wiring.
    evidence: [{ tool: "tsc", file: "src/dummy.ts", line: 5, snippet: REAL_SNIPPET }],
    reasoning: "test fixture",
  };
}

/** tsc finding fixture that routes runCritic into the NORMAL phase (not PASSIVE_BUBBLE/HARD_SUPPRESS). */
function toolsWithFinding(): Record<ToolName, ToolResult> & {
  securityFindings: never[];
  owaspHints: never[];
  webSearchSources: never[];
} {
  return {
    tsc: {
      tool: "tsc",
      status: "ok",
      parsed: [{ file: "src/dummy.ts", line: 5, col: 1, severity: "error", code: "TS2322", message: "Type mismatch." }],
      raw: `src/dummy.ts(5,1): error TS2322\n${REAL_SNIPPET}`,
    },
    eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
    "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
    ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  };
}

/** Transcript whose only tool_use edits a .ts file, so the code-change gate fires. */
function seedTranscript(dir: string): string {
  const edited = join(dir, "dummy.ts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(edited, "export const dummy = 1;\n");
  const transcriptPath = join(dir, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "changed foo(x: any) to foo(x: unknown)" },
          { type: "tool_use", name: "Edit", input: { file_path: edited } },
        ],
      },
    })}\n`,
  );
  return transcriptPath;
}

/**
 * Precomputes the exact bundle text `buildPromptContext` will embed for this
 * session — packContext() is a pure function of (session_id, cwd,
 * transcript contents), so calling it here with the SAME inputs
 * `handleStopHook` will use is not a mock: it is reading the real production
 * input in advance so the seeded index actually matches on retrieval.
 */
async function precomputeBundleText(sessionId: string, cwd: string, transcriptPath: string): Promise<string> {
  const bundle = await packContext({
    session_id: sessionId,
    cwd,
    transcript_path: transcriptPath,
    maxTurns: DEFAULT_COST_CONFIG.maxTranscriptTurns,
  });
  return bundle.text;
}

function stopEventFor(sessionId: string, transcriptPath: string, cwd: string): HookEvent {
  // The ⏱ review-unit gate asks git whether a unit of work closed, so a cwd
  // git knows nothing about is answered with `not_a_git_repo` before anything
  // else in this test can run. A real user's cwd is a repo; this makes the
  // fixture one too. See tests/_shared/git-fixture.ts.
  makeGitRepo(cwd);
  return { hook_event_name: "Stop", session_id: sessionId, transcript_path: transcriptPath, cwd };
}

test("default (tool-augmented) path: ANTI_EXAMPLES reaches runNormalPhase's assembled prompt", async () => {
  const projectCwd = join(tmpHome, "proj-default-path-2");
  // Git-init BEFORE anything resolves a project root — creating `.git`
  // moves that root, and per-repo memory is keyed on it.
  makeGitRepo(projectCwd);
  const transcriptPath = seedTranscript(projectCwd);
  const sessionId = "sess-default-path-2";

  const bundleText = await precomputeBundleText(sessionId, projectCwd, transcriptPath);
  const qvec = await embedder.embed(bundleText);
  await saveIndex(
    makeMatchingEntries(qvec, 10),
    join(tmpHome, ".siltpoke", "few-shot-index.json"),
  );

  let capturedSystemPrompt = "";
  const deps: RunCriticDeps = {
    runToolsFn: async () => toolsWithFinding(),
    callBrainFn: async (opts: CallBrainOptions): Promise<BrainCallResult> => {
      capturedSystemPrompt = opts.systemPrompt;
      return {
        output: fakeBrainOutput(),
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          input_tokens: 100,
          output_tokens: 50,
          total_cost_usd: 0.001,
        },
      };
    },
    writeCritiqueFn: async () => ({ id: "c-default-path-2", path: join(projectCwd, ".siltpoke", "fake.md") }),
  };

  await handleStopHook(stopEventFor(sessionId, transcriptPath, projectCwd), {
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
    m112Deps: deps,
    gitBranch: () => null,
    menubarDeps: { exec: () => {} },
  });

  expect(capturedSystemPrompt).toContain("ANTI_EXAMPLES");
  expect(capturedSystemPrompt).toContain("User dismissed similar past critiques");
  expect(capturedSystemPrompt).toContain("already intentional, not a bug");
});

test("default (tool-augmented) path: unrelated dismissals do NOT surface ANTI_EXAMPLES in runNormalPhase's prompt", async () => {
  const projectCwd = join(tmpHome, "proj-default-path-3");
  // Git-init BEFORE anything resolves a project root — creating `.git`
  // moves that root, and per-repo memory is keyed on it.
  makeGitRepo(projectCwd);
  const transcriptPath = seedTranscript(projectCwd);
  const sessionId = "sess-default-path-3";

  await saveIndex(
    makeUnrelatedEntries(10),
    join(tmpHome, ".siltpoke", "few-shot-index.json"),
  );

  let capturedSystemPrompt = "";
  const deps: RunCriticDeps = {
    runToolsFn: async () => toolsWithFinding(),
    callBrainFn: async (opts: CallBrainOptions): Promise<BrainCallResult> => {
      capturedSystemPrompt = opts.systemPrompt;
      return {
        output: fakeBrainOutput(),
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          input_tokens: 100,
          output_tokens: 50,
          total_cost_usd: 0.001,
        },
      };
    },
    writeCritiqueFn: async () => ({ id: "c-default-path-3", path: join(projectCwd, ".siltpoke", "fake.md") }),
  };

  await handleStopHook(stopEventFor(sessionId, transcriptPath, projectCwd), {
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
    m112Deps: deps,
    gitBranch: () => null,
    menubarDeps: { exec: () => {} },
  });

  expect(capturedSystemPrompt.length).toBeGreaterThan(0); // sanity: NORMAL phase did run
  expect(capturedSystemPrompt).not.toContain("ANTI_EXAMPLES");
});

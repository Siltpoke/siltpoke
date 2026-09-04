// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The user's own words reach the telemetry ROW on the live critic path.
 *
 * Until 2026-08-19 `user_raw_query` / `agent_reply` were written ONLY into the
 * v2 sidecar, which exists only when a critique is filed: 19 of the 400 most
 * recent fired reviews on a measured store, 4.8% (snapshot
 * `scripts/probes/critic-audit-coverage-probe-output-2026-08-19T19Z.txt` §4).
 * Block A's "WHAT I READ"
 * therefore said "not captured" on the other 95.3%, and no renderer change
 * could fix it — the text was never written down.
 *
 * The assertion is on the PERSISTED JSONL, not on an in-process value, for the
 * same reason `memory-funnel-telemetry.test.ts` gives: a field computed
 * correctly and never landed on the row is indistinguishable from a field that
 * measured nothing. That is the failure this whole track is about.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainCallResult } from "../../src/brain/brain";
import type { BrainOutput } from "../../src/brain/schema";
import type { RunCriticDeps } from "../../src/critic/run-critic";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";
import { handleStopHook } from "../../src/hooks/handle-stop";
import { emptyGlobal, writeGlobal } from "../../src/memory/global";
import { emptyMemory, writeMemory } from "../../src/memory/memory";
import type { HookEvent } from "../../src/router/router";
import { parseCall } from "../../src/state/critic-event-log-parse";
import { makeGitRepo } from "../_shared/git-fixture";

const noopUsage = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  input_tokens: 100,
  output_tokens: 50,
  total_cost_usd: 0.001,
};

const REAL_SNIPPET = "const x: string = 42;";
const USER_QUERY = "why does the rubric checklist disappear on most reviews";
const AGENT_REPLY = "Because Block A returned a placeholder before reading the row.";

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
    evidence: [{ tool: "tsc", file: "src/dummy.ts", line: 5, snippet: REAL_SNIPPET }],
    reasoning: "test fixture",
  };
}

function toolsWithFinding(): Record<ToolName, ToolResult> & {
  securityFindings: never[];
  owaspHints: never[];
  webSearchSources: never[];
} {
  return {
    tsc: {
      tool: "tsc",
      status: "ok",
      parsed: [
        { file: "src/dummy.ts", line: 5, col: 1, severity: "error", code: "TS2322", message: "Type mismatch." },
      ],
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

/**
 * A transcript with a REAL user turn ahead of the agent's reply — that pairing
 * is what `captureIntent` walks, and a transcript with only an assistant entry
 * would make every assertion here pass for the wrong reason (null in, null
 * out, no wiring exercised).
 */
function seedTranscript(dir: string, userText: string): string {
  const edited = join(dir, "dummy.ts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(edited, "export const dummy = 1;\n");
  const transcriptPath = join(dir, "transcript.jsonl");
  // The prose reply and the tool call are separate assistant entries on
  // purpose: `extractAssistantText` appends a "[tool Edit] <path>" line to
  // whatever text shares its message, and `captureIntent` takes the first
  // PARAGRAPH — so a combined entry would fold the temp-dir path into the
  // quote and the assertion below would be pinning that, not the reply.
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: userText } }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: AGENT_REPLY }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Edit", input: { file_path: edited } }],
      },
    }),
  ];
  writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
  return transcriptPath;
}

async function runLiveStop(
  tmpHome: string,
  projectCwd: string,
  sessionId: string,
  userText: string,
): Promise<Record<string, unknown>[]> {
  const transcriptPath = seedTranscript(projectCwd, userText);
  const deps: RunCriticDeps = {
    runToolsFn: async () => toolsWithFinding(),
    callBrainFn: async (): Promise<BrainCallResult> => ({ output: fakeBrainOutput(), usage: noopUsage }),
    writeCritiqueFn: async () => ({ id: "c-intent", path: join(projectCwd, ".siltpoke", "fake.md") }),
  };

  const event: HookEvent = {
    hook_event_name: "Stop",
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: projectCwd,
  };

  await handleStopHook(event, {
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
    brainFn: async (): Promise<BrainCallResult> => ({ output: fakeBrainOutput(), usage: noopUsage }),
    m112Deps: deps,
    gitBranch: () => null,
    menubarDeps: { exec: () => {} },
  });

  return readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function setupHome(): Promise<{ tmpHome: string; projectCwd: string }> {
  const tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-captured-intent-"));
  const projectCwd = join(tmpHome, "proj");
  // Git-init BEFORE anything resolves a project root — creating `.git`
  // moves that root, and per-repo memory is keyed on it.
  makeGitRepo(projectCwd);
  mkdirSync(join(tmpHome, ".siltpoke"), { recursive: true });
  await writeGlobal(join(tmpHome, ".siltpoke"), emptyGlobal());
  await writeMemory(join(tmpHome, ".siltpoke"), emptyMemory(), projectCwd);
  return { tmpHome, projectCwd };
}

test("live path: the row carries the user's question and the agent's reply", async () => {
  const { tmpHome, projectCwd } = await setupHome();
  try {
    const rows = await runLiveStop(tmpHome, projectCwd, "sess-intent", USER_QUERY);
    const fired = rows.find((r) => r.critic_path_decision !== undefined);
    expect(fired).toBeDefined();

    // Exact text, not "is a string": a wiring mutation pointing this field at
    // any other captured string would survive a type check.
    expect(fired!.user_raw_query).toBe(USER_QUERY);
    expect(fired!.agent_reply).toBe(AGENT_REPLY);
    // Nothing was cut, so the flag must be ABSENT rather than false — the
    // parser treats an orphan flag as noise, and a row that always carries it
    // would make "this one was truncated" unreadable.
    expect(fired!.user_raw_query_truncated).toBeUndefined();
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("live path: the row a reader gets back carries the words, with no sidecar involved", async () => {
  // The end-to-end claim: write the row, read it through the same parser the
  // dashboard uses, and get the text. `attachV2Sidecars` never runs here.
  const { tmpHome, projectCwd } = await setupHome();
  try {
    const rows = await runLiveStop(tmpHome, projectCwd, "sess-intent-2", USER_QUERY);
    const fired = rows.find((r) => r.critic_path_decision !== undefined);
    const call = parseCall(fired!);
    expect(call).not.toBeNull();
    expect(call!.v2).toBeNull();
    expect(call!.user_raw_query).toBe(USER_QUERY);
    expect(call!.agent_reply).toBe(AGENT_REPLY);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("live path: the cap is exclusive — exactly 2000 chars is not flagged", async () => {
  // The boundary itself, not a value far past it. The only test here used 2500,
  // so a mutation from `>` to `>=` would have flagged an uncut query as cut and
  // survived the whole suite.
  const { tmpHome, projectCwd } = await setupHome();
  try {
    const exact = "a".repeat(2000);
    const rows = await runLiveStop(tmpHome, projectCwd, "sess-intent-exact", exact);
    const fired = rows.find((r) => r.critic_path_decision !== undefined);
    expect((fired!.user_raw_query as string).length).toBe(2000);
    expect(fired!.user_raw_query).toBe(exact);
    expect(fired!.user_raw_query_truncated).toBeUndefined();
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("live path: one character past the cap IS flagged", async () => {
  const { tmpHome, projectCwd } = await setupHome();
  try {
    const overBy1 = `${"a".repeat(2000)}b`;
    const rows = await runLiveStop(tmpHome, projectCwd, "sess-intent-2001", overBy1);
    const fired = rows.find((r) => r.critic_path_decision !== undefined);
    expect((fired!.user_raw_query as string).length).toBe(2000);
    expect(fired!.user_raw_query_truncated).toBe(true);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("live path: an over-long question is capped on the row and says so", async () => {
  const { tmpHome, projectCwd } = await setupHome();
  try {
    // 2500 chars of a single paragraph — `captureIntent` leaves the query
    // uncapped, so without the row cap this whole string would ride the
    // append-only log on every review.
    const long = `${"a".repeat(2499)}b`;
    const rows = await runLiveStop(tmpHome, projectCwd, "sess-intent-long", long);
    const fired = rows.find((r) => r.critic_path_decision !== undefined);

    expect((fired!.user_raw_query as string).length).toBe(2000);
    expect(fired!.user_raw_query_truncated).toBe(true);
    // The stored text is a genuine prefix — the cap must not smuggle in an
    // ellipsis, because the page labels this field "verbatim".
    expect(fired!.user_raw_query).toBe(long.slice(0, 2000));
    expect(fired!.user_raw_query as string).not.toContain("…");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

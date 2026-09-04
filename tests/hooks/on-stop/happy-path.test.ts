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
import { writeMemory, emptyMemory } from "../../../src/memory/memory";
import { writeGlobal, emptyGlobal } from "../../../src/memory/global";
import { seedEditedFile } from "./_shared";
import { commitAll } from "../../_shared/git-fixture";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-hook-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test("successful Brain call writes state.json and critique markdown", async () => {
  const transcriptPath = join(tmpHome, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }, { type: "tool_use", name: "Edit", input: { file_path: "src/dummy.ts" } }] },
    })}\n`,
  );

  const projectCwd = join(tmpHome, "proj");
  seedEditedFile(projectCwd);

  const event = {
    hook_event_name: "Stop",
    session_id: "sess-abc",
    transcript_path: transcriptPath,
    cwd: projectCwd,
  };

  const fakeBrain: BrainOutput = {
    mood: "annoyed",
    pose: "arms_crossed",
    bubble_short: "I have concerns",
    bubble_long: "",
    critique_for_claude: "queries.py:47 bad join",
    severity: "medium",
    confidence: "high",
    xp_earned_events: [],
    evidence: [],
      reasoning: "test fixture",
  };

  await runHook({
    rawJson: JSON.stringify(event),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async () => ({
      output: fakeBrain,
      usage: {
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 0,
        input_tokens: 100,
        output_tokens: 200,
        total_cost_usd: 0.001,
      },
    }),
  });

  const home = join(tmpHome, ".siltpoke");

  // state.json written under the project cwd, NOT global home
  const stateRaw = readFileSync(
    join(projectCwd, ".siltpoke", "state.json"),
    "utf8",
  );
  const state = JSON.parse(stateRaw);
  expect(state.schemaVersion).toBe(1);
  expect(state.mood).toBe("annoyed");
  expect(state.bubble_short).toBe("I have concerns");
  expect(state.last_session_id).toBe("sess-abc");
  // global home must not have a state.json — isolation guarantee
  expect(existsSync(join(home, "state.json"))).toBe(false);

  // critique markdown written under today's archive dir — per-project,
  // landing in {cwd}/.siltpoke/critiques/ not the global home.
  const today = new Date().toISOString().slice(0, 10);
  const archiveDir = join(projectCwd, ".siltpoke", "critiques", "archive", today);
  expect(existsSync(archiveDir)).toBe(true);

  // history.jsonl has at least one line
  const history = readFileSync(
    join(projectCwd, ".siltpoke", "critiques", "history.jsonl"),
    "utf8",
  );
  expect(history.trim().split("\n").length).toBeGreaterThanOrEqual(1);

  // brain-calls.jsonl entry mentions critique_id and state_written
  const log = readFileSync(join(home, "brain-calls.jsonl"), "utf8");
  expect(log).toContain('"state_written":true');
  expect(log).toMatch(/"critique_id":"c-[0-9a-f]{4}"/);
});

test("hook injects memory + recent into the prompt passed to Brain", async () => {
  const transcriptPath = join(tmpHome, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }, { type: "tool_use", name: "Edit", input: { file_path: "src/dummy.ts" } }] },
    })}\n`,
  );

  const home = join(tmpHome, ".siltpoke");
  const fs = await import("node:fs");
  fs.mkdirSync(home, { recursive: true });

  // Memory tier 1 (facts/rules) lives in the canonical V3 store at homeBase
  // — flip home to V3 by writing global.json, then writeMemory scopes the
  // per-project slice internally via resolveProjectRoot(event.cwd) — the
  // repo that fires the Stop event, threaded explicitly (HIGH-finding fix)
  // rather than resolved from the daemon's own process.cwd(). Seed the fact
  // under projectCwd, the SAME cwd the Stop event below fires with, so the
  // critic's read resolves to this slice. recent_feedback.jsonl is a
  // separate, per-project-cwd-resolved stream unaffected by the V3 split
  // (see resolveRecentPath) and stays seeded under {projectCwd}/.siltpoke/.
  await writeGlobal(home, emptyGlobal());
  const projectCwd = join(tmpHome, "proj");
  seedEditedFile(projectCwd);

  const mem = emptyMemory();
  mem.long_term_summary = "User cares deeply about null handling.";
  mem.learned_rules = [
    {
      id: "lr-001",
      rule: "Always grep for existing null checks first.",
      category: "null_check",
      created_at: "2026-05-14T00:00:00Z",
      applied_count: 0,
      effectiveness: "good",
    },
  ];
  await writeMemory(home, mem, projectCwd);
  const projectSiltpoke = join(projectCwd, ".siltpoke");
  fs.mkdirSync(projectSiltpoke, { recursive: true });

  fs.writeFileSync(
    join(projectSiltpoke, "recent_feedback.jsonl"),
    `${JSON.stringify({
      ts: "2026-05-14T10:00:00Z",
      critique_id: "c-prev1",
      verdict: "dismissed",
      reason: "already had null check",
    })}\n`,
  );

  let receivedPrompt = "";
  const fakeBrain = {
    mood: "happy" as const,
    pose: "base" as const,
    bubble_short: "ok",
    bubble_long: "",
    critique_for_claude: "",
    severity: "info" as const,
    confidence: "high" as const,
    xp_earned_events: [],
    evidence: [],
      reasoning: "test fixture",
  };

  await runHook({
    rawJson: JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-mem",
      transcript_path: transcriptPath,
      cwd: projectCwd,
    }),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async (opts) => {
      receivedPrompt = opts.systemPrompt;
      return {
        output: fakeBrain,
        usage: {
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 0,
          input_tokens: 50,
          output_tokens: 100,
          total_cost_usd: 0.0005,
        },
      };
    },
  });

  expect(receivedPrompt).toContain("User cares deeply about null handling");
  expect(receivedPrompt).toContain("Always grep for existing null checks first");
  expect(receivedPrompt).toContain("c-prev1");
  expect(receivedPrompt).toContain("dismissed");

  const log = readFileSync(join(home, "brain-calls.jsonl"), "utf8");
  expect(log).toContain('"memory_rules_count":1');
  expect(log).toContain('"recent_entries_count":1');
  expect(log).toContain('"cache_creation_input_tokens":500');
});

test("two different cwds produce two isolated state.json files", async () => {
  const transcriptPath = join(tmpHome, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }, { type: "tool_use", name: "Edit", input: { file_path: "src/dummy.ts" } }] },
    })}\n`,
  );

  const projectA = join(tmpHome, "projA");
  const projectB = join(tmpHome, "projB");
  seedEditedFile(projectA);
  seedEditedFile(projectB);

  const fakeBrainA: BrainOutput = {
    mood: "happy",
    pose: "base",
    bubble_short: "from A",
    bubble_long: "",
    critique_for_claude: "",
    severity: "info",
    confidence: "high",
    xp_earned_events: [],
    evidence: [],
      reasoning: "test fixture",
  };
  const fakeBrainB: BrainOutput = {
    mood: "annoyed",
    pose: "arms_crossed",
    bubble_short: "from B",
    bubble_long: "",
    critique_for_claude: "",
    severity: "medium",
    confidence: "high",
    xp_earned_events: [],
    evidence: [],
      reasoning: "test fixture",
  };

  const usage = {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_cost_usd: 0,
  };

  await runHook({
    rawJson: JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-A",
      transcript_path: transcriptPath,
      cwd: projectA,
    }),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async () => ({ output: fakeBrainA, usage }),
  });

  await runHook({
    rawJson: JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-B",
      transcript_path: transcriptPath,
      cwd: projectB,
    }),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async () => ({ output: fakeBrainB, usage }),
  });

  const stateA = JSON.parse(
    readFileSync(join(projectA, ".siltpoke", "state.json"), "utf8"),
  );
  const stateB = JSON.parse(
    readFileSync(join(projectB, ".siltpoke", "state.json"), "utf8"),
  );
  expect(stateA.bubble_short).toBe("from A");
  expect(stateA.last_session_id).toBe("sess-A");
  expect(stateB.bubble_short).toBe("from B");
  expect(stateB.last_session_id).toBe("sess-B");
});

test("identical event fired twice: second invocation skipped on no_change", async () => {
  seedEditedFile(join(tmpHome, "proj"));
  const transcriptPath = join(tmpHome, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "stable text" }, { type: "tool_use", name: "Edit", input: { file_path: "src/dummy.ts" } }] },
    })}\n`,
  );

  const event = {
    hook_event_name: "Stop",
    session_id: "sess-skip",
    transcript_path: transcriptPath,
    cwd: join(tmpHome, "proj"),
  };

  const fakeBrain: BrainOutput = {
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

  let brainCalls = 0;
  const brainFn = async () => {
    brainCalls += 1;
    return {
      output: fakeBrain,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_cost_usd: 0,
      },
    };
  };

  // This test's premise is the content-hash "no_change" dedupe gate
  // (src/router/skip-detector.ts), not the marker-based idempotency. Both calls
  // fire the SAME event (same transcript), so under the now-default-on marker
  // suppression they would collide on the SAME marker key (session_id +
  // transcript-content hash): the second call would short-circuit BEFORE
  // handleStopHook (and its content-hash gate) ever runs, writing ONE line to
  // brain-calls.jsonl instead of two — breaking the `lines[1]?.skipped`
  // assertion below. Opt out of suppression explicitly so this test keeps
  // testing the content-hash gate it says it tests.
  await runHook({
    rawJson: JSON.stringify(event),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0", SILTPOKE_SUPPRESSION_ENABLED: "0" },
    brainFn,
  });
  // A second commit, so the review-unit gate lets the turn through and the
  // content-hash gate is the thing that stops it. Without this the run is
  // stopped earlier, by `no_new_commit`, and the test would report a green
  // dedupe gate it never reached.
  commitAll(event.cwd, "second commit, same files and same question");
  await runHook({
    rawJson: JSON.stringify(event),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0", SILTPOKE_SUPPRESSION_ENABLED: "0" },
    brainFn,
  });

  expect(brainCalls).toBe(1);

  const log = readFileSync(
    join(tmpHome, ".siltpoke", "brain-calls.jsonl"),
    "utf8",
  );
  const lines = log.trim().split("\n").map((l) => JSON.parse(l));
  expect(lines[0]?.brain_output).toBeDefined();
  expect(lines[1]?.skipped).toBe("no_change");
});

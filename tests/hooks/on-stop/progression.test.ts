import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../../../src/hooks/on-stop";
import type { BrainOutput } from "../../../src/brain/schema";
import { eventWithProj, noopUsage, fakeBrainOutput, seedEditedFile } from "./_shared";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-hook-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test("successful Brain call appends a usage event", async () => {
  const homeBase = join(tmpHome, ".siltpoke");
  const fs = await import("node:fs");
  fs.mkdirSync(homeBase, { recursive: true });

  const ev = eventWithProj(tmpHome, "usage", "sess-usage");
  await runHook({
    rawJson: JSON.stringify(ev),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async () => ({ output: fakeBrainOutput, usage: noopUsage }),
  });
  const events = readFileSync(
    join(homeBase, "usage-events.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n");
  expect(events).toHaveLength(1);
  const parsed = JSON.parse(events[0]!);
  expect(parsed.kind).toBe("main");
  expect(parsed.input_tokens).toBe(100);
});

test("successful Brain call with xp_earned_events bumps progression.xp", async () => {
  const transcriptPath = join(tmpHome, "xp.jsonl");
  writeFileSync(
    transcriptPath,
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "hi" },
    }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "reply" }, { type: "tool_use", name: "Edit", input: { file_path: "src/dummy.ts" } }] },
      }) +
      "\n",
  );
  const projectCwd = join(tmpHome, "xpproj");
  seedEditedFile(projectCwd);
  const brainOutput: BrainOutput = {
    mood: "happy",
    pose: "base",
    bubble_short: "ok",
    bubble_long: "",
    critique_for_claude: "",
    severity: "info",
    confidence: "high",
    xp_earned_events: [
      { type: "daily_activity", amount: 10 },
      { type: "found_bug", amount: 15 },
    ],
    evidence: [],
      reasoning: "test fixture",
  };
  await runHook({
    rawJson: JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-xp",
      transcript_path: transcriptPath,
      cwd: projectCwd,
    }),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async () => ({
      output: brainOutput,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_cost_usd: 0,
      },
    }),
  });

  const prog = JSON.parse(
    readFileSync(join(tmpHome, ".siltpoke", "progression.json"), "utf8"),
  );
  expect(prog.xp).toBe(25);

  const log = readFileSync(
    join(tmpHome, ".siltpoke", "brain-calls.jsonl"),
    "utf8",
  );
  expect(log).toContain('"xp_awarded":25');
});

test("brain output with empty xp_earned_events does not write progression", async () => {
  const transcriptPath = join(tmpHome, "noxp.jsonl");
  writeFileSync(
    transcriptPath,
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "hi" },
    }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "reply" }, { type: "tool_use", name: "Edit", input: { file_path: "src/dummy.ts" } }] },
      }) +
      "\n",
  );
  const projectCwd = join(tmpHome, "noxpproj");
  seedEditedFile(projectCwd);
  const brainOutput: BrainOutput = {
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
  await runHook({
    rawJson: JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-noxp",
      transcript_path: transcriptPath,
      cwd: projectCwd,
    }),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async () => ({
      output: brainOutput,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_cost_usd: 0,
      },
    }),
  });
  // progression.json should NOT exist
  expect(
    existsSync(join(tmpHome, ".siltpoke", "progression.json")),
  ).toBe(false);
});

test("new Edit tool_use invalidates skip → Brain re-runs", async () => {
  const t1 = join(tmpHome, "t1.jsonl");
  const t2 = join(tmpHome, "t2.jsonl");
  // Real file so the Stop hook's pruneMissing keeps this absolute path (a fake
  // absolute path would be dropped → empty changedFiles → hook skips).
  const t2Edit = join(tmpHome, "p", "file.ts");
  mkdirSync(join(tmpHome, "p"), { recursive: true });
  writeFileSync(t2Edit, "export const x = 1;\n");
  seedEditedFile(join(tmpHome, "p")); // t1 edits relative src/dummy.ts under this cwd
  writeFileSync(
    t1,
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "hi" },
    }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "first" }, { type: "tool_use", name: "Edit", input: { file_path: "src/dummy.ts" } }] },
      }) +
      "\n",
  );
  writeFileSync(
    t2,
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "hi" },
    }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Edit",
              input: { file_path: t2Edit },
            },
          ],
        },
      }) +
      "\n",
  );

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

  const base = {
    hook_event_name: "Stop",
    session_id: "sess-evolve",
    cwd: join(tmpHome, "p"),
  };

  await runHook({
    rawJson: JSON.stringify({ ...base, transcript_path: t1 }),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn,
  });
  await runHook({
    rawJson: JSON.stringify({ ...base, transcript_path: t2 }),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn,
  });

  expect(brainCalls).toBe(2);
});

test("transcript adds more assistant text but no file changes → skips", async () => {
  // The signature is changed_files + user_msg, NOT assistant text. Two Stop
  // events back-to-back where Claude only TALKED (no Edit/Write) and the user
  // didn't send anything new should skip the second Brain call.
  seedEditedFile(join(tmpHome, "p2"));
  const t1 = join(tmpHome, "skip1.jsonl");
  const t2 = join(tmpHome, "skip2.jsonl");
  const userLine = JSON.stringify({
    type: "user",
    message: { role: "user", content: "explain the design" },
  });
  writeFileSync(
    t1,
    userLine +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "first reply" }, { type: "tool_use", name: "Edit", input: { file_path: "src/dummy.ts" } }] },
      }) +
      "\n",
  );
  writeFileSync(
    t2,
    userLine +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "first reply" }, { type: "tool_use", name: "Edit", input: { file_path: "src/dummy.ts" } }] },
      }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "follow-up reply" }, { type: "tool_use", name: "Edit", input: { file_path: "src/dummy.ts" } }] },
      }) +
      "\n",
  );

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

  const base = {
    hook_event_name: "Stop",
    session_id: "sess-talkonly",
    cwd: join(tmpHome, "p2"),
  };

  await runHook({
    rawJson: JSON.stringify({ ...base, transcript_path: t1 }),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn,
  });
  await runHook({
    rawJson: JSON.stringify({ ...base, transcript_path: t2 }),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn,
  });

  expect(brainCalls).toBe(1);
});

/**
 * Defect [58] (audit §61 / §77), writer side: a HARD_SUPPRESS that means "the
 * review did not run because something broke" is written with the same
 * `error_message` marker the catch path uses, so the timeline's errors filter
 * can select it. A deliberate abstention is written exactly as before.
 *
 * Each row is also fed through the real `parseCall`, so the assertion is on what
 * the dashboard will see, not just on a field name.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleStopHook } from "../../src/hooks/handle-stop";
import { BrainError, type BrainCallResult } from "../../src/brain/brain";
import type { RunCriticDeps } from "../../src/critic/run-critic";
import { parseCall } from "../../src/state/critic-event-log-parse";
import {
  commitAgentEdit,
  failingBrain,
  makeFakeBrainOutput,
  noopUsage,
  seedAnchoredRepo,
  stopEvent,
  toolsAbstain,
  toolsCleanRefactor,
  toolsWithFinding,
} from "../_shared/anchor-fixture";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-hs-fail-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function rowFor(sessionId: string): Record<string, unknown> {
  const row = readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((r) => r.session_id === sessionId);
  expect(row).toBeDefined();
  return row;
}

async function run(name: string, deps: RunCriticDeps): Promise<Record<string, unknown>> {
  const { projectCwd } = seedAnchoredRepo(tmpHome, `proj-${name}`);
  const { transcriptPath } = commitAgentEdit(tmpHome, projectCwd, `${name}.ts`, `edit for ${name}`);
  const sessionId = `sess-${name}`;
  await handleStopHook(stopEvent(sessionId, projectCwd, transcriptPath), {
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
    m112Deps: deps,
  });
  return rowFor(sessionId);
}

describe("handleHardSuppress row for failures vs deliberate abstentions", () => {
  test("NORMAL Brain failure row carries error_message and parses as brain_error", async () => {
    let attempted = false;
    const row = await run("normal-fail", {
      runToolsFn: async () => toolsWithFinding(),
      callBrainFn: failingBrain(() => { attempted = true; }),
      writeCritiqueFn: async () => ({ id: "c", path: "/tmp" }),
    });
    expect(attempted).toBe(true); // positive control: the Brain was reached
    expect(row.critic_path_decision).toBe("HARD_SUPPRESS");
    expect(String(row.error_message)).toStartWith("Brain call failed in NORMAL");
    expect(row.error_message).toBe(row.m112_reason);
    expect(parseCall(row)!.skip_reason).toBe("brain_error");
  });

  test("PASSIVE_BUBBLE Brain failure row carries error_message", async () => {
    let attempted = false;
    const row = await run("passive-fail", {
      runToolsFn: async () => toolsCleanRefactor(),
      callBrainFn: failingBrain(() => { attempted = true; }),
      writeCritiqueFn: async () => ({ id: "c", path: "/tmp" }),
    });
    expect(attempted).toBe(true);
    expect(String(row.error_message)).toStartWith("Brain call failed in PASSIVE_BUBBLE");
    expect(parseCall(row)!.error_message).toBe(row.error_message as string);
  });

  test("runTools failure row carries error_message", async () => {
    const row = await run("tools-fail", {
      runToolsFn: async () => { throw new Error("runTools blew up"); },
      callBrainFn: async (): Promise<BrainCallResult> => ({ output: makeFakeBrainOutput(), usage: noopUsage }),
      writeCritiqueFn: async () => ({ id: "c", path: "/tmp" }),
    });
    expect(String(row.error_message)).toStartWith("runTools threw unexpectedly");
    expect(parseCall(row)!.skip_reason).toBe("brain_error");
  });

  test("negative: quota_cap / agy_prompt_too_large skip rows carry no error_message and stay out of the errors facet", async () => {
    for (const code of ["quota_cap", "agy_prompt_too_large"] as const) {
      const row = await run(`skip-${code}`, {
        runToolsFn: async () => toolsWithFinding(),
        callBrainFn: async (): Promise<BrainCallResult> => {
          throw new BrainError(`pre-spawn abstain ${code}`, undefined, undefined, code);
        },
        writeCritiqueFn: async () => ({ id: "c", path: "/tmp" }),
      });
      expect(row.skipped).toBe(code);
      expect(row.error_message).toBeUndefined();
      const parsed = parseCall(row)!;
      expect(parsed.skip_reason).toBe(code);
      expect(parsed.error_message).toBeNull();
    }
  });

  test("negative: the abstention floor is written without error_message and stays a fired-shaped row", async () => {
    let brainCalled = false;
    const row = await run("abstain", {
      runToolsFn: async () => toolsAbstain(),
      callBrainFn: async (): Promise<BrainCallResult> => {
        brainCalled = true;
        return { output: makeFakeBrainOutput(), usage: noopUsage };
      },
      writeCritiqueFn: async () => ({ id: "c", path: "/tmp" }),
    });
    expect(brainCalled).toBe(false); // positive control: the floor, not a failure
    expect(row.critic_path_decision).toBe("HARD_SUPPRESS");
    expect(row.error_message).toBeUndefined();
    expect(parseCall(row)!.status).toBe("fired");
  });
});

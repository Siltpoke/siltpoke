// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// A session whose SessionStart cwd differs from its Stop cwd has no baseline,
// and the memory loop is dead for that whole session, silently.
//
// SessionStart writes the baseline under `input.cwd`. The Stop hook reads it
// under `event.cwd`. When those differ, the read comes back empty, every
// `PendingCritique` is enqueued with `created_sha: null`, and `adjudicate`
// short-circuits to `abstain / no_baseline_sha` on every sweep until the TTL
// drops the critique. No rule is ever written.
//
// MEASURED (2026-09-01, siltpoke), session
// `05fffe58-9e6a-413b-b962-54221fd361f1`:
//   - SessionStart's cwd was `~/Projects/ai-agents/siltpoke` — the multi-repo
//     parent, four repos under it, itself NOT a git repo (its own CLAUDE.md
//     says so). Evidence: that is where the per-session record landed, and it
//     carries `head_sha: null` because `git rev-parse HEAD` fails there. Three
//     more null-sha records sit beside it.
//   - The Stop hook's `event.cwd` was `.../siltpoke`. Evidence: critique
//     `c-26d3` records that cwd and its file was written under that repo.
//   - All three adjudications of `c-26d3` abstained `no_baseline_sha`, then
//     `ttl_drop`.
//
// NOT ESTABLISHED — stated so nobody reads a mechanism into it: WHY the two
// cwds differ. An earlier draft of this header said the Stop hook re-anchors to
// the repo the changed files live in; that is FALSE for this host —
// `resolveHostCwd` returns `payloadCwd` untouched unless the host is
// antigravity (`src/hooks/resolve-host-cwd.ts:59`), and the measured session
// was Claude Code. The divergence came from the host payload; which mechanism
// produced it is unknown and is not guessed at here. The fix does not depend on
// the answer.
//
// A DIFFERENT root cause from the two already covered:
// `session-start-recursion-guard.test.ts` (siltpoke's own nested review session
// overwriting the slot, keyed on an env var) and
// `concurrent-session-baseline.test.ts` (two real sessions sharing one slot).
// Neither can see this one: SessionStart behaved correctly for the directory it
// was handed, and that directory was the wrong one. The failure register's
// claim that `no_baseline_sha` "is dead after #450" was written from date
// buckets with no mechanism, and the row above refutes it.
//
// WHY THE FIX CANNOT LIVE IN SessionStart — and this argument needs no
// mechanism for the divergence: SessionStart was handed a directory holding
// four repos, and nothing at that moment says which one the session will touch.
// The first Stop is the earliest point the repo under review is known.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { handleSessionStart } from "../../src/hooks/handle-session-start";
import { resolveSessionHeadSha } from "../../src/hooks/handle-stop";
import { resolveOrCaptureSessionHeadSha, sessionBaselinePath, stateDirFor } from "../../src/hooks/session-baseline";

const SESSION = "05fffe58-9e6a-413b-b962-54221fd361f1";

function commit(dir: string, file: string, body: string): string {
  writeFileSync(join(dir, file), body);
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", file], { cwd: dir });
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
}

/** A non-git parent holding one git child — the shape of `ai-agents/siltpoke/`. */
function workspace(): { parent: string; child: string; sha: string } {
  const parent = mkdtempSync(join(tmpdir(), "sp-parent-launch-"));
  const child = join(parent, "child-repo");
  mkdirSync(child, { recursive: true });
  spawnSync("git", ["init"], { cwd: child });
  const sha = commit(child, "a.txt", "a");
  return { parent, child, sha };
}

function tmpHome(): string {
  const h = mkdtempSync(join(tmpdir(), "sp-parent-launch-home-"));
  mkdirSync(join(h, ".siltpoke"), { recursive: true });
  return h;
}

const envFor = (home: string) => ({ HOME: home }) as NodeJS.ProcessEnv;

describe("a session launched from a multi-repo parent still gets a baseline", () => {
  test("the parent-written record is unusable — this is the defect being fixed", async () => {
    const { parent, child } = workspace();
    await handleSessionStart({ cwd: parent, session_id: SESSION, env: envFor(tmpHome()) });

    // Where it landed, and what it says. Both halves of the defect, asserted so
    // a future change that fixes only one of them cannot read as green.
    const written = sessionBaselinePath(stateDirFor(parent), SESSION);
    expect(written).not.toBeNull();
    expect(existsSync(written as string)).toBe(true);
    expect(JSON.parse(readFileSync(written as string, "utf8")).head_sha).toBeNull();

    // The Stop hook looks here, and finds nothing.
    expect(resolveSessionHeadSha(child, SESSION)).toBeNull();
  });

  test("the Stop-side resolver captures a baseline when none can be read", async () => {
    const { parent, child, sha } = workspace();
    await handleSessionStart({ cwd: parent, session_id: SESSION, env: envFor(tmpHome()) });

    // The whole point: a critique enqueued from this session must NOT carry
    // `created_sha: null`, which short-circuits the oracle to `no_baseline_sha`
    // on every sweep until the TTL drops it.
    expect(resolveOrCaptureSessionHeadSha(child, SESSION)).toBe(sha);
  });

  test("the captured baseline is persisted, so later Stops do not drift with HEAD", async () => {
    const { parent, child, sha } = workspace();
    await handleSessionStart({ cwd: parent, session_id: SESSION, env: envFor(tmpHome()) });

    expect(resolveOrCaptureSessionHeadSha(child, SESSION)).toBe(sha);

    // The session commits, as sessions do. A second Stop must still report the
    // baseline, not the new HEAD — otherwise every critique in one session gets
    // a different "baseline" and the field means nothing.
    const later = commit(child, "b.txt", "b");
    expect(later).not.toBe(sha);
    expect(resolveOrCaptureSessionHeadSha(child, SESSION)).toBe(sha);
  });

  test("a late capture is marked, so it is never mistaken for a real session-start baseline", async () => {
    const { parent, child } = workspace();
    await handleSessionStart({ cwd: parent, session_id: SESSION, env: envFor(tmpHome()) });
    resolveOrCaptureSessionHeadSha(child, SESSION);

    const file = sessionBaselinePath(stateDirFor(child), SESSION);
    expect(file).not.toBeNull();
    const record = JSON.parse(readFileSync(file as string, "utf8"));
    expect(record.late_capture).toBe(true);
    expect(record.session_id).toBe(SESSION);
  });

  test("POSITIVE CONTROL: a real session-start baseline is returned untouched, never re-captured", async () => {
    const { child, sha } = workspace();
    await handleSessionStart({ cwd: child, session_id: SESSION, env: envFor(tmpHome()) });

    // HEAD moves after the session started. The baseline is the PRE-session
    // commit by definition, so a resolver that quietly re-captures here would
    // destroy the only thing the field is for.
    const later = commit(child, "b.txt", "b");
    expect(later).not.toBe(sha);

    expect(resolveOrCaptureSessionHeadSha(child, SESSION)).toBe(sha);
    const record = JSON.parse(readFileSync(sessionBaselinePath(stateDirFor(child), SESSION) as string, "utf8"));
    expect(record.late_capture).toBeUndefined();
  });

  test("a cwd that is not a git repo still degrades to null rather than throwing", async () => {
    const { parent } = workspace();
    await handleSessionStart({ cwd: parent, session_id: SESSION, env: envFor(tmpHome()) });
    expect(resolveOrCaptureSessionHeadSha(parent, SESSION)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The DELIVERY half. Everything above tests `resolveOrCaptureSessionHeadSha`
// directly; nothing above notices whether `handle-stop.ts` actually calls it.
// Reverting both call sites to the pure-read `resolveSessionHeadSha` left all
// six green — the independent reviewer's F-I2. These drive the real Stop hook.
// ---------------------------------------------------------------------------
import { handleStopHook } from "../../src/hooks/handle-stop";
import { maybeRecordWhy } from "../../src/hooks/why-index-wiring";
import { pendingQueuePath, readPending } from "../../src/memory/pending-queue";
import { readSessionBaseline } from "../../src/hooks/session-baseline";
import type { BrainCallResult } from "../../src/brain/brain";
import type { BrainOutput } from "../../src/brain/schema";
import type { RunCriticDeps } from "../../src/critic/run-critic";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";
import type { HookEvent } from "../../src/router/router";

const noopUsage = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  input_tokens: 100,
  output_tokens: 50,
  total_cost_usd: 0.001,
};

function brainOutput(overrides?: Partial<BrainOutput>): BrainOutput {
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

function toolsWithTscError(
  snippet: string,
): Record<ToolName, ToolResult> & { securityFindings: never[]; owaspHints: never[]; webSearchSources: never[] } {
  return {
    tsc: {
      tool: "tsc",
      status: "ok",
      parsed: [{ file: "x.ts", line: 3, col: 1, severity: "error", code: "TS2322", message: "Type mismatch." }],
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

describe("the Stop hook enqueues a usable baseline in the parent-launch shape", () => {
  test("created_sha is the child repo's HEAD, not null — the abstain this whole change exists to stop", async () => {
    // A non-git parent holding one repo, and a HOME of its own so nothing
    // touches the real one.
    const home = tmpHome();
    const parent = mkdtempSync(join(tmpdir(), "sp-stop-parent-"));
    const child = join(parent, "child-repo");
    mkdirSync(child, { recursive: true });
    spawnSync("git", ["init"], { cwd: child });
    const SNIPPET = 'const y: number = "nope";';
    writeFileSync(join(child, "x.ts"), ["const a = 1;", "const b = 2;", SNIPPET, "const c = 3;"].join("\n") + "\n");
    const sha = commit(child, "seed.txt", "seed");

    const transcript = join(parent, "transcript.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hello" },
            { type: "tool_use", name: "Edit", input: { file_path: join(child, "x.ts") } },
          ],
        },
      })}\n`,
    );

    // The session starts in the PARENT — which is what happened for session
    // 05fffe58 — and the Stop hook is handed the CHILD.
    await handleSessionStart({ cwd: parent, session_id: SESSION, env: envFor(home) });

    const event: HookEvent = {
      hook_event_name: "Stop",
      session_id: SESSION,
      transcript_path: transcript,
      cwd: child,
    };
    const deps: RunCriticDeps = {
      runToolsFn: async () => toolsWithTscError(SNIPPET),
      callBrainFn: async (): Promise<BrainCallResult> => ({
        output: brainOutput({
          mood: "annoyed",
          severity: "medium",
          evidence: [{ tool: "tsc", file: "x.ts", line: 3, snippet: SNIPPET }],
        }),
        usage: noopUsage,
      }),
      writeCritiqueFn: async () => ({ id: "c-parent-launch", path: join(child, ".siltpoke", "fake.md") }),
    };

    await handleStopHook(event, {
      env: { HOME: home, SILTPOKE_TOOL_AUGMENTED: "1" } as NodeJS.ProcessEnv,
      brainFn: async (): Promise<BrainCallResult> => ({ output: brainOutput(), usage: noopUsage }),
      m112Deps: deps,
      menubarDeps: { exec: () => {} },
    });

    const pending = await readPending(pendingQueuePath(join(child, ".siltpoke")));
    expect(pending.length).toBe(1);
    // The assertion the whole change is for. Before it, this was `null`, and
    // `adjudicate` short-circuits to `abstain / no_baseline_sha` on that line.
    expect(pending[0]!.created_sha).not.toBeNull();
    expect(pending[0]!.created_sha).toBe(sha);
  });

  test("a late-captured baseline does NOT switch WHY-recording on — behaviour unchanged from before this fix", async () => {
    const { parent, child } = workspace();
    await handleSessionStart({ cwd: parent, session_id: SESSION, env: envFor(tmpHome()) });
    resolveOrCaptureSessionHeadSha(child, SESSION);

    // The record now exists where `maybeRecordWhy` looks, so its `b === null`
    // early-out no longer fires. It must refuse on the marker instead: a late
    // capture is mid-session HEAD, so `baselineSha..headSha` would not be
    // "what this session did".
    const resolved = readSessionBaseline(child, SESSION);
    expect(resolved).not.toBeNull();
    expect(resolved!.late_capture).toBe(true);

    commit(child, "c.txt", "c");
    let recorded = false;
    await maybeRecordWhy({
      cwd: child,
      sessionId: SESSION,
      transcriptPath: join(parent, "nope.jsonl"),
      host: "claude-code",
      stopTime: new Date().toISOString(),
      runGit: async () => {
        recorded = true;
        return { exitCode: 0, stdout: "" };
      },
    });
    expect(recorded).toBe(false);
  });
});

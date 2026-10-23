/**
 * The review-unit anchor contract, split out of handle-stop.test.ts.
 *
 * `<project>/.siltpoke/review-anchor.json` means "already reviewed up to here",
 * and every later review takes `<anchor>..HEAD`. Both ways of getting it wrong
 * are bad: consuming a unit never looked at deletes that commit from every
 * future range (defect `[27]`, measured on a real Windows machine 2026-09-24 —
 * audit §36.4 / §38), while failing to consume one re-reviews it forever.
 *
 * Every test here pins one exit of that contract, and each carries a positive
 * control — without one, a turn stopped by some earlier gate leaves the anchor
 * untouched too and the assertion passes while proving nothing.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleStopHook } from "../../src/hooks/handle-stop";
import type { BrainCallResult } from "../../src/brain/brain";
import type { RunCriticDeps } from "../../src/critic/run-critic";
import { commitAll, headSha } from "../_shared/git-fixture";
import { extractChangedFiles, extractLatestUserMessage } from "../../src/router/context";
import { buildSignature, computeContextHash } from "../../src/router/skip-detector";
import {
  abstainingBrain,
  anchorHead,
  commitAgentEdit,
  makeFakeBrainOutput,
  makeTranscriptNoEdit,
  failingBrain,
  noopUsage,
  seedAnchoredRepo,
  stopEvent,
  toolsAbstain,
  toolsCleanRefactor,
  toolsWithFinding,
} from "../_shared/anchor-fixture";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-anchor-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("handleStopHook — review-unit anchor is consumed only by a reviewed turn", () => {
  // Each test pins one exit of the contract described in this file's header.

  test("a commit the transcript never touched leaves the anchor where it was", async () => {
    const { projectCwd, stateBase, baseHead } = seedAnchoredRepo(tmpHome, "proj-anchor-veto");

    // A real commit git can see perfectly well — `git merge`, `git cherry-pick`,
    // or anything committed outside the agent's own Edit/Write calls.
    writeFileSync(join(projectCwd, "out-of-band.ts"), "export const x = 1;\n");
    commitAll(projectCwd, "committed outside the agent's tool calls");
    expect(headSha(projectCwd)).not.toBe(baseHead);

    // ...and a transcript that shows no file edits at all, so the code-change
    // gate vetoes the review the review-unit gate just approved.
    const transcriptPath = makeTranscriptNoEdit(tmpHome);

    await handleStopHook(
      stopEvent("sess-anchor-veto", projectCwd, transcriptPath),
      { env: { HOME: tmpHome } },
    );

    // The turn was not reviewed, so the unit must still be retryable. If the
    // anchor moved, this commit's diff can never appear in any later
    // `<anchor>..HEAD` range — it is not skipped, it is gone.
    expect(anchorHead(stateBase)).toBe(baseHead);
  });

  // A dedupe skip CONSUMES the unit (already said). Nothing else covers it: every
  // other test here has no skip-state, so the dedupe gate cannot fire in them and
  // its consumption could be dropped with the suite still green.
  test("a dedupe skip still advances the anchor", async () => {
    const { projectCwd, stateBase, baseHead } = seedAnchoredRepo(tmpHome, "proj-anchor-dedupe");
    const { movedHead, transcriptPath } = commitAgentEdit(
      tmpHome, projectCwd, "deduped.ts", "committed by the agent, reviewed once already",
    );

    // Seed the dedupe state with the signature this exact turn will produce, so
    // `evaluateSkip` returns `no_change` and the gate skips. The signature is
    // built from the same inputs the hook uses, via the real helpers rather
    // than a copied string — a hand-written hash here would silently stop
    // matching the moment `buildSignature` changes.
    const sessionId = "sess-anchor-dedupe";
    const changedFiles = await extractChangedFiles(transcriptPath);
    const hash = computeContextHash(
      buildSignature({
        sessionId,
        cwd: projectCwd,
        changedFiles,
        latestUserMessage: await extractLatestUserMessage(transcriptPath),
        // The same unit as this turn: since `[59]` the unit is part of "same".
        revisionRange: `${baseHead}..${movedHead}`,
      }),
    );
    mkdirSync(join(tmpHome, ".siltpoke"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".siltpoke", "skip-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: { [sessionId]: { hash, ts: Date.now() } },
      }),
    );

    await handleStopHook(
      stopEvent(sessionId, projectCwd, transcriptPath),
      {
        env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
        brainFn: async (): Promise<BrainCallResult> => ({
          output: makeFakeBrainOutput(),
          usage: noopUsage,
        }),
      },
    );

    // Positive control on the fixture: if the dedupe gate did NOT actually
    // skip, this test proves nothing — it would just be the "DID touch" test
    // again. The row says which gate stopped the turn.
    const row = readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((r) => r.session_id === sessionId);
    expect(row?.skipped).toBe("no_change");

    expect(anchorHead(stateBase)).toBe(movedHead);
  });

  // Defect `[59]` (audit §62.1; reproduced on Claude Code in Windows Run 4,
  // §110.2): the same sentence editing the same file, committed again. The
  // previous turn's signature matched this one because the commit was not part
  // of it, so a commit nobody had read was skipped as `no_change` and the
  // anchor moved past it.
  test("[59] the same sentence and file on a NEW commit is reviewed, not skipped", async () => {
    const { projectCwd, stateBase, baseHead } = seedAnchoredRepo(tmpHome, "proj-anchor-59");
    const { movedHead, transcriptPath } = commitAgentEdit(
      tmpHome, projectCwd, "same.ts", "change same.ts again and commit it",
    );
    const sessionId = "sess-anchor-59";
    // What the PREVIOUS turn stored: same session, cwd, file and sentence —
    // but it closed an earlier unit, ending at this turn's anchor.
    const previous = computeContextHash(
      buildSignature({
        sessionId,
        cwd: projectCwd,
        changedFiles: await extractChangedFiles(transcriptPath),
        latestUserMessage: await extractLatestUserMessage(transcriptPath),
        revisionRange: `0000000..${baseHead}`,
      }),
    );
    mkdirSync(join(tmpHome, ".siltpoke"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".siltpoke", "skip-state.json"),
      JSON.stringify({ schemaVersion: 1, entries: { [sessionId]: { hash: previous, ts: Date.now() } } }),
    );
    let brainCalls = 0;

    await handleStopHook(
      stopEvent(sessionId, projectCwd, transcriptPath),
      {
        env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
        brainFn: async (): Promise<BrainCallResult> => {
          brainCalls += 1;
          return { output: makeFakeBrainOutput(), usage: noopUsage };
        },
      },
    );

    const rows = readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((r) => r.session_id === sessionId);
    expect(rows.some((r) => r.skipped === "no_change")).toBe(false);
    expect(brainCalls).toBe(1);
    // Reviewed, so the anchor moves — and only because it was reviewed.
    expect(anchorHead(stateBase)).toBe(movedHead);
  });

  // The other half of the same contract. Deferring the write is only correct
  // if something still performs it — without this, "never advance on a fire"
  // passes the test above and quietly re-reviews the same unit forever.
  test("a commit the transcript DID touch advances the anchor", async () => {
    const { projectCwd, stateBase } = seedAnchoredRepo(tmpHome, "proj-anchor-advance");
    const { movedHead, transcriptPath } = commitAgentEdit(
      tmpHome, projectCwd, "touched.ts", "committed by the agent",
    );

    await handleStopHook(
      stopEvent("sess-anchor-advance", projectCwd, transcriptPath),
      {
        // The legacy path with a stubbed Brain. The stub is REQUIRED, not a
        // convenience: the anchor's advance is now downstream of the Brain
        // returning, so a real spawn would make this assertion depend on a live
        // provider (and would just time out here).
        env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
        brainFn: async (): Promise<BrainCallResult> => ({
          output: makeFakeBrainOutput(),
          usage: noopUsage,
        }),
      },
    );

    expect(anchorHead(stateBase)).toBe(movedHead);
  });

  // Defect `[27]`: the anchor used to advance BEFORE the call, so a failure left
  // it claiming a commit had been reviewed that never was. Windows hit this on
  // every commit ([26] is deterministic, [28]'s breaker reopened every 5 min),
  // but the defect itself is platform-neutral.
  test("a Brain failure leaves the anchor where it was — legacy path", async () => {
    const { projectCwd, stateBase, baseHead } = seedAnchoredRepo(tmpHome, "proj-anchor-brain-fail");
    const { movedHead, transcriptPath } = commitAgentEdit(
      tmpHome, projectCwd, "eaten.ts", "committed by the agent, review will fail",
    );
    expect(movedHead).not.toBe(baseHead);

    let brainAttempted = false;
    await handleStopHook(
      stopEvent("sess-anchor-brain-fail", projectCwd, transcriptPath),
      {
        env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
        brainFn: failingBrain(() => {
          brainAttempted = true;
        }),
      },
    );

    // Positive control on the fixture: without this, a turn stopped by some
    // earlier gate would leave the anchor untouched too and the assertion below
    // would pass while proving nothing about Brain failures.
    expect(brainAttempted).toBe(true);
    expect(anchorHead(stateBase)).toBe(baseHead);
  });

  // The path that actually ships (`SILTPOKE_TOOL_AUGMENTED` defaults ON), and it
  // does NOT throw: runCritic returns HARD_SUPPRESS. A fix keyed on "did it
  // throw" leaves this broken with the legacy test above still green.
  test("a Brain failure leaves the anchor where it was — tool-augmented path", async () => {
    const { projectCwd, stateBase, baseHead } = seedAnchoredRepo(
      tmpHome, "proj-anchor-brain-fail-m112",
    );
    const { movedHead, transcriptPath } = commitAgentEdit(
      tmpHome, projectCwd, "eaten-m112.ts", "committed by the agent, tool-augmented review fails",
    );
    expect(movedHead).not.toBe(baseHead);

    let brainAttempted = false;
    const deps: RunCriticDeps = {
      runToolsFn: async () => toolsWithFinding(),
      callBrainFn: failingBrain(() => {
        brainAttempted = true;
      }),
      writeCritiqueFn: async () => ({ id: "c-never-written", path: "/tmp" }),
    };

    await handleStopHook(
      stopEvent("sess-anchor-brain-fail-m112", projectCwd, transcriptPath),
      { env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" }, m112Deps: deps },
    );

    expect(brainAttempted).toBe(true);
    expect(anchorHead(stateBase)).toBe(baseHead);
  });

  // Review of `[59]`: the tool path stored the dedupe hash BEFORE knowing whether
  // the review failed. The retry of the same unit then matched it, was skipped
  // as `no_change`, and that skip consumed the unit — the failure `[27]` keeps
  // retryable was eaten one turn later instead of at once.
  test("after a failed review the retry is reviewed, not skipped as no_change", async () => {
    const { projectCwd, stateBase, baseHead } = seedAnchoredRepo(tmpHome, "proj-anchor-retry");
    const { movedHead, transcriptPath } = commitAgentEdit(
      tmpHome, projectCwd, "retried.ts", "committed by the agent, first review fails",
    );
    const event = stopEvent("sess-anchor-retry", projectCwd, transcriptPath);
    const env = { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" };
    const noWrite = async () => ({ id: "c-x", path: "/tmp" });

    await handleStopHook(event, {
      env,
      m112Deps: { runToolsFn: async () => toolsWithFinding(), callBrainFn: failingBrain(() => {}), writeCritiqueFn: noWrite },
    });
    expect(anchorHead(stateBase)).toBe(baseHead); // positive control: the first one did fail

    let retried = false;
    await handleStopHook(event, {
      env,
      m112Deps: {
        runToolsFn: async () => toolsWithFinding(),
        callBrainFn: abstainingBrain(() => {
          retried = true;
        }),
        writeCritiqueFn: noWrite,
      },
    });

    const rows = readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.some((r) => r.skipped === "no_change")).toBe(false);
    expect(retried).toBe(true);
    expect(anchorHead(stateBase)).toBe(movedHead);
  });

  // The sibling path: PASSIVE_BUBBLE is 79% of real triggers and has its own Brain
  // call and its own failure return, in a different file. Fixing only NORMAL would
  // leave four fifths of real turns eating the commit, with this block green.
  test("a Brain failure leaves the anchor where it was — PASSIVE_BUBBLE phase", async () => {
    const { projectCwd, stateBase, baseHead } = seedAnchoredRepo(
      tmpHome, "proj-anchor-passive-fail",
    );
    const { movedHead, transcriptPath } = commitAgentEdit(
      tmpHome, projectCwd, "clean-refactor.ts", "a clean refactor whose review will fail",
    );
    expect(movedHead).not.toBe(baseHead);

    let brainAttempted = false;
    const deps: RunCriticDeps = {
      runToolsFn: async () => toolsCleanRefactor(),
      callBrainFn: failingBrain(() => {
        brainAttempted = true;
      }),
      writeCritiqueFn: async () => ({ id: "c-never-written-pb", path: "/tmp" }),
    };

    await handleStopHook(
      stopEvent("sess-anchor-passive-fail", projectCwd, transcriptPath),
      { env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" }, m112Deps: deps },
    );

    // Positive control, and it carries more weight here than in the NORMAL test:
    // if the fixture had landed on HARD_SUPPRESS instead of PASSIVE_BUBBLE, the
    // Brain would never have been called and the anchor assertion would pass for
    // the wrong reason.
    expect(brainAttempted).toBe(true);
    expect(anchorHead(stateBase)).toBe(baseHead);
  });

  // The third "never looked at" producer, and the one the first version missed:
  // `runTools` throwing. No diff, no prompt, no call — and it arrives as a
  // decision, not an exception, exactly like a Brain failure does.
  test("a runTools failure leaves the anchor where it was", async () => {
    const { projectCwd, stateBase, baseHead } = seedAnchoredRepo(tmpHome, "proj-anchor-tools-fail");
    const { movedHead, transcriptPath } = commitAgentEdit(
      tmpHome, projectCwd, "tools-threw.ts", "committed by the agent, tools will throw",
    );
    expect(movedHead).not.toBe(baseHead);

    let brainCalled = false;
    const deps: RunCriticDeps = {
      runToolsFn: async () => {
        throw new Error("runTools blew up");
      },
      callBrainFn: async (): Promise<BrainCallResult> => {
        brainCalled = true;
        return { output: makeFakeBrainOutput(), usage: noopUsage };
      },
      writeCritiqueFn: async () => ({ id: "c-tools-fail", path: "/tmp" }),
    };

    await handleStopHook(
      stopEvent("sess-anchor-tools-fail", projectCwd, transcriptPath),
      { env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" }, m112Deps: deps },
    );

    // Positive control: the tools phase died before anything could be asked, so
    // the Brain must never have been reached. If it HAD been, this fixture is
    // testing something else.
    expect(brainCalled).toBe(false);
    expect(anchorHead(stateBase)).toBe(baseHead);
  });

  // A pre-spawn abstain is NOT a failed look. Left unconsumed it would widen the
  // range every commit with no breaker to bound it — a trap this very change
  // introduced. the maintainer's call 2026-09-25; audit §38.6.
  test("a pre-spawn abstain (policy skip) still advances the anchor", async () => {
    const { projectCwd, stateBase } = seedAnchoredRepo(tmpHome, "proj-anchor-abstain-prespawn");
    const { movedHead, transcriptPath } = commitAgentEdit(
      tmpHome, projectCwd, "too-big.ts", "committed by the agent, prompt over the cap",
    );

    let brainAttempted = false;
    const deps: RunCriticDeps = {
      runToolsFn: async () => toolsWithFinding(),
      callBrainFn: abstainingBrain(() => {
        brainAttempted = true;
      }),
      writeCritiqueFn: async () => ({ id: "c-prespawn", path: "/tmp" }),
    };

    await handleStopHook(
      stopEvent("sess-anchor-abstain-prespawn", projectCwd, transcriptPath),
      { env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" }, m112Deps: deps },
    );

    // Positive control: the provider was reached and refused. Without this, a
    // turn stopped earlier would also leave the anchor advanced-by-default.
    expect(brainAttempted).toBe(true);
    expect(anchorHead(stateBase)).toBe(movedHead);
  });

  // The complement of the failures above: a HARD_SUPPRESS that is NOT a failure
  // — the abstention floor, "no usable tools" — is a turn that WAS dealt with
  // and had nothing to say. It must still consume the unit, or every such turn
  // is re-examined forever. This is what stops the fix from being "never advance
  // on HARD_SUPPRESS", which would be a different bug.
  test("an abstention (no failure) still advances the anchor", async () => {
    const { projectCwd, stateBase } = seedAnchoredRepo(tmpHome, "proj-anchor-abstain");
    const { movedHead, transcriptPath } = commitAgentEdit(
      tmpHome, projectCwd, "abstained.ts", "committed by the agent, critic abstains",
    );

    let brainCalled = false;
    const deps: RunCriticDeps = {
      runToolsFn: async () => toolsAbstain(),
      callBrainFn: async (): Promise<BrainCallResult> => {
        brainCalled = true;
        return { output: makeFakeBrainOutput(), usage: noopUsage };
      },
      writeCritiqueFn: async () => ({ id: "c-abstain", path: "/tmp" }),
    };

    await handleStopHook(
      stopEvent("sess-anchor-abstain", projectCwd, transcriptPath),
      { env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" }, m112Deps: deps },
    );

    // Positive control: this is the abstention floor, so the Brain is never
    // reached. If it HAD been called, this fixture would be testing the NORMAL
    // path instead and the assertion below would mean something else.
    expect(brainCalled).toBe(false);
    expect(anchorHead(stateBase)).toBe(movedHead);
  });
});


// Install audit §110 W1 (Windows Run 4): a wake review ignored the unit, read
// the working tree / recent commits, and left the anchor behind; the next
// normal review read the same commits again (c-f069 then c-549f — paid twice).
describe("handleStopHook — a wake review consumes the unit when there is one", () => {
  function wake(): void {
    mkdirSync(join(tmpHome, ".siltpoke"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".siltpoke", "wake.json"),
      JSON.stringify({ schemaVersion: 1, expires_at_ms: Date.now() + 60_000 }),
    );
  }
  const okBrain = (onCall: () => void) => async (): Promise<BrainCallResult> => {
    onCall();
    return { output: makeFakeBrainOutput(), usage: noopUsage };
  };

  test("a new commit: the wake review takes <anchor>..HEAD and the anchor moves", async () => {
    const { projectCwd, stateBase, baseHead } = seedAnchoredRepo(tmpHome, "proj-wake-unit");
    const { movedHead, transcriptPath } = commitAgentEdit(tmpHome, projectCwd, "woken.ts", "committed, then woken");
    expect(movedHead).not.toBe(baseHead);
    wake();
    let calls = 0;
    await handleStopHook(stopEvent("sess-wake-unit", projectCwd, transcriptPath), {
      env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
      brainFn: okBrain(() => {
        calls += 1;
      }),
    });
    expect(calls).toBe(1);
    expect(anchorHead(stateBase)).toBe(movedHead);
  });

  test("control: nothing new committed — the wake review still runs, the anchor stays", async () => {
    const { projectCwd, stateBase, baseHead } = seedAnchoredRepo(tmpHome, "proj-wake-none");
    const transcriptPath = makeTranscriptNoEdit(tmpHome);
    wake();
    let calls = 0;
    await handleStopHook(stopEvent("sess-wake-none", projectCwd, transcriptPath), {
      env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
      brainFn: okBrain(() => {
        calls += 1;
      }),
    });
    expect(calls).toBe(1);
    expect(anchorHead(stateBase)).toBe(baseHead);
  });

  test("a new commit AND uncommitted edits: the wake review reads the edits, the anchor stays", async () => {
    // A range diff cannot see the working tree; "look now" with edits on disk
    // means the edits. Reviewer of W1 found the first version dropped them.
    const { projectCwd, stateBase, baseHead } = seedAnchoredRepo(tmpHome, "proj-wake-dirty");
    const { transcriptPath } = commitAgentEdit(tmpHome, projectCwd, "committed.ts", "committed, then more edits");
    writeFileSync(join(projectCwd, "committed.ts"), "export const notYetCommitted = 2;\n");
    wake();
    let calls = 0;
    await handleStopHook(stopEvent("sess-wake-dirty", projectCwd, transcriptPath), {
      env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
      brainFn: okBrain(() => {
        calls += 1;
      }),
    });
    expect(calls).toBe(1);
    expect(anchorHead(stateBase)).toBe(baseHead);
  });

  test("a new commit and a failed wake review: the anchor stays (the [27] rule holds for wake too)", async () => {
    const { projectCwd, stateBase, baseHead } = seedAnchoredRepo(tmpHome, "proj-wake-fail");
    const { transcriptPath } = commitAgentEdit(tmpHome, projectCwd, "woken-fail.ts", "committed, woken, review fails");
    wake();
    await handleStopHook(stopEvent("sess-wake-fail", projectCwd, transcriptPath), {
      env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
      brainFn: failingBrain(() => {}),
    });
    expect(anchorHead(stateBase)).toBe(baseHead);
  });
});

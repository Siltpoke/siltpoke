// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// PASSIVE_BUBBLE switch-case phase: Brain called with a minimal "clean
// refactor/change" prompt; evidence array is []. Persists the critique and
// emits the relevant trace spans.

import { type BrainCallResult, BrainError, type BrainUsage, type CallBrainOptions, DEFAULT_MODEL } from "../../brain/brain";
import { assembleSystemPromptWithFunnel, type MemoryFunnel, type PromptSectionBytes } from "../../brain/prompt-assembly";
import { buildPassiveBubblePrompt } from "../../brain/prompt-tools";
import type { BrainProviderMeta } from "../../brain/provider";
import type { BrainOutput } from "../../brain/schema";
import type { Tracer } from "../../observability/tracer";
import type { Span } from "../../observability/types";
import type { CritiqueInput } from "../../state/critique";
import type { DiffSummary } from "../tools/run-diff-summary";
import type { runTools } from "../tools/run-tools";
import type { BrainContext, CriticSource, TimingTrace, V2ResultFields } from "../types";
import { writeV2Archive } from "./archive";
import { autoPromoteSeverity } from "./severity-promotion";
import { setBrainUsageAttrs } from "./usage-attrs";

export interface PassiveBubblePhaseArgs {
  toolResults: Awaited<ReturnType<typeof runTools>>;
  brainContext: BrainContext;
  source: CriticSource;
  changedFiles: string[];
  v2: V2ResultFields;
  /**
   * Settle the diff-summary promise. Idempotent — the caller invokes it again
   * after this phase returns, and the second call is a no-op.
   *
   * This replaces a plain `diffSummary: DiffSummary | undefined` argument, which
   * WAS defect ②: the caller passed the VALUE before its only assignment site had
   * run, so the phase always received `undefined`, `autoPromoteSeverity`'s
   * `hasRisks` was structurally always false, and that branch produced 0 of 2,643
   * outputs while 1,500 of 1,843 runs that HAD summary risks still shipped
   * `severity: "info"` with an empty critique.
   *
   * Taking the settler rather than the value lets the phase decide WHEN to wait —
   * after the Brain call, so nothing is serialised in front of the long pole.
   *
   * Deliberately not the raw promise: `finalizeSummary` owns the rejection ->
   * `diffSummaryError` conversion and the heuristic fallback, and a phase awaiting
   * the raw promise would throw straight past both.
   */
  finalizeSummary: () => Promise<void>;
  /** Read the settled summary. Only meaningful once `finalizeSummary()` resolves. */
  getDiffSummary: () => DiffSummary | undefined;
  /** Reviewer kill timer from config; undefined = fall through to env/default. */
  brainTimeoutMs: number | undefined;
  callBrainFn: (opts: CallBrainOptions) => Promise<BrainCallResult>;
  writeCritiqueFn: (basePath: string, input: CritiqueInput) => Promise<{ id: string; path: string }>;
  tracing: boolean;
  tracer: Tracer | null;
  rootSpan: Span | null;
  writeSpan: (span: Span) => Promise<void>;
  redactCwdPaths: <T>(v: T) => T;
  timing: TimingTrace;
  /** Resolved reviewer-provider meta (track #7 T3) — span truth + ledger passthrough. */
  providerMeta: BrainProviderMeta;
  /** Resolved review model (reviewer_model plumbing, single-brain #10 critic
   * half) — sent as `opts.model` on the review Brain call so the active
   * reviewer_provider runs the configured model. undefined -> provider default. */
  reviewModel?: string;
}

/**
 * Both branches are reached AFTER prompt assembly, so both carry the read-half
 * memory funnel (eval design §2.1) rather than leaving it optional.
 */
export type PassiveBubblePhaseResult =
  | { kind: "ok"; critique: BrainOutput; usage: BrainUsage; critiqueId: string | undefined; servedModel?: string; memoryFunnel: MemoryFunnel; promptBytes: PromptSectionBytes }
  | { kind: "hard_suppress"; reason: string; skipCode?: "quota_cap" | "agy_prompt_too_large"; memoryFunnel: MemoryFunnel; promptBytes: PromptSectionBytes };

/**
 * Run the PASSIVE_BUBBLE branch:
 *   buildPassiveBubblePrompt + assembleSystemPrompt + callBrain (with span)
 *   + autoPromoteSeverity + writeCritique (with span) + writeV2Archive.
 *
 * Caller is responsible for closing the root span and finalizing the
 * diff-summary promise after this returns.
 */
export async function runPassiveBubblePhase(
  args: PassiveBubblePhaseArgs,
): Promise<PassiveBubblePhaseResult> {
  const {
    toolResults, brainContext, source, changedFiles, v2,
    finalizeSummary, getDiffSummary,
    callBrainFn, writeCritiqueFn,
    tracing, tracer, rootSpan, writeSpan, redactCwdPaths, timing,
    providerMeta, reviewModel, brainTimeoutMs,
  } = args;

  // Brain called with a minimal "clean refactor/change" prompt; evidence array is [].
  // Use discriminated union narrowing instead of a cast.
  // Pass intent so the verb ("refactor" vs "change") is contextually accurate.
  const gitDiffResult = toolResults["git-diff"];
  const passivePrompt =
    gitDiffResult.tool === "git-diff" && gitDiffResult.status === "ok"
      ? buildPassiveBubblePrompt({
          files: new Set(gitDiffResult.parsed.map((h) => h.file)).size,
          hunks: gitDiffResult.parsed.length,
          intent: brainContext.intent,
        })
      : "The user completed a clean change with no tool findings.";

  const { prompt: systemPrompt, funnel: memoryFunnel, sizes: promptBytes } = assembleSystemPromptWithFunnel({
    personalitySystemPrompt: brainContext.personalitySystemPrompt,
    memory: brainContext.memory,
    recent: brainContext.recent,
    fileTypes: brainContext.fileTypes,
    maxRules: brainContext.maxRules,
    recentInjectionCount: brainContext.recentInjectionCount,
    toolOutputSection: passivePrompt,
    antiExamplesBlock: brainContext.antiExamplesBlock,
  });

  let brainResult: BrainCallResult;

  // Brain find span.
  const brainFindSpanPB = tracing
    ? tracer!.startSpan({ name: "siltpoke.brain.find", kind: "CLIENT", parent: rootSpan!, attributes: { "gen_ai.system": providerMeta.genAiSystem, "gen_ai.operation.name": "chat" } })
    : null;
  if (brainFindSpanPB && tracer) {
    tracer.setKind(brainFindSpanPB, "llm");
    // Capture the FULL assembled system prompt — jsonClip in setInput
    // handles the size cap (default 8KB). Previously we hardcoded
    // .slice(0, 500), so the trace UI showed only the first sentence.
    tracer.setInput(brainFindSpanPB, {
      messages: [
        { role: "system", content: "[redacted — siltpoke critic system prompt]" },
        { role: "user", content: "Produce one Siltpoke JSON per the system prompt." },
      ],
      system_prompt_bytes: systemPrompt.length,
    });
  }

  try {
    // passivePrompt is already baked into systemPrompt via toolOutputSection.
    // Pass "" for contextBundle to avoid double-injecting the same content.
    const criticStart = Date.now();
    brainResult = await callBrainFn({
      systemPrompt,
      contextBundle: "Produce one Siltpoke JSON per the system prompt.",
      // Reviewed-repo cwd (track #7 T3 deferred item) — see normal.ts.
      cwd: brainContext.cwd,
      // Resolved review model (reviewer_model plumbing, single-brain #10 critic
      // half) — see normal.ts's mirror-image comment. undefined -> provider default.
      model: reviewModel,
      // Kill timer from `<home>/config.json`'s `brain.timeout_ms`. `undefined`
      // is meaningful: resolveBrainTimeoutMs only consults
      // SILTPOKE_BRAIN_TIMEOUT_MS when no explicit value arrives, so forcing a
      // number here would disable the env knob.
      timeoutMs: brainTimeoutMs,
    });
    timing.critic_ms = Date.now() - criticStart;
    if (brainFindSpanPB && tracer) {
      tracer.setOutput(brainFindSpanPB, redactCwdPaths(brainResult.output));
      setBrainUsageAttrs(
        tracer,
        brainFindSpanPB,
        brainResult.usage,
        brainResult.servedModel ?? DEFAULT_MODEL,
        providerMeta.genAiSystem,
      );
      tracer.endSpan(brainFindSpanPB, { status: "OK" });
      await writeSpan(brainFindSpanPB);
    }
  } catch (err) {
    if (brainFindSpanPB && tracer) {
      // Record the REJECTED reply, not just the error string — see the
      // full rationale on normal.ts's mirror of this block. Kept as its own
      // copy rather than a shared helper because these two phases mirror each
      // other line-for-line by convention in this file; what MUST stay in sync
      // is pinned by a test that drives this branch specifically.
      if (err instanceof BrainError && err.rawResponse !== undefined) {
        // Wrapped when it is a bare string: an over-cap payload spills to
        // `<trace>-<span>-output.json` and is served `application/json`, and
        // the not-valid-JSON replies are exactly the ones large enough to
        // spill. An unwrapped prose blob would put non-JSON in a .json sidecar.
        const reply = err.rawResponse;
        tracer.setOutput(
          brainFindSpanPB,
          redactCwdPaths(typeof reply === "string" ? { raw_text: reply } : reply),
        );
      }
      tracer.endSpan(brainFindSpanPB, { status: "ERROR", message: String(err) });
      await writeSpan(brainFindSpanPB);
    }
    const reason = `Brain call failed in PASSIVE_BUBBLE: ${err}`;
    console.error(`[siltpoke] runCritic [${source}] HARD_SUPPRESS — ${reason}`);
    // Quota-cap / agy-prompt-too-large skip (track #7 T4 fixup) — see
    // normal.ts's mirror-image comment for the full rationale.
    const skipCode =
      err instanceof BrainError && err.code === "quota_cap"
        ? ("quota_cap" as const)
        : err instanceof BrainError && err.code === "agy_prompt_too_large"
          ? ("agy_prompt_too_large" as const)
          : undefined;
    return { kind: "hard_suppress", reason, skipCode, memoryFunnel, promptBytes };
  }

  const critique = brainResult.output;
  const usage = brainResult.usage;
  const servedModel = brainResult.servedModel;

  // Post-process: hard severity promotion when Brain emits info-only but
  // rubric triggers or diff-summary risks exist. Soft prompt suggestions
  // get ignored; this enforces at the routing layer instead.
  //
  // Settle the summary HERE — after the Brain call, immediately before the only
  // consumer of it on this path. Doing it earlier would serialise a median-13.7s
  // summary in front of a Brain call that runs on 78.8% of reviews; doing it
  // later (as the caller used to) is defect ② itself.
  await finalizeSummary();
  autoPromoteSeverity(critique, v2, getDiffSummary());

  // response.parse span — records parsed Brain JSON.
  if (tracing && tracer && rootSpan) {
    const parseSpanPB = tracer.startSpan({ name: "siltpoke.response.parse", kind: "INTERNAL", parent: rootSpan });
    tracer.setKind(parseSpanPB, "parser");
    tracer.setInput(parseSpanPB, { raw_text: "(parsed inside callBrain)" });
    tracer.setOutput(parseSpanPB, redactCwdPaths(critique));
    tracer.endSpan(parseSpanPB, { status: "OK" });
    await writeSpan(parseSpanPB);
  }

  // critique.persist span.
  const persistSpanPB = tracing
    ? tracer!.startSpan({ name: "siltpoke.critique.persist", kind: "INTERNAL", parent: rootSpan! })
    : null;
  if (persistSpanPB && tracer) {
    tracer.setKind(persistSpanPB, "persist");
    tracer.setInput(persistSpanPB, { critique_id: null, day: new Date().toISOString().slice(0, 10) });
  }

  let critiqueId: string | undefined;
  try {
    const writeResult = await writeCritiqueFn(brainContext.stateBase, {
      brain_output: critique,
      session_id: brainContext.sessionId,
      cwd: brainContext.cwd,
    });
    critiqueId = writeResult.id;

    // Write v2 archive with evidence block.
    if (v2.pipelineRan) {
      void writeV2Archive(brainContext.stateBase, critiqueId, brainContext, v2, changedFiles).catch(() => undefined);
    }

    if (persistSpanPB && tracer) {
      tracer.setAttribute(persistSpanPB, "siltpoke.critique_id", critiqueId);
      tracer.setOutput(persistSpanPB, redactCwdPaths({ path: brainContext.stateBase }));
      tracer.endSpan(persistSpanPB, { status: "OK" });
      await writeSpan(persistSpanPB);
    }
  } catch (err) {
    // writeCritique failure is non-fatal — log and continue.
    if (persistSpanPB && tracer) {
      tracer.endSpan(persistSpanPB, { status: "ERROR", message: String(err) });
      await writeSpan(persistSpanPB);
    }
    console.error(`[siltpoke] runCritic [${source}] writeCritique failed (PASSIVE_BUBBLE): ${err}`);
  }

  // Stamp critique_id on root span if known.
  if (rootSpan && critiqueId) {
    tracer!.setAttribute(rootSpan, "siltpoke.critique_id", critiqueId);
  }

  console.error(
    `[siltpoke] runCritic [${source}] PASSIVE_BUBBLE — critique written`,
  );

  return { kind: "ok", critique, usage, critiqueId, servedModel, memoryFunnel, promptBytes };
}

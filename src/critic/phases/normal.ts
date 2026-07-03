// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
// NORMAL switch-case phase: full Brain critic call with tool-output section,
// rubric evidence, diff-summary, post-Brain evidence guard, and persist.

import type { BrainCallResult, BrainUsage, CallBrainOptions } from "../../brain/brain";
import { assembleSystemPrompt } from "../../brain/prompt-assembly";
import { buildToolOutputSection } from "../../brain/prompt-tools";
import type { BrainOutput } from "../../brain/schema";
import type { Tracer } from "../../observability/tracer";
import type { Span } from "../../observability/types";
import { recordGuardReject } from "../../state/critic-counters";
import type { CritiqueInput } from "../../state/critique";
import { buildCallerImpactSection, type CallerImpactDeps } from "../caller-impact/inject";
import { guardCritique } from "../evidence-guard";
import type { DiffSummary } from "../tools/run-diff-summary";
import { heuristicDiffSummary } from "../tools/run-diff-summary";
import type { runTools } from "../tools/run-tools";
import type { BrainContext, CriticSource, TimingTrace, V2ResultFields } from "../types";
import { buildDiffSummarySection, buildRubricEvidenceSection, writeV2Archive } from "./archive";
import { autoPromoteSeverity } from "./severity-promotion";

export interface NormalPhaseArgs {
  toolResults: Awaited<ReturnType<typeof runTools>>;
  brainContext: BrainContext;
  source: CriticSource;
  changedFiles: string[];
  homeBase: string | undefined;
  v2: V2ResultFields;
  diffSummaryPromise: Promise<DiffSummary | undefined>;
  diffBody: string;
  callBrainFn: (opts: CallBrainOptions) => Promise<BrainCallResult>;
  writeCritiqueFn: (basePath: string, input: CritiqueInput) => Promise<{ id: string; path: string }>;
  tracing: boolean;
  tracer: Tracer | null;
  rootSpan: Span | null;
  writeSpan: (span: Span) => Promise<void>;
  redactCwdPaths: <T>(v: T) => T;
  timing: TimingTrace;
  /** Injected caller-impact seams (resolver + image reader). Defaults applied inside. */
  callerImpact?: CallerImpactDeps;
}

export interface NormalPhaseResult {
  /** Locally-resolved diff summary so the orchestrator can echo it in the result envelope. */
  diffSummary: DiffSummary | undefined;
  /** Locally-captured diff-summary error so the orchestrator can echo it. */
  diffSummaryError: string | undefined;
  outcome:
    | { kind: "hard_suppress"; reason: string }
    | { kind: "guard_rejected"; reason: string; critique: BrainOutput; usage: BrainUsage }
    | { kind: "ok"; critique: BrainOutput; usage: BrainUsage; critiqueId: string | undefined };
}

export async function runNormalPhase(args: NormalPhaseArgs): Promise<NormalPhaseResult> {
  const {
    toolResults, brainContext, source, changedFiles, homeBase, v2,
    diffSummaryPromise, diffBody,
    callBrainFn, writeCritiqueFn,
    tracing, tracer, rootSpan, writeSpan, redactCwdPaths, timing,
    callerImpact,
  } = args;

  const { section, evidenceCorpus } = buildToolOutputSection(toolResults);

  // Inject rubric evidence section into the system prompt if triggers exist.
  const rubricSection = v2.pipelineRan && v2.rubricTriggers && v2.rubricTriggers.length > 0
    ? buildRubricEvidenceSection(v2.rubricTriggers)
    : "";

  // Await diff_summary (Haiku pre-pass) BEFORE Brain so that
  // risks/intent/key_changes flow into the critique prompt. Previously the
  // summary ran in parallel and only fed the dashboard — Brain never saw
  // the risks Haiku had already surfaced, which produced empty
  // critique_for_claude even when concrete concerns existed.
  // Cost: typically Haiku finishes before Brain prep would block (summary
  // started ~200ms ago). Worst case adds ~3-5s on first fire of session.
  let diffSummary: DiffSummary | undefined;
  let diffSummaryError: string | undefined;
  try {
    diffSummary = await diffSummaryPromise;
  } catch (err) {
    diffSummaryError = err instanceof Error ? err.message : String(err);
  }
  if (diffSummary === undefined && diffBody.trim().length > 0) {
    diffSummary = heuristicDiffSummary(diffBody);
  }
  const summarySection = diffSummary !== undefined
    ? buildDiffSummarySection(diffSummary)
    : "";

  const toolOutputCombined = [section, rubricSection, summarySection]
    .filter((s) => s.length > 0)
    .join("\n\n");

  // 1-hop caller-impact block. Fail-soft inside → empty on any
  // error. Its tokens extend the guard corpus so a Brain citation of a
  // `caller: <file>:<line>` token passes the verbatim-substring evidence guard.
  const callerImpactResult = await buildCallerImpactSection(
    { diffBody, changedFiles, cwd: brainContext.cwd },
    callerImpact,
  );
  // Guard corpus = everything the Brain could legitimately cite verbatim.
  // The Brain SEES the formatted tool `section` (buildToolOutputSection), but
  // raw stdout reformats/truncates differently, so a snippet copied from the
  // section (e.g. a full tsc message) may be absent from the raw corpus. We
  // include both the formatted section AND raw stdout so a legitimate citation
  // passes the verbatim guard. Both are deterministic, tool-derived text — the
  // anti-hallucination property holds (the Haiku-generated diff summary is
  // deliberately NOT included; the Brain must not cite its own pre-pass prose).
  const guardCorpusParts = [section, evidenceCorpus];
  if (callerImpactResult.tokens.length > 0) {
    guardCorpusParts.push(callerImpactResult.tokens.join("\n"));
  }
  const guardCorpus = guardCorpusParts.join("\n");

  const systemPrompt = assembleSystemPrompt({
    personalitySystemPrompt: brainContext.personalitySystemPrompt,
    memory: brainContext.memory,
    recent: brainContext.recent,
    fileTypes: brainContext.fileTypes,
    maxRules: brainContext.maxRules,
    recentInjectionCount: brainContext.recentInjectionCount,
    toolOutputSection: toolOutputCombined,
    callerImpactSection: callerImpactResult.section,
  });

  let brainResult: BrainCallResult;

  // Brain find span.
  const brainFindSpan = tracing
    ? tracer!.startSpan({ name: "siltpoke.brain.find", kind: "CLIENT", parent: rootSpan!, attributes: { "gen_ai.system": "anthropic", "gen_ai.operation.name": "chat" } })
    : null;
  if (brainFindSpan && tracer) {
    tracer.setKind(brainFindSpan, "llm");
    // System prompt redacted — see PASSIVE_BUBBLE branch for rationale.
    tracer.setInput(brainFindSpan, {
      messages: [
        { role: "system", content: "[redacted — siltpoke critic system prompt]" },
        { role: "user", content: "Produce one Siltpoke JSON per the system prompt." },
      ],
      system_prompt_bytes: systemPrompt.length,
    });
  }

  try {
    const criticStart = Date.now();
    brainResult = await callBrainFn({ systemPrompt, contextBundle: "Produce one Siltpoke JSON per the system prompt." });
    timing.critic_ms = Date.now() - criticStart;
    if (brainFindSpan && tracer) {
      tracer.setOutput(brainFindSpan, redactCwdPaths(brainResult.output));
      tracer.endSpan(brainFindSpan, { status: "OK" });
      await writeSpan(brainFindSpan);
    }
  } catch (err) {
    if (brainFindSpan && tracer) {
      tracer.endSpan(brainFindSpan, { status: "ERROR", message: String(err) });
      await writeSpan(brainFindSpan);
    }
    const reason = `Brain call failed in NORMAL: ${err}`;
    console.error(`[siltpoke] runCritic [${source}] HARD_SUPPRESS — ${reason}`);
    return { diffSummary, diffSummaryError, outcome: { kind: "hard_suppress", reason } };
  }

  const critique = brainResult.output;
  const usage = brainResult.usage;

  // Post-process: hard severity promotion when Brain emits info-only but
  // rubric triggers or diff-summary risks exist. Soft prompt suggestions
  // get ignored; this enforces at the routing layer instead.
  autoPromoteSeverity(critique, v2, diffSummary);

  // response.parse span — records parsed Brain JSON.
  if (tracing && tracer && rootSpan) {
    const parseSpan = tracer.startSpan({ name: "siltpoke.response.parse", kind: "INTERNAL", parent: rootSpan });
    tracer.setKind(parseSpan, "parser");
    tracer.setInput(parseSpan, { raw_text: "(parsed inside callBrain)" });
    tracer.setOutput(parseSpan, redactCwdPaths(critique));
    tracer.endSpan(parseSpan, { status: "OK" });
    await writeSpan(parseSpan);
  }

  // Step 4: Post-Brain evidence guard.
  const changedFilesSet = new Set(changedFiles);
  const guard = guardCritique(critique, "NORMAL", guardCorpus, changedFilesSet);

  if (!guard.accept) {
    console.error(
      `[siltpoke] runCritic [${source}] NORMAL guard_rejected — ${guard.reason}`,
    );
    // Record guard rejection telemetry (fire-and-forget).
    if (homeBase !== undefined) {
      void recordGuardReject(homeBase, guard.reason);
    }
    return {
      diffSummary,
      diffSummaryError,
      outcome: { kind: "guard_rejected", reason: guard.reason, critique, usage },
    };
  }

  // Guard accepted — write critique.
  // critique.persist span.
  const persistSpan = tracing
    ? tracer!.startSpan({ name: "siltpoke.critique.persist", kind: "INTERNAL", parent: rootSpan! })
    : null;
  if (persistSpan && tracer) {
    tracer.setKind(persistSpan, "persist");
    tracer.setInput(persistSpan, { critique_id: null, day: new Date().toISOString().slice(0, 10) });
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

    if (persistSpan && tracer) {
      tracer.setAttribute(persistSpan, "siltpoke.critique_id", critiqueId);
      tracer.setOutput(persistSpan, redactCwdPaths({ path: brainContext.stateBase }));
      tracer.endSpan(persistSpan, { status: "OK" });
      await writeSpan(persistSpan);
    }
  } catch (err) {
    if (persistSpan && tracer) {
      tracer.endSpan(persistSpan, { status: "ERROR", message: String(err) });
      await writeSpan(persistSpan);
    }
    console.error(`[siltpoke] runCritic [${source}] writeCritique failed (NORMAL): ${err}`);
  }

  // Stamp critique_id on root span if known.
  if (rootSpan && critiqueId) {
    tracer!.setAttribute(rootSpan, "siltpoke.critique_id", critiqueId);
  }

  console.error(
    `[siltpoke] runCritic [${source}] NORMAL accepted — critique written`,
  );

  return {
    diffSummary,
    diffSummaryError,
    outcome: { kind: "ok", critique, usage, critiqueId },
  };
}

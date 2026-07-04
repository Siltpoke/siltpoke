// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// PASSIVE_BUBBLE switch-case phase: Brain called with a minimal "clean
// refactor/change" prompt; evidence array is []. Persists the critique and
// emits the relevant trace spans.

import type { BrainOutput } from "../../brain/schema";
import { DEFAULT_MODEL, type CallBrainOptions, type BrainCallResult, type BrainUsage } from "../../brain/brain";
import type { CritiqueInput } from "../../state/critique";
import type { DiffSummary } from "../tools/run-diff-summary";
import type { Tracer } from "../../observability/tracer";
import type { Span } from "../../observability/types";
import { setBrainUsageAttrs } from "./usage-attrs";
import { buildPassiveBubblePrompt } from "../../brain/prompt-tools";
import { assembleSystemPrompt } from "../../brain/prompt-assembly";
import type { runTools } from "../tools/run-tools";
import type { BrainContext, CriticSource, TimingTrace, V2ResultFields } from "../types";
import { writeV2Archive } from "./archive";
import { autoPromoteSeverity } from "./severity-promotion";

export interface PassiveBubblePhaseArgs {
  toolResults: Awaited<ReturnType<typeof runTools>>;
  brainContext: BrainContext;
  source: CriticSource;
  changedFiles: string[];
  v2: V2ResultFields;
  diffSummary: DiffSummary | undefined;
  callBrainFn: (opts: CallBrainOptions) => Promise<BrainCallResult>;
  writeCritiqueFn: (basePath: string, input: CritiqueInput) => Promise<{ id: string; path: string }>;
  tracing: boolean;
  tracer: Tracer | null;
  rootSpan: Span | null;
  writeSpan: (span: Span) => Promise<void>;
  redactCwdPaths: <T>(v: T) => T;
  timing: TimingTrace;
}

export type PassiveBubblePhaseResult =
  | { kind: "ok"; critique: BrainOutput; usage: BrainUsage; critiqueId: string | undefined }
  | { kind: "hard_suppress"; reason: string };

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
    toolResults, brainContext, source, changedFiles, v2, diffSummary,
    callBrainFn, writeCritiqueFn,
    tracing, tracer, rootSpan, writeSpan, redactCwdPaths, timing,
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

  const systemPrompt = assembleSystemPrompt({
    personalitySystemPrompt: brainContext.personalitySystemPrompt,
    memory: brainContext.memory,
    recent: brainContext.recent,
    fileTypes: brainContext.fileTypes,
    maxRules: brainContext.maxRules,
    recentInjectionCount: brainContext.recentInjectionCount,
    toolOutputSection: passivePrompt,
  });

  let brainResult: BrainCallResult;

  // Brain find span.
  const brainFindSpanPB = tracing
    ? tracer!.startSpan({ name: "siltpoke.brain.find", kind: "CLIENT", parent: rootSpan!, attributes: { "gen_ai.system": "anthropic", "gen_ai.operation.name": "chat" } })
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
    brainResult = await callBrainFn({ systemPrompt, contextBundle: "Produce one Siltpoke JSON per the system prompt." });
    timing.critic_ms = Date.now() - criticStart;
    if (brainFindSpanPB && tracer) {
      tracer.setOutput(brainFindSpanPB, redactCwdPaths(brainResult.output));
      setBrainUsageAttrs(tracer, brainFindSpanPB, brainResult.usage, DEFAULT_MODEL);
      tracer.endSpan(brainFindSpanPB, { status: "OK" });
      await writeSpan(brainFindSpanPB);
    }
  } catch (err) {
    if (brainFindSpanPB && tracer) {
      tracer.endSpan(brainFindSpanPB, { status: "ERROR", message: String(err) });
      await writeSpan(brainFindSpanPB);
    }
    const reason = `Brain call failed in PASSIVE_BUBBLE: ${err}`;
    console.error(`[siltpoke] runCritic [${source}] HARD_SUPPRESS — ${reason}`);
    return { kind: "hard_suppress", reason };
  }

  const critique = brainResult.output;
  const usage = brainResult.usage;

  // Post-process: hard severity promotion when Brain emits info-only but
  // rubric triggers or diff-summary risks exist. Soft prompt suggestions
  // get ignored; this enforces at the routing layer instead.
  autoPromoteSeverity(critique, v2, diffSummary);

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

  return { kind: "ok", critique, usage, critiqueId };
}

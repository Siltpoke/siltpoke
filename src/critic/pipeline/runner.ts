// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { runRubric } from "../rubric/engine";
import { ALL_RUBRIC_RULES } from "../rubric/rules";
import { prioritize } from "./prioritize";
import { runVerifier } from "./verify";
import type { VerifierMode } from "./verify";
import type { BrainOutputV2 } from "../../brain/schema-v2";
import type { RubricTrigger } from "../rubric/types";
import type { Tracer } from "../../observability/tracer";
import type { TraceStore } from "../../observability/storage";

export interface PipelineRunnerInput {
  cwd: string;
  changedFiles: string[];
  diffHunks: Array<{ file: string; addedLines: number[] }>;
  /** Brain callbacks injected for testability */
  callBrainFind: (rubricTriggers: ReadonlyArray<RubricTrigger>) => Promise<BrainOutputV2>;
  callBrainVerifier: (
    firstPass: BrainOutputV2,
    triggers: ReadonlyArray<RubricTrigger>,
  ) => Promise<{ ungrounded_ids: string[] }>;
  verifierMode: VerifierMode;
  /** Optional critique ID — attached to root span as siltpoke.critique_id attr. */
  critiqueId?: string;
  /** Optional tracer + store. When absent, no spans are emitted (silent). */
  tracer?: Tracer;
  traceStore?: TraceStore;
  /**
   * Track #7 T3 (AC14) — span truth when this runner is eventually wired
   * behind a non-claude reviewer provider. Defaults to "anthropic" so the
   * (not-yet-wired, see run-critic.ts TODO) existing callers need no change.
   */
  genAiSystem?: string;
}

export interface PipelineRunnerOutput {
  firstPass: BrainOutputV2;
  rubricTriggers: RubricTrigger[];
  prioritized: RubricTrigger[];
  verifier: { ran: boolean; vetoed_rule_ids: string[] };
  finalTriggers: RubricTrigger[];
}

export async function runPipeline(input: PipelineRunnerInput): Promise<PipelineRunnerOutput> {
  const { tracer, traceStore } = input;
  const genAiSystem = input.genAiSystem ?? "anthropic";
  const trace = tracer && traceStore;

  // Root span: siltpoke.turn
  const rootAttrs: Record<string, string | number | boolean> = {};
  if (input.critiqueId) rootAttrs["siltpoke.critique_id"] = input.critiqueId;
  rootAttrs["siltpoke.cwd"] = input.cwd;

  const rootSpan = trace
    ? tracer.startSpan({ name: "siltpoke.turn", kind: "INTERNAL", attributes: rootAttrs })
    : null;

  const writeSpan = async (span: ReturnType<Tracer["startSpan"]>) => {
    if (traceStore) await traceStore.writeSpan(span);
  };

  try {
    // 1a. Rubric tier 1
    const tier1Span = trace
      ? tracer.startSpan({ name: "siltpoke.rubric.tier1", kind: "INTERNAL", parent: rootSpan! })
      : null;

    // 1b. Rubric pass (runs both tiers internally)
    const rubric = await runRubric(
      { cwd: input.cwd, changedFiles: input.changedFiles, diffHunks: input.diffHunks },
      ALL_RUBRIC_RULES,
    );

    if (tier1Span) {
      tracer?.setAttribute(tier1Span, "siltpoke.rubric.trigger_count", rubric.triggers.length);
      tracer?.setAttribute(tier1Span, "siltpoke.rubric.error_count", rubric.errors.length);
      tracer?.endSpan(tier1Span, { status: "OK" });
      await writeSpan(tier1Span);
    }

    // 1c. Tier 2 span (represents rule evaluation phase)
    const tier2Span = trace
      ? tracer.startSpan({ name: "siltpoke.rubric.tier2", kind: "INTERNAL", parent: rootSpan! })
      : null;
    if (tier2Span) {
      tracer?.setAttribute(tier2Span, "siltpoke.rubric.rules_evaluated", rubric.rule_results.length);
      tracer?.endSpan(tier2Span, { status: "OK" });
      await writeSpan(tier2Span);
    }

    // 2. Prompt build span
    const promptBuildSpan = trace
      ? tracer.startSpan({ name: "siltpoke.prompt.build", kind: "INTERNAL", parent: rootSpan! })
      : null;
    if (promptBuildSpan) {
      tracer?.setAttribute(promptBuildSpan, "siltpoke.trigger_count", rubric.triggers.length);
      tracer?.endSpan(promptBuildSpan, { status: "OK" });
      await writeSpan(promptBuildSpan);
    }

    // 3. First-pass Brain call
    const brainFindSpan = trace
      ? tracer.startSpan({
          name: "siltpoke.brain.find",
          kind: "CLIENT",
          parent: rootSpan!,
          attributes: { "gen_ai.system": genAiSystem, "gen_ai.operation.name": "chat" },
        })
      : null;

    const firstPass = await input.callBrainFind(rubric.triggers);

    if (brainFindSpan) {
      tracer?.setAttribute(brainFindSpan, "siltpoke.confidence", firstPass.confidence);
      tracer?.endSpan(brainFindSpan, { status: "OK" });
      await writeSpan(brainFindSpan);
    }

    // 4. Prioritize
    const prioritizeSpan = trace
      ? tracer.startSpan({ name: "siltpoke.prioritize", kind: "INTERNAL", parent: rootSpan! })
      : null;

    const prioritized = prioritize(rubric.triggers);

    if (prioritizeSpan) {
      tracer?.setAttribute(prioritizeSpan, "siltpoke.prioritized_count", prioritized.length);
      tracer?.endSpan(prioritizeSpan, { status: "OK" });
      await writeSpan(prioritizeSpan);
    }

    // 5. Verifier (conditional)
    const verifySpan = trace
      ? tracer.startSpan({
          name: "siltpoke.brain.verify",
          kind: "CLIENT",
          parent: rootSpan!,
          attributes: { "gen_ai.system": genAiSystem, "gen_ai.operation.name": "verify" },
        })
      : null;

    const verifierResult = await runVerifier({
      firstPass,
      triggers: prioritized,
      mode: input.verifierMode,
      callBrainVerifier: input.callBrainVerifier,
    });

    if (verifySpan) {
      tracer?.setAttribute(verifySpan, "siltpoke.verifier.ran", verifierResult.ran);
      tracer?.setAttribute(verifySpan, "siltpoke.verifier.vetoed_count", verifierResult.vetoed_rule_ids.length);
      tracer?.endSpan(verifySpan, { status: "OK" });
      await writeSpan(verifySpan);
    }

    // 6. Response parse span
    const parseSpan = trace
      ? tracer.startSpan({ name: "siltpoke.response.parse", kind: "INTERNAL", parent: rootSpan! })
      : null;
    if (parseSpan) {
      tracer?.setAttribute(parseSpan, "siltpoke.final_trigger_count", verifierResult.filtered_triggers.length);
      tracer?.endSpan(parseSpan, { status: "OK" });
      await writeSpan(parseSpan);
    }

    // End root span
    if (rootSpan) {
      tracer?.setAttribute(rootSpan, "siltpoke.final_trigger_count", verifierResult.filtered_triggers.length);
      tracer?.endSpan(rootSpan, { status: "OK" });
      await writeSpan(rootSpan);
    }

    return {
      firstPass,
      rubricTriggers: rubric.triggers,
      prioritized,
      verifier: { ran: verifierResult.ran, vetoed_rule_ids: verifierResult.vetoed_rule_ids },
      finalTriggers: verifierResult.filtered_triggers,
    };
  } catch (err) {
    if (rootSpan) {
      const msg = err instanceof Error ? err.message : String(err);
      tracer?.endSpan(rootSpan, { status: "ERROR", message: msg });
      await writeSpan(rootSpan);
    }
    throw err;
  }
}

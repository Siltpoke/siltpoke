// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// Pre-Brain pipeline phase: rubric tier1/tier2 + intent classification +
// captured-intent + tracing spans. Mutates brainContext fields used by the
// downstream Brain prompt assembly.

import { runRubric } from "../rubric/engine";
import { ALL_RUBRIC_RULES } from "../rubric/rules";
import type { RubricTrigger } from "../rubric/types";
import { dedupRubricTriggers } from "../rubric/dedup";
import { classifyIntent } from "../intent/classifier";
import { captureIntent, type CapturedIntent } from "../intent/capture";
import type { runTools } from "../tools/run-tools";
import type { Tracer } from "../../observability/tracer";
import type { Span } from "../../observability/types";
import type { BrainContext, RunCriticOpts, V2ResultFields } from "../types";

/**
 * Read the criticPipeline.enabled flag from ~/.siltpoke/config.json.
 * Defaults to true — opt-out by setting { "criticPipeline": { "enabled": false } }.
 * Fail-soft: any read/parse error leaves the pipeline enabled.
 */
export async function isPipelineEnabled(homeBase: string | undefined): Promise<boolean> {
  if (homeBase === undefined) return true;
  try {
    const { readFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const configPath = join(homeBase, "config.json");
    if (!existsSync(configPath)) return true;
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { criticPipeline?: { enabled?: boolean } };
    const flag = parsed?.criticPipeline?.enabled;
    return flag !== false;
  } catch {
    return true;
  }
}

export interface PreBrainPipelineArgs {
  opts: RunCriticOpts;
  toolResults: Awaited<ReturnType<typeof runTools>>;
  brainContext: BrainContext;
  cwd: string;
  changedFiles: string[];
  homeBase: string | undefined;
  tracing: boolean;
  tracer: Tracer | null;
  rootSpan: Span | null;
  writeSpan: (span: Span) => Promise<void>;
  /** Injectable clock for rubric cross-Stop dedup. Defaults to new Date(). */
  now?: Date;
}

/**
 * Run rubric tier1/tier2 + intent + captureIntent + emit spans.
 * Mutates `brainContext` (rubricTriggers / intentResult / capturedIntent)
 * and returns the V2ResultFields to be carried into the Brain call paths.
 *
 * If criticPipeline.enabled=false in config, returns {pipelineRan: false}
 * without running any phase work — keeps the legacy fast-path intact.
 */
export async function runPreBrainPipeline(args: PreBrainPipelineArgs): Promise<V2ResultFields> {
  const { opts, toolResults, brainContext, cwd, changedFiles, homeBase, tracing, tracer, rootSpan, writeSpan } = args;
  const now = args.now ?? new Date();

  const pipelineEnabled = await isPipelineEnabled(homeBase);
  if (!pipelineEnabled) return { pipelineRan: false };

  let rubricTriggers: RubricTrigger[] = [];

  // Extract added lines from git-diff for the rubric engine.
  const gdForRubric = toolResults["git-diff"];
  const diffHunks: Array<{ file: string; addedLines: number[] }> =
    gdForRubric.tool === "git-diff" && gdForRubric.status === "ok"
      ? gdForRubric.parsed.map((h) => ({
          file: h.file,
          addedLines: [],  // heuristic: rubric rules read file content directly
        }))
      : [];
  const rubricInput = { cwd, changedFiles, diffHunks };

  // Split rules by tier so each tier gets its own span with real timing,
  // its own input shape (rule list), and its own filtered trigger output.
  // Previously both spans shared one runRubric() result, making
  // tier1.input/output identical to tier2 in the trace UI.
  const tier1Rules = ALL_RUBRIC_RULES.filter((r) => r.tier === 1);
  const tier2Rules = ALL_RUBRIC_RULES.filter((r) => r.tier === 2);

  // Redact absolute paths in trigger `file` fields before serialising
  // into the span output, so the trace UI + spillover sidecar show
  // project-relative paths ('src/...') instead of leaking the user's
  // /Users/{name}/ prefix into observability data.
  const cwdSlash = cwd.endsWith("/") ? cwd : cwd + "/";
  const redactTriggerPath = (t: RubricTrigger): RubricTrigger =>
    t.file.startsWith(cwdSlash)
      ? { ...t, file: t.file.slice(cwdSlash.length) }
      : t;

  async function runTier(
    tierNum: 1 | 2,
    rules: typeof ALL_RUBRIC_RULES,
  ): Promise<RubricTrigger[]> {
    const spanName = `siltpoke.rubric.tier${tierNum}`;
    const span = tracing
      ? tracer!.startSpan({ name: spanName, kind: "INTERNAL", parent: rootSpan! })
      : null;
    if (span && tracer) {
      tracer.setKind(span, "rubric");
      tracer.setInput(span, {
        tier: tierNum,
        rule_ids: rules.map((r) => r.id),
        rule_count: rules.length,
        changedFiles_count: changedFiles.length,
        diffHunks_count: diffHunks.length,
      });
    }
    try {
      const result = await runRubric(rubricInput, rules);
      if (span && tracer) {
        tracer.setAttribute(span, "siltpoke.rubric.trigger_count", result.triggers.length);
        tracer.setAttribute(span, "siltpoke.rubric.error_count", result.errors.length);
        tracer.setAttribute(span, "siltpoke.rubric.rules_evaluated", result.rule_results.length);
        tracer.setOutput(span, {
          tier: tierNum,
          triggers: result.triggers.map(redactTriggerPath),
          errors: result.errors,
          rule_results: result.rule_results.map((rr) => ({
            rule_id: rr.rule_id,
            trigger_count: rr.triggers.length,
            duration_ms: rr.duration_ms,
            error: rr.error,
          })),
        });
        tracer.endSpan(span, { status: "OK" });
        await writeSpan(span);
      }
      return result.triggers;
    } catch {
      if (span && tracer) {
        tracer.endSpan(span, { status: "ERROR", message: `runRubric tier${tierNum} threw` });
        await writeSpan(span);
      }
      return [];
    }
  }

  const tier1Triggers = await runTier(1, tier1Rules);
  const tier2Triggers = await runTier(2, tier2Rules);
  // Cross-Stop suppression: drop deterministic flags already surfaced in the
  // last 24h so an unchanged oversized file isn't re-flagged every Stop. Keep
  // the pre-dedup count so the archive can record what was suppressed.
  const firedTriggers = [...tier1Triggers, ...tier2Triggers];
  rubricTriggers = dedupRubricTriggers(firedTriggers, homeBase, now);
  const rubricSuppressedCount = firedTriggers.length - rubricTriggers.length;

  // Intent classification
  const intentSpan = tracing
    ? tracer!.startSpan({ name: "siltpoke.intent.classify", kind: "INTERNAL", parent: rootSpan! })
    : null;
  if (intentSpan && tracer) {
    tracer.setKind(intentSpan, "chain");
  }

  let intentResult: { classification: string; confidence: number; signal_source: string } | undefined;
  try {
    const changedExts = new Set(changedFiles.map((f) => {
      const m = f.match(/\.([^./]+)$/);
      return m ? m[1].toLowerCase() : "";
    }).filter(Boolean));

    if (intentSpan && tracer) {
      tracer.setInput(intentSpan, {
        user_message: brainContext.intent?.classification ?? "",
        commit_msg: opts.commitMsg ?? null,
        file_exts: Array.from(changedExts),
      });
    }

    const intentRaw = classifyIntent({
      user_message: brainContext.intent?.classification ?? "",
      commit_msg: opts.commitMsg ?? null,
      changed_file_exts: changedExts,
    });
    intentResult = {
      classification: intentRaw.classification,
      confidence: intentRaw.confidence,
      signal_source: intentRaw.signal_source,
    };

    if (intentSpan && tracer) {
      tracer.setAttribute(intentSpan, "siltpoke.intent.classification", intentResult.classification);
      tracer.setAttribute(intentSpan, "siltpoke.intent.confidence", intentResult.confidence);
      tracer.setOutput(intentSpan, intentResult);
      tracer.endSpan(intentSpan, { status: "OK" });
      await writeSpan(intentSpan);
    }
  } catch {
    if (intentSpan && tracer) {
      tracer.endSpan(intentSpan, { status: "ERROR", message: "classifyIntent threw" });
      await writeSpan(intentSpan);
    }
    // Intent failure non-fatal
  }

  // Prompt build span
  const promptBuildSpan = tracing
    ? tracer!.startSpan({ name: "siltpoke.prompt.build", kind: "INTERNAL", parent: rootSpan! })
    : null;
  if (promptBuildSpan && tracer) {
    tracer.setKind(promptBuildSpan, "chain");
    tracer.setInput(promptBuildSpan, {
      has_rubric: rubricTriggers.length > 0,
      has_summary: false,  // diff summary hasn't run yet at this point
      has_anti_examples: false,
      rubric_trigger_count: rubricTriggers.length,
    });
    tracer.setAttribute(promptBuildSpan, "siltpoke.rubric.trigger_count", rubricTriggers.length);
    tracer.setOutput(promptBuildSpan, {
      sections: ["personality", "memory", "recent", "tool_output", rubricTriggers.length > 0 ? "rubric" : null].filter(Boolean),
    });
    tracer.endSpan(promptBuildSpan, { status: "OK" });
    await writeSpan(promptBuildSpan);
  }

  // Capture user query + agent restatement from transcript turns.
  let capturedIntentResult: CapturedIntent | undefined;
  if (opts.transcriptTurns !== undefined) {
    try {
      capturedIntentResult = captureIntent(opts.transcriptTurns, opts.commitMsg ?? null);
    } catch {
      // Non-fatal — captureIntent failure must not block the critic pipeline.
    }
  }

  // Propagate to brainContext so existing Brain call paths can read it.
  brainContext.rubricTriggers = rubricTriggers;
  brainContext.intentResult = intentResult;
  brainContext.capturedIntent = capturedIntentResult;

  return { pipelineRan: true, rubricTriggers, rubricSuppressedCount, intentResult, capturedIntent: capturedIntentResult };
}

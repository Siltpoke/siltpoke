// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Shared runCritic() callsite.
 *
 * TODO: Wire runPipeline() from src/critic/pipeline/runner.ts into this
 * flow (find→prioritize→conditional-verify). The runner is ready to call —
 * integration deferred to minimise blast radius on the existing
 * NORMAL/PASSIVE_BUBBLE gate paths.
 * Config-driven verifier mode is available via src/config/verifier.ts.
 *
 * The shared entry for both Stop-hook and /siltpoke-review CLI.
 *
 * Flow:
 *   1. runTools(cwd, changedFiles, caps)           — aggregator
 *   2. classifyToolOutput(results)                 — 3-tier gate
 *   3. HARD_SUPPRESS  → log telemetry, return early (no Brain call)
 *   4. PASSIVE_BUBBLE → buildPassiveBubblePrompt + callBrain + writeCritique
 *   5. NORMAL         → buildToolOutputSection + assembleSystemPrompt + callBrain +
 *                       guardCritique + writeCritique (if guard accepts)
 *
 * Never throws — all downstream errors are caught and returned as HARD_SUPPRESS.
 *
 * Source tagging: opts.source ("stop-hook" | "review-cli") is recorded in every
 * telemetry log entry so the two call paths can be differentiated.
 */

import { callBrain } from "../brain/brain";
import { makeGuardedCallBrain } from "../brain/brain-guarded";
import type { Span } from "../observability/types";
import {
  recordGateDecision,
} from "../state/critic-counters";
import { writeCritique } from "../state/critique";
import { classifyToolOutput } from "./classify-output";
import { type DiffSummary, heuristicDiffSummary, runDiffSummary, SUMMARIZER_MODEL } from "./tools/run-diff-summary";
import { runTools } from "./tools/run-tools";

// ---------------------------------------------------------------------------
// Public types — re-exported from ./types for backward-compat.
// ---------------------------------------------------------------------------

export { autoPromoteSeverity } from "./phases/severity-promotion";
export type {
  BrainContext,
  CriticSource,
  RunCriticDeps,
  RunCriticOpts,
  RunCriticResult,
  TimingTrace,
  V2ResultFields,
} from "./types";

import { runNormalPhase } from "./phases/normal";
import { setBrainUsageAttrs } from "./phases/usage-attrs";
import { runPassiveBubblePhase } from "./phases/passive-bubble";
import { runPreBrainPipeline } from "./phases/pre-brain";
import { runToolsPhase } from "./phases/tools";

import type {
  RunCriticDeps,
  RunCriticOpts,
  RunCriticResult,
  TimingTrace,
  V2ResultFields,
} from "./types";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function runCritic(
  opts: RunCriticOpts,
  deps?: RunCriticDeps,
): Promise<RunCriticResult> {
  const { source, cwd, changedFiles, caps, brainContext, homeBase } = opts;
  const runCriticStart = Date.now();
  // Tracked across the function so each return path can include timing.
  const timing: TimingTrace = { summary_ms: 0, critic_ms: 0, wall_ms: 0 };
  const seal = (): TimingTrace => ({ ...timing, wall_ms: Date.now() - runCriticStart });

  // Set up tracer if provided.
  const tracer = opts.tracer ?? null;
  const traceStore = opts.traceStore ?? null;
  const tracing = tracer !== null && traceStore !== null;

  const writeSpan = async (span: Span): Promise<void> => {
    if (traceStore) {
      try { await traceStore.writeSpan(span); } catch { /* non-fatal */ }
    }
  };

  // Recursively strip the absolute project-root prefix from every string
  // anywhere in a value tree, so trace span outputs (which are observed
  // through the UI + spillover JSONs) carry project-relative paths only.
  // Cheap deep-walk; unaware of which keys are paths — operates on raw
  // string values that happen to start with cwd.
  const cwdSlash = cwd.endsWith("/") ? cwd : `${cwd}/`;
  const redactCwdPaths = <T,>(v: T): T => {
    const walk = (x: unknown): unknown => {
      if (typeof x === "string") {
        return x.startsWith(cwdSlash) ? x.slice(cwdSlash.length) : x;
      }
      if (Array.isArray(x)) return x.map(walk);
      if (x && typeof x === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
          out[k] = walk(val);
        }
        return out;
      }
      return x;
    };
    return walk(v) as T;
  };

  // Root span — covers the entire runCritic call.
  const rootSpan = tracing
    ? tracer?.startSpan({ name: "siltpoke.turn", kind: "INTERNAL", attributes: { "siltpoke.source": source, "siltpoke.cwd": cwd } })
    : null;
  if (rootSpan && tracer) {
    tracer.setKind(rootSpan, "chain");
    tracer.setInput(rootSpan, { source, cwd, changedFiles_count: changedFiles.length });
  }

  const runToolsFn = deps?.runToolsFn ?? runTools;
  // The single retry/health choke point — production Brain
  // calls go through the guarded wrapper (classify → record → throttle
  // 1-retry). Tests injecting callBrainFn bypass it; without a homeBase
  // there is nowhere to record health, so fall back to the bare call.
  const callBrainFn =
    deps?.callBrainFn ??
    (homeBase !== undefined ? makeGuardedCallBrain({ homeBase }) : callBrain);
  const writeCritiqueFn = deps?.writeCritiqueFn ?? writeCritique;
  // When tests stub callBrainFn but not runDiffSummaryFn, default the
  // summary pre-pass to a no-op so we don't accidentally spawn `claude -p`
  // from a test harness. Production callers don't pass `deps` at all and
  // get the real summarizer.
  const runDiffSummaryFn =
    deps?.runDiffSummaryFn ??
    (deps?.callBrainFn !== undefined
      ? (async () => null)
      : runDiffSummary);

  // Step 1: Run tools, fall back to recent commits if working tree clean,
  // write snapshot to disk for /critic page.
  const tools = await runToolsPhase({
    cwd, changedFiles, caps, homeBase, source,
    sessionId: brainContext.sessionId, runToolsFn,
  });
  if (!tools.ok) {
    if (rootSpan && tracer) {
      tracer.setOutput(rootSpan, { decision: "HARD_SUPPRESS" });
      tracer.endSpan(rootSpan, { status: "ERROR", message: tools.reason });
      await writeSpan(rootSpan);
    }
    return { decision: "HARD_SUPPRESS", reason: tools.reason, timing: seal() };
  }
  const { toolResults, diffSnapshotId, diffBody } = tools;
  // Diff summary pre-pass (Haiku). Kicked off as a background promise so
  // it runs in PARALLEL with the main Brain critic call below — the
  // summary feeds the /critic dashboard only, not the critic prompt
  // (Brain already gets the raw diff through toolOutputSection). This
  // saves ~30s per fire compared to waiting on Haiku first.
  //
  // Fail-soft: any error here leaves diffSummary undefined and runCritic
  // continues with the plain tool output.
  const summaryStart = Date.now();
  // NOTE: do not swallow the rejection here — finalizeSummary needs the
  // real error message to write into diff-summary.log. The catch lives
  // there so the message survives.
  // Wrap the Haiku summarizer call in a span so it appears in the trace tree.
  const diffSummaryPromise: Promise<DiffSummary | undefined> =
    diffBody.trim().length > 0
      ? (async () => {
          const summarizerSpan = tracing
            ? tracer?.startSpan({
                name: "siltpoke.summarizer.haiku",
                kind: "CLIENT",
                parent: rootSpan!,
                attributes: {
                  "gen_ai.system": "anthropic",
                  "gen_ai.request.model": "claude-haiku-4-5",
                  "siltpoke.kind": "llm",
                },
              })
            : null;
          if (summarizerSpan && tracer) {
            tracer.setKind(summarizerSpan, "llm");
            // System prompt is intentionally NOT stored in the trace —
            // it's proprietary scaffolding, not observability data the
            // user needs to read. User-role content IS the raw diff Haiku
            // sees — surface it so the trace is debuggable. jsonClip caps
            // the size at 32KB; larger diffs get a truncation marker.
            tracer.setInput(summarizerSpan, {
              diff_bytes: diffBody.length,
              messages: [
                { role: "system", content: "[redacted — siltpoke summarizer system prompt]" },
                { role: "user", content: diffBody },
              ],
            }, { maxBytes: 32768 });
          }
          try {
            const r = await runDiffSummaryFn({ diffText: diffBody });
            const summary = r?.summary;
            if (summarizerSpan && tracer) {
              if (summary) {
                tracer.setOutput(summarizerSpan, {
                  intent: summary.intent.slice(0, 200),
                  file_count: summary.file_count,
                  risks_count: summary.risks.length,
                  source: summary.source,
                });
                if (r?.usage) {
                  setBrainUsageAttrs(tracer, summarizerSpan, r.usage, SUMMARIZER_MODEL);
                }
              } else {
                tracer.setOutput(summarizerSpan, { result: "null" });
              }
              tracer.endSpan(summarizerSpan, { status: "OK" });
              await writeSpan(summarizerSpan);
            }
            return summary;
          } catch (err) {
            if (summarizerSpan && tracer) {
              tracer.endSpan(summarizerSpan, { status: "ERROR", message: String(err) });
              await writeSpan(summarizerSpan);
            }
            throw err;
          }
        })()
      : Promise.resolve(undefined);

  // We'll await the summary at the very end (after the Brain call) so it
  // can finish in the background while Brain runs. Capture the elapsed
  // time + error message for the diff-summary.log audit line.
  let diffSummary: DiffSummary | undefined;
  let diffSummaryError: string | undefined;
  const finalizeSummary = async (): Promise<void> => {
    try {
      diffSummary = await diffSummaryPromise;
      if (diffSummary === undefined && diffBody.trim().length > 0) {
        diffSummaryError = "runDiffSummary returned null";
      }
    } catch (err) {
      diffSummaryError = err instanceof Error ? err.message : String(err);
    }
    // Fallback: when Haiku failed (rejected) OR returned an empty
    // result on a non-empty diff, synthesize a heuristic summary so
    // the dashboard always shows something useful. Tag source so the
    // viewer knows it's degraded.
    if (diffSummary === undefined && diffBody.trim().length > 0) {
      diffSummary = heuristicDiffSummary(diffBody);
    }
    const elapsed = Date.now() - summaryStart;
    if (diffBody.trim().length > 0) timing.summary_ms = elapsed;
    if (homeBase !== undefined && diffBody.trim().length > 0) {
      try {
        const { appendFile, mkdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        await mkdir(join(homeBase, "logs"), { recursive: true });
        await appendFile(
          join(homeBase, "logs", "diff-summary.log"),
          `${new Date().toISOString()} sess=${brainContext.sessionId.slice(0, 8)} ` +
            `bytes=${diffBody.length} ms=${elapsed} ` +
            `result=${diffSummary ? "ok" : "fail"} ` +
            `${diffSummaryError ? `error="${diffSummaryError.slice(0, 200).replace(/\n/g, " ")}"` : ""}\n`,
        );
      } catch {
        // log failure non-fatal
      }
    }
  };

  // Pre-Brain pipeline (rubric + intent + spans).
  // Mutates brainContext (rubricTriggers / intentResult / capturedIntent).
  const v2: V2ResultFields = await runPreBrainPipeline({
    opts,
    toolResults,
    brainContext,
    cwd,
    changedFiles,
    homeBase,
    tracing,
    tracer,
    rootSpan,
    writeSpan,
  });

  // Step 2: Classify tool output.
  const classification = classifyToolOutput(toolResults);

  console.error(
    `[siltpoke] runCritic [${source}] gate=${classification.decision} reason="${classification.reason}"`,
  );

  // Record gate decision telemetry (fire-and-forget).
  if (homeBase !== undefined) {
    void recordGateDecision(homeBase, classification.decision);
  }

  // Helpers to end root span and write it before returning.
  const closeRootSpan = async (
    status: "OK" | "ERROR",
    output: { decision: string; severity?: string },
    msg?: string,
  ): Promise<void> => {
    if (rootSpan && tracer) {
      tracer.setOutput(rootSpan, output);
      tracer?.endSpan(rootSpan, { status, message: msg });
      await writeSpan(rootSpan);
    }
  };

  // Step 3: Branch on gate decision.
  switch (classification.decision) {
    case "HARD_SUPPRESS": {
      console.error(
        `[siltpoke] runCritic [${source}] HARD_SUPPRESS — abstaining: ${classification.reason}`,
      );
      await finalizeSummary();
      await closeRootSpan("OK", { decision: "HARD_SUPPRESS" });
      return { decision: "HARD_SUPPRESS", reason: classification.reason, diffSnapshotId, diffSummary, summaryError: diffSummaryError, timing: seal(), ...v2 };
    }

    case "PASSIVE_BUBBLE": {
      const phase = await runPassiveBubblePhase({
        toolResults, brainContext, source, changedFiles, v2, diffSummary,
        callBrainFn, writeCritiqueFn,
        tracing, tracer, rootSpan, writeSpan, redactCwdPaths, timing,
      });
      await finalizeSummary();
      if (phase.kind === "hard_suppress") {
        await closeRootSpan("ERROR", { decision: "HARD_SUPPRESS" }, phase.reason);
        return { decision: "HARD_SUPPRESS", reason: phase.reason, diffSnapshotId, diffSummary, summaryError: diffSummaryError, timing: seal(), ...v2 };
      }
      await closeRootSpan("OK", { decision: "PASSIVE_BUBBLE", severity: phase.critique.severity });
      return { decision: "PASSIVE_BUBBLE", critique: phase.critique, usage: phase.usage, critiqueId: phase.critiqueId, diffSnapshotId, diffSummary, summaryError: diffSummaryError, timing: seal(), ...v2 };
    }

    case "NORMAL": {
      const phase = await runNormalPhase({
        toolResults, brainContext, source, changedFiles, homeBase, v2,
        diffSummaryPromise, diffBody,
        callBrainFn, writeCritiqueFn,
        tracing, tracer, rootSpan, writeSpan, redactCwdPaths, timing,
        callerImpact: deps?.callerImpact,
      });
      diffSummary = phase.diffSummary;
      diffSummaryError = phase.diffSummaryError;
      await finalizeSummary();
      if (phase.outcome.kind === "hard_suppress") {
        await closeRootSpan("ERROR", { decision: "HARD_SUPPRESS" }, phase.outcome.reason);
        return { decision: "HARD_SUPPRESS", reason: phase.outcome.reason, diffSnapshotId, diffSummary, summaryError: diffSummaryError, timing: seal(), ...v2 };
      }
      if (phase.outcome.kind === "guard_rejected") {
        await closeRootSpan("OK", { decision: "NORMAL" });
        return {
          decision: "NORMAL",
          accepted: false,
          reason: phase.outcome.reason,
          critique: phase.outcome.critique,
          usage: phase.outcome.usage,
          diffSnapshotId,
          diffSummary,
          ...v2,
        };
      }
      await closeRootSpan("OK", { decision: "NORMAL", severity: phase.outcome.critique.severity });
      return { decision: "NORMAL", accepted: true, critique: phase.outcome.critique, usage: phase.outcome.usage, critiqueId: phase.outcome.critiqueId, diffSnapshotId, diffSummary, summaryError: diffSummaryError, timing: seal(), ...v2 };
    }
  }
}

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
 *                       guardCritique + writeCritique (always — the check
 *                       drops unverifiable citations, not the review)
 *
 * Never throws — all downstream errors are caught and returned as HARD_SUPPRESS.
 *
 * Source tagging: opts.source ("stop-hook" | "review-cli") is recorded in every
 * telemetry log entry so the two call paths can be differentiated.
 */

import { callBrain } from "../brain/brain";
import { loadBrainConfig } from "../brain/brain-config";
import { makeGuardedCallBrain } from "../brain/brain-guarded";
import { type BrainProviderMeta, makeClaudeProvider } from "../brain/provider";
import { loadReviewerProvider } from "../brain/provider-select";
import { resolveRole } from "../brain/registry";
import { makeRoleRawBrain } from "../brain/role-brain";
import type { Span } from "../observability/types";
import {
  recordGateDecision,
} from "../state/critic-counters";
import { writeCritique } from "../state/critique";
import { classifyToolOutput } from "./classify-output";
import { type DiffSummary, heuristicDiffSummary, runDiffSummary } from "./tools/run-diff-summary";
import { runTools } from "./tools/run-tools";

/**
 * Fallback label for the diff-summary span when there's no `homeBase` to
 * resolve an `extract`-role config from (mirrors registry.ts's
 * CLAUDE_PINNED / the `extract` role's pinned default under a no-config
 * install). Used ONLY in that no-homeBase branch — when a homeBase IS
 * available, the span reports the actually-resolved `extract` role's
 * family + model (single-brain #10, S2, task 10 span-truthfulness fix; see
 * `extractSpanMeta` below). Prior to that fix this label was used
 * unconditionally, making the span assert "anthropic" + this model even
 * when a config.json routed `extract` to a different family (agy/qoder/
 * codebuddy) — a span-truthfulness regression, not a cost/usage bug (the
 * real usage object was always correct).
 */
const DEFAULT_EXTRACT_MODEL_LABEL = "claude-haiku-4-5-20251001";

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
import { runPassiveBubblePhase } from "./phases/passive-bubble";
import { runPreBrainPipeline } from "./phases/pre-brain";
import { loadBrainTimeoutMs } from "../config/brain-timeout-config";
import { runToolsPhase } from "./phases/tools";
import { setBrainUsageAttrs } from "./phases/usage-attrs";

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
  // Resolve the reviewer provider ONCE, ahead of the guarded wrapper, so its
  // meta (name/billing/genAiSystem) is available for ledger rows + span
  // attrs regardless of which classification/phase branch the turn takes
  // (track #7 T3, AC7/AC14). `deps.callBrainFn` short-circuits real
  // resolution (test seam) — `deps.providerMeta` lets those same tests
  // simulate a non-claude provider without touching disk.
  const resolvedReview =
    deps?.callBrainFn === undefined && homeBase !== undefined
      ? await loadReviewerProvider(homeBase)
      : undefined;
  const providerMeta: BrainProviderMeta =
    deps?.providerMeta ?? resolvedReview?.provider.meta ?? makeClaudeProvider().meta;
  // Resolved review model (reviewer_model plumbing, single-brain #10 critic
  // half). Threaded into the review Brain call below so the active
  // reviewer_provider runs the configured model (agy/qoder/codebuddy honor it
  // via their `--model` argv; codex ignores it by design). undefined when a
  // test injects deps.callBrainFn (real resolution short-circuited) or under a
  // no-config install where the family default applies.
  const reviewModel = resolvedReview?.model;
  // The single retry/health choke point — production Brain
  // calls go through the guarded wrapper (classify → record → throttle
  // 1-retry). Tests injecting callBrainFn bypass it; without a homeBase
  // there is nowhere to record health, so fall back to the bare call.
  // The guarded path resolves reviewer_provider (config + env override,
  // track #7 T1) — the critic seam is the ONLY allowlisted consumer;
  // callBrainFn injection short-circuits before this ever reads disk.
  const callBrainFn =
    deps?.callBrainFn ??
    (homeBase !== undefined && resolvedReview !== undefined
      ? makeGuardedCallBrain({ homeBase, provider: resolvedReview.provider })
      : callBrain);
  const writeCritiqueFn = deps?.writeCritiqueFn ?? writeCritique;
  // Reviewer kill timer, read ONCE per turn beside the provider resolution
  // rather than inside each phase — both branches need it and a phase doing its
  // own IO would read the same file twice for one review. `undefined` when the
  // key is absent, which is what lets SILTPOKE_BRAIN_TIMEOUT_MS keep working:
  // resolveBrainTimeoutMs consults the env only when no explicit value arrives.
  // Why it is configurable at all: 14.2% of critic calls die at the 90s default
  // and the kill censors the very distribution needed to choose a better number
  // (an internal design note §3.7-§3.9).
  const brainTimeoutMs =
    homeBase !== undefined ? await loadBrainTimeoutMs(homeBase) : undefined;
  // When tests stub callBrainFn but not runDiffSummaryFn, default the
  // summary pre-pass to a no-op so we don't accidentally spawn `claude -p`
  // from a test harness. Production callers don't pass `deps` at all and
  // get the real summarizer.
  const runDiffSummaryFn =
    deps?.runDiffSummaryFn ??
    (deps?.callBrainFn !== undefined
      ? (async () => null)
      : runDiffSummary);
  // Single shared extract-role seam (single-brain #10, S2, task 10): the
  // diff-summary pre-pass doesn't receive homeBase itself, so runCritic
  // builds ONE makeRoleRawBrain(homeBase, "extract") here and injects it as
  // runDiffSummaryFn's callFn below. Without a homeBase there is nowhere to
  // resolve a role from — runDiffSummaryFn falls back to its own lazy
  // callBrainRaw default (mirrors the callBrainFn fallback above).
  const diffSummaryCallFn =
    homeBase !== undefined ? makeRoleRawBrain(homeBase, "extract") : undefined;
  // Resolve the `extract` role's provider meta ONCE (single-brain #10, S2,
  // task 10 span-truthfulness fix) — used to make the diff-summary span's
  // "gen_ai.system" / "gen_ai.request.model" attributes match the family
  // that ACTUALLY runs diffSummaryCallFn above, instead of a hardcoded
  // "anthropic" label. Mirrors passive-bubble.ts's providerMeta.genAiSystem
  // shape (for gen_ai.system) and repo-summary.ts's live
  // resolveRoleMeta/resolveRole pattern (for the model). Without a
  // homeBase there's nowhere to resolve a role from, so fall back to the
  // same claude/anthropic defaults the pre-fix hardcoded span always used —
  // byte-identical behavior for that path (mirrors diffSummaryCallFn's own
  // no-homeBase fallback above).
  let extractSpanMeta: { genAiSystem: string; model: string };
  if (homeBase !== undefined) {
    const resolvedExtract = resolveRole(await loadBrainConfig(homeBase), "extract");
    extractSpanMeta = {
      genAiSystem: resolvedExtract.provider.meta.genAiSystem,
      model: resolvedExtract.model ?? "unknown",
    };
  } else {
    extractSpanMeta = { genAiSystem: "anthropic", model: DEFAULT_EXTRACT_MODEL_LABEL };
  }

  // Step 1: Run tools, fall back to recent commits if working tree clean,
  // write snapshot to disk for /critic page.
  // `tracing` is passed only when all three parts exist — the helper in
  // run-tools requires tracer + store + parent together, and a partial context
  // would be a silent no-op. F9.1: this argument is what was missing; the
  // spans themselves were built and tested long before any caller sent one.
  // `rootSpan` is `Span | null | undefined` — null when tracing is off, and
  // undefined if `tracer?.startSpan` ever short-circuits. Both mean "no parent
  // to hang tool spans under", so this checks for a value rather than for one
  // of the two empty shapes.
  const toolsTracing =
    tracer !== null && traceStore !== null && rootSpan != null
      ? { tracer, traceStore, parentSpan: rootSpan }
      : undefined;
  const tools = await runToolsPhase({
    cwd, changedFiles, caps, homeBase, source,
    sessionId: brainContext.sessionId, runToolsFn,
    tracing: toolsTracing,
    revisionRange: opts.revisionRange,
  });
  if (!tools.ok) {
    if (rootSpan && tracer) {
      tracer.setOutput(rootSpan, { decision: "HARD_SUPPRESS" });
      tracer.endSpan(rootSpan, { status: "ERROR", message: tools.reason });
      await writeSpan(rootSpan);
    }
    return { decision: "HARD_SUPPRESS", reason: tools.reason, timing: seal(), providerMeta };
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
                // Provider-routed via the `extract` role (single-brain #10,
                // S2, task 10): diffSummaryCallFn above wires
                // makeRoleRawBrain(homeBase, "extract") into this call — the
                // compressed diff is family-agnostic context for the review,
                // gated by the extract role's zod + capability floor. The
                // MAIN review call stays on the `review` role (already
                // provider-routed in S1, untouched). This supersedes the
                // pre-task-10 comment here, which said this call was NOT
                // provider-routed and stayed "anthropic" by design (track #7
                // T3) — that was true before task 10, not after. The
                // attributes below now report extractSpanMeta (resolved
                // above, once, from the SAME `extract` role config that
                // diffSummaryCallFn is built from) — a task-10 follow-up fix
                // for a span-truthfulness regression where this span kept
                // asserting a hardcoded "anthropic" + pinned Haiku model even
                // when a config.json routed `extract` to a non-claude family.
                attributes: {
                  "gen_ai.system": extractSpanMeta.genAiSystem,
                  "gen_ai.request.model": extractSpanMeta.model,
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
            const r = await runDiffSummaryFn({ diffText: diffBody, callFn: diffSummaryCallFn });
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
                  setBrainUsageAttrs(
                    tracer,
                    summarizerSpan,
                    r.usage,
                    extractSpanMeta.model,
                    extractSpanMeta.genAiSystem,
                  );
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
  //
  // Settle-capture, attached IMMEDIATELY: the promise above is created before
  // the Brain call and consumed after it, so on the rejecting path it would
  // otherwise sit with no handler attached for the entire duration of that call
  // — an unhandled rejection window measured in tens of seconds. `finalizeSummary`
  // does catch, but far too late to stop the runtime from reporting it first.
  // Converting the rejection into a value here closes the window without moving
  // the await, so the concurrency this whole arrangement exists for is untouched.
  const settledSummary: Promise<
    { ok: true; value: DiffSummary | undefined } | { ok: false; error: unknown }
  > = diffSummaryPromise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );

  let diffSummary: DiffSummary | undefined;
  let diffSummaryError: string | undefined;
  // Idempotence guard. Defect ② is fixed by having the PASSIVE_BUBBLE phase call
  // finalizeSummary() itself, right before autoPromoteSeverity — but the existing
  // call further down must stay (it is the only one on the HARD_SUPPRESS path and
  // it carries the timing + audit-log write). Making a second call a no-op lets
  // both live without double-logging or double-counting the elapsed time.
  let summarySettled = false;
  const finalizeSummary = async (): Promise<void> => {
    if (summarySettled) return;
    summarySettled = true;
    const settled = await settledSummary;
    if (settled.ok) {
      diffSummary = settled.value;
      if (diffSummary === undefined && diffBody.trim().length > 0) {
        diffSummaryError = "runDiffSummary returned null";
      }
    } else {
      const err = settled.error;
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
      return { decision: "HARD_SUPPRESS", reason: classification.reason, diffSnapshotId, diffSummary, summaryError: diffSummaryError, timing: seal(), ...v2, providerMeta };
    }

    case "PASSIVE_BUBBLE": {
      // Defect ②: this used to pass `diffSummary` BY VALUE, and `finalizeSummary()`
      // — its only assignment site — ran on the line below. JS passes by value, so
      // the phase always received `undefined`, `autoPromoteSeverity`'s `hasRisks`
      // was structurally always false, and that branch produced 0 of 2,643 outputs
      // while 1,500 of 1,843 runs WITH summary risks still shipped severity=info
      // and an empty critique.
      //
      // The phase now settles the summary itself, immediately before it promotes.
      // Deliberately NOT the raw promise: `finalizeSummary` is what converts a
      // rejection into `diffSummaryError` and synthesises the heuristic fallback,
      // and a phase awaiting the raw promise would throw straight past all of it.
      const phase = await runPassiveBubblePhase({
        toolResults, brainContext, source, changedFiles, v2,
        finalizeSummary, getDiffSummary: () => diffSummary,
        callBrainFn, writeCritiqueFn,
        tracing, tracer, rootSpan, writeSpan, redactCwdPaths, timing,
        providerMeta, reviewModel, brainTimeoutMs,
      });
      // No-op when the phase already settled it; still required for the paths
      // where the phase returned early.
      await finalizeSummary();
      if (phase.kind === "hard_suppress") {
        await closeRootSpan("ERROR", { decision: "HARD_SUPPRESS" }, phase.reason);
        return { decision: "HARD_SUPPRESS", reason: phase.reason, diffSnapshotId, diffSummary, summaryError: diffSummaryError, timing: seal(), ...v2, providerMeta, skipCode: phase.skipCode, memoryFunnel: phase.memoryFunnel, promptBytes: phase.promptBytes };
      }
      await closeRootSpan("OK", { decision: "PASSIVE_BUBBLE", severity: phase.critique.severity });
      return { decision: "PASSIVE_BUBBLE", critique: phase.critique, usage: phase.usage, critiqueId: phase.critiqueId, evidenceLabel: "not_checked", diffSnapshotId, diffSummary, summaryError: diffSummaryError, timing: seal(), ...v2, providerMeta, servedModel: phase.servedModel, memoryFunnel: phase.memoryFunnel, promptBytes: phase.promptBytes };
    }

    case "NORMAL": {
      const phase = await runNormalPhase({
        toolResults, brainContext, source, changedFiles, homeBase, v2, brainTimeoutMs,
        diffSummaryPromise, diffBody,
        callBrainFn, writeCritiqueFn,
        tracing, tracer, rootSpan, writeSpan, redactCwdPaths, timing,
        callerImpact: deps?.callerImpact,
        reverseDeps: deps?.reverseDeps,
        providerMeta, reviewModel,
      });
      diffSummary = phase.diffSummary;
      diffSummaryError = phase.diffSummaryError;
      await finalizeSummary();
      if (phase.outcome.kind === "hard_suppress") {
        await closeRootSpan("ERROR", { decision: "HARD_SUPPRESS" }, phase.outcome.reason);
        return { decision: "HARD_SUPPRESS", reason: phase.outcome.reason, diffSnapshotId, diffSummary, summaryError: diffSummaryError, timing: seal(), ...v2, providerMeta, skipCode: phase.outcome.skipCode, memoryFunnel: phase.memoryFunnel, promptBytes: phase.promptBytes };
      }
      // No `guard_rejected` branch to handle here any more. The evidence check
      // labels citations rather than discarding reviews, so every NORMAL run
      // that reached the Brain lands on the accepted return below — carrying
      // `evidenceLabel` where a rejection reason used to be.
      await closeRootSpan("OK", { decision: "NORMAL", severity: phase.outcome.critique.severity });
      return { decision: "NORMAL", accepted: true, critique: phase.outcome.critique, usage: phase.outcome.usage, critiqueId: phase.outcome.critiqueId, evidenceLabel: phase.outcome.evidenceLabel, diffCoverage: phase.outcome.diffCoverage, unverifiedCount: phase.outcome.unverifiedCount, diffSnapshotId, diffSummary, summaryError: diffSummaryError, timing: seal(), ...v2, providerMeta, servedModel: phase.outcome.servedModel, memoryFunnel: phase.memoryFunnel, promptBytes: phase.promptBytes };
    }
  }
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// NORMAL switch-case phase: full Brain critic call with tool-output section,
// rubric evidence, diff-summary, post-Brain evidence guard, and persist.

import { type BrainCallResult, BrainError, type BrainUsage, type CallBrainOptions } from "../../brain/brain";
import { assembleSystemPromptWithFunnel, type MemoryFunnel, type PromptSectionBytes } from "../../brain/prompt-assembly";
import { buildToolOutputSection } from "../../brain/prompt-tools";
import type { DiffCoverage } from "../../brain/hunk-selection";
import type { BrainProviderMeta } from "../../brain/provider";
import type { BrainOutput } from "../../brain/schema";
import type { Tracer } from "../../observability/tracer";
import type { Span } from "../../observability/types";
import { recordEvidenceUnverified } from "../../state/critic-counters";
import type { CritiqueInput } from "../../state/critique";
import { buildCallerImpactSection, type CallerImpactDeps } from "../caller-impact/inject";
import type { ImportersDeps } from "../disk-awareness/importers";
import { buildReverseDepsSection } from "../disk-awareness/reverse-deps";
import { type EvidenceLabel, guardCritique } from "../evidence-guard";
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
  /** Reviewer kill timer from config; undefined = fall through to env/default. */
  brainTimeoutMs: number | undefined;
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
  /**
   * Injected reverse-deps seams (ripgrep + resolver + listFiles) — critic
   * disk-awareness slice ①. Defaults applied inside `buildReverseDepsSection`.
   */
  reverseDeps?: ImportersDeps;
  /** Resolved reviewer-provider meta (track #7 T3) — span truth + ledger passthrough. */
  providerMeta: BrainProviderMeta;
  /** Resolved review model (reviewer_model plumbing, single-brain #10 critic
   * half) — sent as `opts.model` on the review Brain call so the active
   * reviewer_provider runs the configured model. undefined -> the provider's
   * own account/family default (byte-identical to pre-plumbing behavior). */
  reviewModel?: string;
}

export interface NormalPhaseResult {
  /** Locally-resolved diff summary so the orchestrator can echo it in the result envelope. */
  diffSummary: DiffSummary | undefined;
  /** Locally-captured diff-summary error so the orchestrator can echo it. */
  diffSummaryError: string | undefined;
  /**
   * Read-half memory funnel measured during prompt assembly (eval design §2.1).
   * Present on every branch here because all of them are reached AFTER assembly.
   */
  memoryFunnel: MemoryFunnel;
  /** Per-section byte counts from the SAME assembly the funnel came from —
   *  present on every branch for the same reason it is: all of them are
   *  reached after assembly, so an absent value means "never assembled",
   *  never "assembled empty". */
  promptBytes: PromptSectionBytes;
  outcome:
    | { kind: "hard_suppress"; reason: string; skipCode?: "quota_cap" | "agy_prompt_too_large" }
    | {
        kind: "ok";
        critique: BrainOutput;
        usage: BrainUsage;
        critiqueId: string | undefined;
        servedModel?: string;
        /**
         * How much of this review's evidence survived the check. There is no
         * longer a `guard_rejected` outcome to sit beside `ok`: the evidence
         * check labels citations instead of discarding reviews, so a review
         * whose citations all failed still comes out here — carrying
         * `evidenceLabel: "none_verified"` so the surface can say so.
         */
        evidenceLabel: EvidenceLabel;
        /**
         * What the 20-hunk budget cut, counted by siltpoke rather than
         * declared by the model. `null` when the whole diff fitted. The
         * surfaces state this on the review the user reads — the prompt asks
         * the reviewer to admit partial coverage and nothing verifies that it
         * did, so this is the half that cannot be skipped.
         */
        diffCoverage: DiffCoverage | null;
        /** How many cited items were dropped as unverifiable. */
        unverifiedCount: number;
      };
}

export async function runNormalPhase(args: NormalPhaseArgs): Promise<NormalPhaseResult> {
  const {
    toolResults, brainContext, source, changedFiles, homeBase, v2, brainTimeoutMs,
    diffSummaryPromise, diffBody,
    callBrainFn, writeCritiqueFn,
    tracing, tracer, rootSpan, writeSpan, redactCwdPaths, timing,
    callerImpact, reverseDeps, providerMeta, reviewModel,
  } = args;

  const { section, citationSection, evidenceCorpus, diffCoverage } =
    buildToolOutputSection(toolResults);

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
  // Sibling 1-hop block (critic disk-awareness slice ①): "files that import
  // what you changed", the reverse of caller-impact's "callers of what you
  // changed". Fail-soft inside (never throws) → empty section/tokens on any
  // failure, same posture as caller-impact above.
  const reverseDepsResult = buildReverseDepsSection(
    { changedFiles, cwd: brainContext.cwd },
    reverseDeps,
  );
  // Guard corpus = everything the Brain could legitimately cite verbatim.
  // The Brain SEES the formatted tool `section` (buildToolOutputSection), but
  // raw stdout reformats/truncates differently, so a snippet copied from the
  // section (e.g. a full tsc message) may be absent from the raw corpus. We
  // include both the formatted section AND raw stdout so a legitimate citation
  // passes the verbatim guard. Both are deterministic, tool-derived text — the
  // anti-hallucination property holds (the Haiku-generated diff summary is
  // deliberately NOT included; the Brain must not cite its own pre-pass prose).
  // NOT `section`: that variant carries the partial-coverage notice, which is
  // siltpoke's own prose and would pass the verbatim check as if a tool had
  // said it. See ToolOutputSection.citationSection.
  const guardCorpusParts = [citationSection, evidenceCorpus];
  if (callerImpactResult.tokens.length > 0) {
    guardCorpusParts.push(callerImpactResult.tokens.join("\n"));
  }
  if (reverseDepsResult.tokens.length > 0) {
    guardCorpusParts.push(reverseDepsResult.tokens.join("\n"));
  }
  const guardCorpus = guardCorpusParts.join("\n");

  const { prompt: systemPrompt, funnel: memoryFunnel, sizes: promptBytes } = assembleSystemPromptWithFunnel({
    personalitySystemPrompt: brainContext.personalitySystemPrompt,
    memory: brainContext.memory,
    recent: brainContext.recent,
    fileTypes: brainContext.fileTypes,
    maxRules: brainContext.maxRules,
    recentInjectionCount: brainContext.recentInjectionCount,
    toolOutputSection: toolOutputCombined,
    callerImpactSection: callerImpactResult.section,
    reverseDepsSection: reverseDepsResult.section,
    antiExamplesBlock: brainContext.antiExamplesBlock,
  });

  let brainResult: BrainCallResult;

  // Brain find span.
  const brainFindSpan = tracing
    ? tracer!.startSpan({ name: "siltpoke.brain.find", kind: "CLIENT", parent: rootSpan!, attributes: { "gen_ai.system": providerMeta.genAiSystem, "gen_ai.operation.name": "chat" } })
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
    brainResult = await callBrainFn({
      systemPrompt,
      contextBundle: "Produce one Siltpoke JSON per the system prompt.",
      // Reviewed-repo cwd (track #7 T3 deferred item) — the daemon's own
      // process.cwd() is frozen at launch and isn't the repo being reviewed;
      // the codex adapter's `-C` needs the real one. Claude ignores it.
      cwd: brainContext.cwd,
      // Resolved review model (reviewer_model plumbing, single-brain #10 critic
      // half). Un-drops the model onto the review call: agy/qoder/codebuddy push
      // it to `--model`; codex ignores it (no --model under ChatGPT auth). Also
      // arms the agy cross-family honesty warn (brain-guarded.ts) when the model
      // is Claude-family. undefined -> provider's own default (unchanged).
      model: reviewModel,
          // Kill timer from `<home>/config.json`'s `brain.timeout_ms`. `undefined`
      // is meaningful: resolveBrainTimeoutMs only consults
      // SILTPOKE_BRAIN_TIMEOUT_MS when no explicit value arrives, so forcing a
      // number here would disable the env knob.
      timeoutMs: brainTimeoutMs,
});
    timing.critic_ms = Date.now() - criticStart;
    if (brainFindSpan && tracer) {
      tracer.setOutput(brainFindSpan, redactCwdPaths(brainResult.output));
      tracer.endSpan(brainFindSpan, { status: "OK" });
      await writeSpan(brainFindSpan);
    }
  } catch (err) {
    if (brainFindSpan && tracer) {
      // Record the REJECTED reply, not just the error string. This is the one
      // case where you need to see what the model said, and it was the one case
      // nothing kept: the success path calls setOutput, this path did not, so a
      // failing span carried an input and no output. `setOutput` clips at 8 KB
      // and spills the rest. `redactCwdPaths` is applied, the same call the
      // success path makes — but say what that buys, because it is less here:
      // it strips a leading cwd from string VALUES, so on a validated
      // BrainOutput (`evidence[].file` is a bare path) it bites, and on the
      // not-valid-JSON case the payload is one prose blob where a path sits
      // mid-sentence and the walk is a no-op. The reply can quote reviewed
      // source; this is the same exposure the success path already accepts,
      // not a stronger guarantee.
      //
      // Absent on a spawn/timeout failure, where there IS no reply. Writing an
      // empty output there would read as "the model returned nothing", which is
      // a different claim and a false one.
      if (err instanceof BrainError && err.rawResponse !== undefined) {
        // Wrapped when it is a bare string: an over-cap payload spills to
        // `<trace>-<span>-output.json` and is served `application/json`, and
        // the not-valid-JSON replies are exactly the ones large enough to
        // spill. An unwrapped prose blob would put non-JSON in a .json sidecar.
        const reply = err.rawResponse;
        tracer.setOutput(
          brainFindSpan,
          redactCwdPaths(typeof reply === "string" ? { raw_text: reply } : reply),
        );
      }
      tracer.endSpan(brainFindSpan, { status: "ERROR", message: String(err) });
      await writeSpan(brainFindSpan);
    }
    const reason = `Brain call failed in NORMAL: ${err}`;
    console.error(`[siltpoke] runCritic [${source}] HARD_SUPPRESS — ${reason}`);
    // Quota-cap / agy-prompt-too-large skip (track #7 T4 fixup): surfaced as
    // a distinguishable machine-readable code so the Stop hook can write an
    // honest `skipped: "quota_cap"` / `skipped: "agy_prompt_too_large"`
    // telemetry row instead of a generic HARD_SUPPRESS free-text reason.
    // Both codes are set ONLY at pre-spawn abstain sites (brain-guarded.ts's
    // quota-cap check; agy.ts's argv byte-size gate) — a real spawn/classify
    // failure never carries either.
    const skipCode =
      err instanceof BrainError && err.code === "quota_cap"
        ? ("quota_cap" as const)
        : err instanceof BrainError && err.code === "agy_prompt_too_large"
          ? ("agy_prompt_too_large" as const)
          : undefined;
    return { diffSummary, diffSummaryError, memoryFunnel, promptBytes, outcome: { kind: "hard_suppress", reason, skipCode } };
  }

  const critique = brainResult.output;
  const usage = brainResult.usage;
  const servedModel = brainResult.servedModel;

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

  // Step 4: Post-Brain evidence check.
  //
  // This USED to be the end of the road for 56.5% of fired reviews: an empty
  // `evidence` array, or one unverifiable snippet, and the entire review was
  // discarded unseen. It no longer is. The unverifiable CITATIONS are dropped
  // — a fabricated snippet never reaches the reader AS EVIDENCE — and
  // everything else the reviewer said is written and shown, carrying a label
  // that says which parts were checked.
  const changedFilesSet = new Set(changedFiles);
  const verdict = guardCritique(critique, "NORMAL", guardCorpus, changedFilesSet);

  // Only the confirmed items may travel on as evidence. Assigning back onto
  // `critique` (rather than passing a filtered copy alongside) is deliberate:
  // `critique` is what gets persisted, what goes into the `brain_output`
  // telemetry field, and what the dashboard renders — three readers, and a
  // filtered copy that reached only one of them would leave the other two
  // showing citations this function just refused.
  //
  // SCOPE, stated because the first draft of this comment overstated it: the
  // two spans ABOVE (`brain.find`, `response.parse`) already snapshotted and
  // wrote the unfiltered output, so the raw reply — dropped citation included
  // — is in the trace, and the Trace tab can now reach it (it joins on
  // `critique_id`, which a discarded review never had). That is correct for a
  // trace: a trace that showed post-processed data would be hiding the
  // processing. It is NOT correct for the trace to show it without saying it
  // happened, so the verdict goes on the root span below.
  critique.evidence = verdict.verified;

  // Put the verdict where the trace reader is already looking. Counts and the
  // label only — the reasons carry a 60-char snippet preview and belong in the
  // daemon log and the counters, not on a span attribute.
  if (rootSpan && tracer) {
    tracer.setAttribute(rootSpan, "siltpoke.evidence_label", verdict.label);
    tracer.setAttribute(rootSpan, "siltpoke.evidence_cited", verdict.verified.length + verdict.unverified.length);
    tracer.setAttribute(rootSpan, "siltpoke.evidence_dropped", verdict.unverified.length);
  }

  if (verdict.unverified.length > 0) {
    console.error(
      `[siltpoke] runCritic [${source}] NORMAL evidence_unverified (${verdict.unverified.length} dropped, review still shown) — ${verdict.unverified[0]?.reason}`,
    );
    // Fire-and-forget: one row per review, keyed on the first reason.
    if (homeBase !== undefined) {
      void recordEvidenceUnverified(homeBase, verdict.unverified[0]?.reason ?? verdict.label);
    }
  }

  // Write critique.
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
      // The whole verdict, not just its label — `critique.evidence` was
      // reassigned above to the confirmed items only, so this object is the
      // one place the REFUSED citations still exist by the time anything is
      // written. Without it the archive keeps a count of what was dropped and
      // no way to say which one, which is what made defect ⑩'s "check each
      // finding for a real trigger site" impossible to run on history.
      evidence_verdict: verdict,
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
    `[siltpoke] runCritic [${source}] NORMAL accepted — critique written (evidence: ${verdict.label})`,
  );

  return {
    diffSummary,
    diffSummaryError,
    memoryFunnel,
    promptBytes,
    outcome: {
      kind: "ok",
      critique,
      usage,
      critiqueId,
      servedModel,
      evidenceLabel: verdict.label,
      diffCoverage,
      unverifiedCount: verdict.unverified.length,
    },
  };
}

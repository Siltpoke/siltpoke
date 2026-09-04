// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// Public types for the shared runCritic() callsite.

import type { BrainCallResult, BrainUsage, CallBrainOptions } from "../brain/brain";
import type { DiffCoverage } from "../brain/hunk-selection";
import type { MemoryFunnel, PromptSectionBytes } from "../brain/prompt-assembly";
import type { BrainProviderMeta } from "../brain/provider";
import type { BrainOutput } from "../brain/schema";
import type { CoreMemory } from "../memory/memory";
import type { RecentEntry } from "../memory/recent";
import type { TraceStore } from "../observability/storage";
import type { Tracer } from "../observability/tracer";
import type { GitBaseline } from "../router/git-snapshot";
import type { CritiqueInput } from "../state/critique";
import type { CallerImpactDeps } from "./caller-impact/inject";
import type { ProjectCapabilities } from "./capabilities";
import type { ImportersDeps } from "./disk-awareness/importers";
import type { EvidenceLabel } from "./evidence-guard";
import type { CapturedIntent, TranscriptTurn } from "./intent/capture";
import type { RubricTrigger } from "./rubric/types";
import type { DiffSummary, runDiffSummary } from "./tools/run-diff-summary";
import type { runTools } from "./tools/run-tools";

export type CriticSource = "stop-hook" | "review-cli";

/**
 * The context assembled upstream and passed into runCritic.
 * Mirrors the non-tool fields of AssemblyInput in prompt-assembly.ts.
 */
export type BrainContext = {
  personalitySystemPrompt: string;
  memory: CoreMemory | null;
  recent: RecentEntry[];
  fileTypes?: Set<string>;
  maxRules?: number;
  recentInjectionCount?: number;
  /** Used by writeCritique for attribution. */
  sessionId: string;
  /** Used by writeCritique for attribution. */
  cwd: string;
  /** Base path under which critiques are stored (e.g. {cwd}/.siltpoke). */
  stateBase: string;
  /**
   * Optional intent classification for the current session turn.
   * When present, passed to buildPassiveBubblePrompt so the verb
   * ("refactor" vs "change") is contextually accurate.
   */
  intent?: { classification: string; confidence: number };
  /**
   * Rubric triggers collected during the pre-Brain pass.
   * Populated by runCritic when criticPipeline.enabled=true.
   */
  rubricTriggers?: RubricTrigger[];
  /**
   * Intent classification result from the pre-Brain pass.
   * Populated by runCritic when criticPipeline.enabled=true.
   */
  intentResult?: { classification: string; confidence: number; signal_source: string };
  /**
   * Captured user query + agent restatement from the transcript.
   * Populated by runCritic after captureIntent runs.
   */
  capturedIntent?: CapturedIntent;
  /**
   * Optional anti-examples block (few-shot retrieval over past dismissed
   * critiques) — computed once in `buildPromptContext` (src/hooks/handle-stop.ts)
   * and threaded through here so BOTH tool-augmented phases
   * (`runNormalPhase` and `runPassiveBubblePhase`) receive it on their own
   * `assembleSystemPromptWithFunnel` call. Defaults to "" (no fence) when
   * absent so nothing else breaks. See Task B critical #1 fix.
   */
  antiExamplesBlock?: string;
};

export type RunCriticOpts = {
  source: CriticSource;
  cwd: string;
  changedFiles: string[];
  caps: ProjectCapabilities;
  /** null = non-git session; undefined = caller didn't capture yet. */
  gitBaseline?: GitBaseline | null;
  /**
   * The unit of work under review, as `<lastReviewedHead>..HEAD` (spec D2).
   * Set by the Stop hook's review-unit gate, which is the thing that decided
   * there was a unit at all — so the boundary is named by the caller rather
   * than guessed by the diff tool.
   *
   * Absent means "no unit named": git-diff falls back to the working tree and,
   * if that is empty, to the recent-commits blob. That is still the path a
   * forced review on a clean tree takes.
   */
  revisionRange?: string;
  brainContext: BrainContext;
  /**
   * Base path for siltpoke home directory (e.g. ~/.siltpoke).
   * When provided, telemetry is recorded to {homeBase}/telemetry/.
   * When omitted, telemetry is silently skipped.
   */
  homeBase?: string;
  /**
   * Optional OTEL tracer. When provided together with traceStore,
   * spans are emitted for each phase of the critic pipeline.
   */
  tracer?: Tracer;
  /**
   * Optional OTEL trace store. Must be provided together with tracer.
   */
  traceStore?: TraceStore;
  /**
   * Commit message for the current session turn (used by intent classifier).
   */
  commitMsg?: string | null;
  /**
   * Transcript turns for user_raw_query + agent_restatement capture.
   * When provided, captureIntent() runs and the result is stored in V2ResultFields.
   * Omit to skip intent capture (e.g. in tests that don't exercise the transcript path).
   */
  transcriptTurns?: TranscriptTurn[];
};

export interface TimingTrace {
  /** Haiku diff-summary call duration (ms). 0 when no diff body. */
  summary_ms: number;
  /** Main Brain critic call duration (ms). 0 when HARD_SUPPRESS short-circuits before Brain. */
  critic_ms: number;
  /** True wall time inside runCritic (ms) — covers tools + summary + critic. */
  wall_ms: number;
}

/** V2 evidence fields appended to each result branch. */
export type V2ResultFields = {
  /** Rubric triggers SURFACED during pre-Brain pass (post cross-Stop dedup).
   *  Empty when pipeline disabled. */
  rubricTriggers?: RubricTrigger[];
  /** Count of deterministic rubric flags that fired but were cross-Stop
   *  suppressed (already surfaced within the dedup TTL). Keeps the archive
   *  honest: a suppressed Stop has rubric_trigger_count 0 yet a non-zero
   *  suppressed count, so it stays distinguishable from a genuinely clean Stop. */
  rubricSuppressedCount?: number;
  /** Intent classification result. Undefined when pipeline disabled. */
  intentResult?: { classification: string; confidence: number; signal_source: string };
  /** True if criticPipeline ran; false if legacy path taken. */
  pipelineRan?: boolean;
  /**
   * Captured user query + agent restatement from the transcript.
   * Present when pipelineRan=true and transcript turns were provided.
   */
  capturedIntent?: CapturedIntent;
};

/**
 * Provider truth carried on every branch (track #7 T3, AC7/AC14) — resolved
 * once at the top of runCritic (independent of tool classification), so it
 * is known even on HARD_SUPPRESS. `servedModel` is only ever set on branches
 * where a Brain call actually returned (PASSIVE_BUBBLE / NORMAL).
 */
export type ProviderResultFields = {
  providerMeta?: BrainProviderMeta;
  servedModel?: string;
};

/**
 * Read-half memory funnel (eval design §2.1), carried so the Stop hook can put
 * it on the telemetry row. Absent — not zero — on any branch that never reached
 * prompt assembly, because "we never measured" and "we measured zero" are
 * exactly the two things this funnel exists to tell apart.
 */
export type MemoryFunnelFields = {
  memoryFunnel?: MemoryFunnel;
  /** Per-section prompt byte counts from the same assembly. Absent exactly
   *  where `memoryFunnel` is absent — before assembly ran — for the same
   *  reason: "never measured" and "measured zero" must stay distinguishable. */
  promptBytes?: PromptSectionBytes;
};

export type RunCriticResult =
  | ({ decision: "HARD_SUPPRESS"; reason: string; diffSnapshotId?: string; diffSummary?: DiffSummary; summaryError?: string; timing?: TimingTrace; /** Set when the suppression was caused by the quota-billed-provider daily call cap, or (track #7 T4) by the agy provider's pre-spawn argv-too-large abstain — lets the Stop hook write an honest `skipped: "quota_cap"` / `skipped: "agy_prompt_too_large"` telemetry row instead of a generic HARD_SUPPRESS free-text reason. */ skipCode?: "quota_cap" | "agy_prompt_too_large" } & V2ResultFields & ProviderResultFields & MemoryFunnelFields)
  /**
   * PASSIVE_BUBBLE. `evidenceLabel` is the literal `"not_checked"`, never a
   * wider `EvidenceLabel`: this phase does not call `guardCritique` at all —
   * the guard's own PASSIVE_BUBBLE branch is reachable only from tests — so
   * any other value would be a claim nothing made. It is carried rather than
   * omitted because this is 79% of triggers, and a missing field left every
   * one of those telemetry rows indistinguishable from a row written before
   * the field existed.
   */
  | ({ decision: "PASSIVE_BUBBLE"; critique: BrainOutput; usage: BrainUsage; critiqueId?: string; evidenceLabel: "not_checked"; diffSnapshotId?: string; diffSummary?: DiffSummary; summaryError?: string; timing?: TimingTrace } & V2ResultFields & ProviderResultFields & MemoryFunnelFields)
  /**
   * NORMAL. There is no `accepted: false` counterpart any more: the evidence
   * check labels citations instead of discarding reviews, so every NORMAL run
   * that reached the Brain comes out here. `evidenceLabel` carries what the
   * old rejection used to carry — including `"none_verified"`, the case that
   * used to be thrown away outright.
   */
  | ({ decision: "NORMAL"; accepted: true; critique: BrainOutput; usage: BrainUsage; critiqueId?: string; evidenceLabel: EvidenceLabel; diffCoverage: DiffCoverage | null; unverifiedCount: number; diffSnapshotId?: string; diffSummary?: DiffSummary; summaryError?: string; timing?: TimingTrace } & V2ResultFields & ProviderResultFields & MemoryFunnelFields);

/**
 * Optional dependency-injection seam for unit testing.
 * When omitted, the real implementations are used.
 */
export type RunCriticDeps = {
  runToolsFn?: typeof runTools;
  callBrainFn?: (opts: CallBrainOptions) => Promise<BrainCallResult>;
  writeCritiqueFn?: (basePath: string, input: CritiqueInput) => Promise<{ id: string; path: string }>;
  /** Diff summarizer (Haiku pre-pass). Stubbed in tests. */
  runDiffSummaryFn?: typeof runDiffSummary;
  /** Caller-impact seams (resolver + image reader). Stubbed in tests. */
  callerImpact?: CallerImpactDeps;
  /**
   * Reverse-deps seams (ripgrep + resolver + listFiles) — critic
   * disk-awareness slice ①. Stubbed in tests.
   */
  reverseDeps?: ImportersDeps;
  /**
   * Test seam (track #7 T3) — when `callBrainFn` is injected, real provider
   * resolution (loadReviewerProvider) is bypassed, so tests that want to
   * exercise codex-shaped ledger/span fields inject this directly instead
   * of writing a real `~/.siltpoke/config.json`. Production callers never
   * set this; runCritic resolves the real provider's meta.
   */
  providerMeta?: BrainProviderMeta;
};

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// Public types for the shared runCritic() callsite.

import type { BrainCallResult, BrainUsage, CallBrainOptions } from "../brain/brain";
import type { BrainOutput } from "../brain/schema";
import type { CoreMemory } from "../memory/memory";
import type { RecentEntry } from "../memory/recent";
import type { TraceStore } from "../observability/storage";
import type { Tracer } from "../observability/tracer";
import type { GitBaseline } from "../router/git-snapshot";
import type { CritiqueInput } from "../state/critique";
import type { CallerImpactDeps } from "./caller-impact/inject";
import type { ProjectCapabilities } from "./capabilities";
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
};

export type RunCriticOpts = {
  source: CriticSource;
  cwd: string;
  changedFiles: string[];
  caps: ProjectCapabilities;
  /** null = non-git session; undefined = caller didn't capture yet. */
  gitBaseline?: GitBaseline | null;
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

export type RunCriticResult =
  | ({ decision: "HARD_SUPPRESS"; reason: string; diffSnapshotId?: string; diffSummary?: DiffSummary; summaryError?: string; timing?: TimingTrace } & V2ResultFields)
  | ({ decision: "PASSIVE_BUBBLE"; critique: BrainOutput; usage: BrainUsage; critiqueId?: string; diffSnapshotId?: string; diffSummary?: DiffSummary; summaryError?: string; timing?: TimingTrace } & V2ResultFields)
  | ({ decision: "NORMAL"; accepted: true; critique: BrainOutput; usage: BrainUsage; critiqueId?: string; diffSnapshotId?: string; diffSummary?: DiffSummary; summaryError?: string; timing?: TimingTrace } & V2ResultFields)
  | ({ decision: "NORMAL"; accepted: false; reason: string; critique: BrainOutput; usage: BrainUsage; diffSnapshotId?: string; diffSummary?: DiffSummary; summaryError?: string; timing?: TimingTrace } & V2ResultFields);

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
};

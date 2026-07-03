// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * The real RunArm: drive the critic Brain once per (example, arm) with the
 * arm's caller-impact block, and map what it surfaced to EvalFinding[].
 *
 * The ONLY variable across arms is the caller-impact block injected into the
 * prompt — that is exactly the eval's question ("does the block change what the
 * critic CATCHES?"). The signature break is given by construction (the frozen
 * example is built as one), so this path resolves callers directly rather than
 * replaying the live critic's image/sig-delta derivation (that is already
 * covered by the caller-resolver's own tests). Arms:
 *   - baseline            : no block
 *   - grep-sigdelta       : grep resolver on example.changedFunction
 *   - graph-sigdelta      : graph resolver on example.changedFunction
 *   - coherent-irrelevant : grep resolver on example.wrongTarget at EQUAL token
 *                           budget (real caller context, wrong target)
 *
 * Paid: each call here is a real Brain call. Tests inject a fake callBrainFn.
 */
import type { BrainCallResult, CallBrainOptions } from "../../brain/brain";
import type { BrainOutput } from "../../brain/schema";
import { assembleSystemPrompt } from "../../brain/prompt-assembly";
import { assembleCallerBlock } from "../../critic/caller-impact/block-assembler";
import type { CallerResolver } from "../../critic/caller-impact/caller-resolver";
import { CostCeilingExceeded } from "./cost-gate";
import type { EvalExample } from "./manifest";
import type { EvalFinding } from "./oracle";
import type { Arm, RunArm } from "./runner";

export interface RealArmDeps {
  /** grep caller resolver (grep-sigdelta + coherent-irrelevant arms). */
  grep: CallerResolver;
  /** graph caller resolver (graph-sigdelta arm). */
  graph: CallerResolver;
  /** Real Brain call (Haiku, the arm-under-test tier). Tests inject a fake. */
  callBrainFn: (opts: CallBrainOptions) => Promise<BrainCallResult>;
  /** Base personality system prompt (the critic's persona + output contract). */
  systemPromptBase: string;
  /** Token budget the coherent-irrelevant block is capped to (equal-budget control). */
  controlTokenBudget?: number;
}

/** A minimal git-diff tool-output section carrying the example diff for the Brain. */
function gitDiffSection(diff: string): string {
  return ["## Tool output", "", "### git diff", "", "```diff", diff.trim(), "```"].join("\n");
}

/**
 * Build the arm's caller-impact section. Empty for baseline; a real resolved
 * block for the resolver arms; a wrong-target block at equal budget for the
 * coherence-without-relevance control.
 */
async function buildArmSection(
  example: EvalExample,
  arm: Arm,
  deps: RealArmDeps,
): Promise<string> {
  if (arm === "baseline") return "";

  const target =
    arm === "coherent-irrelevant" ? example.wrongTarget : example.changedFunction;
  if (!target) return ""; // missing target (e.g. control example) → no block

  const resolver = arm === "graph-sigdelta" ? deps.graph : deps.grep;
  const callers = await resolver.resolveCallers(target, {
    cwd: example.repo,
    excludeFiles: example.diff ? changedFilesOf(example.diff) : [],
  });

  const block = assembleCallerBlock({
    functionName: target,
    kind: "modified",
    signatureChanged: true, // given by construction (frozen example IS a sig break)
    callers,
    ...(arm === "coherent-irrelevant" && deps.controlTokenBudget !== undefined
      ? { tokenBudget: deps.controlTokenBudget }
      : {}),
  });
  return block?.text ?? "";
}

/** Cheap changed-files extraction from a unified diff (`+++ b/<path>` lines). */
function changedFilesOf(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m?.[1]) files.push(m[1]);
  }
  return files;
}

const FILE_LINE_RE = /([\w./-]+\.[A-Za-z]\w*):(\d+)/g;

/**
 * Map a Brain critique to EvalFinding[]. Primary source is the structured
 * `evidence` array (file + line); also scan `critique_for_claude` prose for
 * `path:line` citations the model wrote but didn't add to evidence.
 */
export function findingsFromOutput(out: BrainOutput): EvalFinding[] {
  const raw: EvalFinding[] = [];
  for (const e of out.evidence) {
    raw.push(e.line !== undefined ? { file: e.file, line: e.line } : { file: e.file });
  }
  for (const m of out.critique_for_claude.matchAll(FILE_LINE_RE)) {
    raw.push({ file: m[1]!, line: Number(m[2]) });
  }
  // Dedup by file:line — the structured evidence and the prose commonly cite the
  // same site; duplicates would drive redundant (paid) grader calls downstream.
  const seen = new Set<string>();
  const findings: EvalFinding[] = [];
  for (const f of raw) {
    const key = `${f.file}:${f.line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(f);
  }
  return findings;
}

/** Per-arm Brain-failure counter (transient infra flakes). Logged honestly so a
 * systematic bias toward one arm is visible, not buried as a silent miss. */
export const armBrainFailures: Record<string, number> = {};

/** Build the injected RunArm seam from real (or faked) dependencies.
 *
 * Resilience: a transient Brain failure (timeout / SIGTERM under machine
 * pressure) on ONE cell must NOT abort the whole paid run. Such a cell is
 * recorded as "no findings" (a miss) and counted in `armBrainFailures` so the
 * verdict can flag if failures concentrate in one arm (which would bias it).
 */
export function makeRealRunArm(deps: RealArmDeps): RunArm {
  return async (example: EvalExample, arm: Arm): Promise<EvalFinding[]> => {
    // buildArmSection is INSIDE the try: a resolver crash (the graph arm has more
    // failure modes than grep) must score this cell as no-findings, not abort the
    // whole run — otherwise one graph-resolver panic kills every remaining cell.
    try {
      const callerSection = await buildArmSection(example, arm, deps);
      const systemPrompt = assembleSystemPrompt({
        personalitySystemPrompt: deps.systemPromptBase,
        memory: null,
        recent: [],
        toolOutputSection: example.diff ? gitDiffSection(example.diff) : "",
        callerImpactSection: callerSection,
      });
      const result = await deps.callBrainFn({
        systemPrompt,
        contextBundle: "Produce one Siltpoke JSON per the system prompt.",
      });
      return findingsFromOutput(result.output);
    } catch (err) {
      // A cost-ceiling breach is NOT a transient cell failure — swallowing it as
      // "no-findings" would silently corrupt every not-yet-run arm into a false
      // miss. Re-throw so the whole run aborts cleanly (verdict marked invalid).
      if (err instanceof CostCeilingExceeded) throw err;
      armBrainFailures[arm] = (armBrainFailures[arm] ?? 0) + 1;
      process.stderr.write(`[eval] brain failure (${arm}, ${example.id}) → scored as no-findings: ${err instanceof Error ? err.message : String(err)}\n`);
      return [];
    }
  };
}

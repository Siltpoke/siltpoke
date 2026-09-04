// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { siltpokeRoot } from "../../installer/paths";
import { type BrainCallResult, type CallBrainOptions, callBrain, callBrainRaw } from "../../brain/brain";
import { buildSystemPrompt, loadPersonality } from "../../brain/personality";
import type { ReviewerBrainProvider } from "../../brain/provider";
import { makeCodexProvider } from "../../brain/providers/codex";
import { GrepCallerResolver } from "../../critic/caller-impact/caller-resolver";
import { GraphCallerResolver } from "../../critic/caller-impact/caller-resolver-graph";
import { graphThenGrep } from "../../critic/caller-impact/inject";
import { buildAllExamples } from "./build-frozen-set";
import {
  CallCountTracker,
  checkCallGate,
  checkGate,
  projectSpend,
  SpendTracker,
} from "./cost-gate";
import { makeSemanticGrader } from "./grader";
import { type EvalManifest, freezeGuard } from "./manifest";
import { makeRealRunArm } from "./real-arm";
import { ARMS, runArmsOverSet } from "./runner";
import { type VerdictProvenance, writeVerdictMd } from "./verdict-writer";

/** Reviewer backend the eval's arm calls run against (track #7 T5, AC12).
 * "claude" is the pre-existing, unchanged default (byte-identical to before
 * this flag existed); "codex" swaps ONLY the arm-under-test calls — the
 * blind grader always stays on claude regardless (cross-family grading is
 * the point, spec §7). */
export type EvalProvider = "claude" | "codex";

/**
 * The dry-run plan summary. No paid work happens to produce this — it is pure
 * arithmetic over the manifest shape.
 */
export interface DryRunPlan {
  exampleCount: number;
  controlCount: number;
  plantedCount: number;
  armCount: number;
  repeats: number;
  /** examples × arms × repeats. */
  estimatedArmCalls: number;
  /** worst-case grader calls = arm calls (one per finding, ≥0 — upper bound). */
  estimatedGraderCallsUpperBound: number;
  provider: EvalProvider;
  lines: string[];
}

/**
 * Build (do not print) the dry-run plan. Counts the paid calls the gated
 * `--execute` path WOULD make, so the cost is visible before authorization.
 */
export function buildDryRunPlan(
  manifest: EvalManifest,
  repeats = 1,
  withGrader = false,
  provider: EvalProvider = "claude",
): DryRunPlan {
  const exampleCount = manifest.examples.length;
  const controlCount = manifest.examples.filter((e) => e.isControl).length;
  const plantedCount = exampleCount - controlCount;
  const armCount = ARMS.length;
  const estimatedArmCalls = exampleCount * armCount * repeats;
  const graderUpperBound = withGrader ? estimatedArmCalls : 0;

  const lines = [
    "=== caller-impact eval — DRY RUN (no paid execution) ===",
    `examples:        ${exampleCount} (${plantedCount} planted, ${controlCount} controls)`,
    `arms:            ${armCount} [${ARMS.join(", ")}]`,
    `repeats/arm:     ${repeats}`,
    `provider:        ${provider}${provider === "codex" ? " (quota-billed, eval-gated)" : ""}`,
    `blind grader:    ${withGrader ? "ON (Sonnet, secondary annotation — always claude regardless of provider)" : "OFF (deterministic oracle only — primary verdict)"}`,
    `estimated paid critic calls: ${estimatedArmCalls}  (examples × arms × repeats)`,
    `estimated grader calls (upper bound): ${graderUpperBound}  (≤ 1 per surfaced finding)`,
  ];

  return {
    exampleCount,
    controlCount,
    plantedCount,
    armCount,
    repeats,
    estimatedArmCalls,
    estimatedGraderCallsUpperBound: graderUpperBound,
    provider,
    lines,
  };
}

interface ParsedArgs {
  execute: boolean;
  maxUsd?: number;
  maxCalls?: number;
  repeats: number;
  manifestPath: string;
  verdictPath: string;
  /** Opt-in blind Sonnet grader (secondary annotation; the cost driver). */
  grader: boolean;
  provider: EvalProvider;
}

const DEFAULT_MANIFEST = join(import.meta.dir, "frozen-manifest.json");
const DEFAULT_VERDICT = join(import.meta.dir, "verdict.md");
/** Eval Brain calls run on a loaded dev box; a single transient timeout/SIGTERM
 * must not poison a cell. Retry once with a longer timeout before giving up. */
const EVAL_TIMEOUT_MS = 180_000;

/** Sibling path next to a verdict.md where its provider provenance JSON
 * lives (track #7 T5, AC12) — `src/cli/doctor-reviewer-check.ts`'s
 * `defaultEvalProvenancePath` reads the same default location. */
export function verdictProvenancePathFor(verdictPath: string): string {
  const base = basename(verdictPath).replace(/\.md$/, "");
  return join(dirname(verdictPath), `${base}.provenance.json`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const maxUsdRaw = get("--max-usd");
  const maxCallsRaw = get("--max-calls");
  const repeatsRaw = get("--repeats");
  const providerRaw = get("--provider");
  return {
    execute: argv.includes("--execute"),
    maxUsd: maxUsdRaw !== undefined ? Number(maxUsdRaw) : undefined,
    maxCalls: maxCallsRaw !== undefined ? Number(maxCallsRaw) : undefined,
    repeats: repeatsRaw !== undefined ? Math.max(1, Number(repeatsRaw)) : 1,
    manifestPath: get("--manifest") ?? DEFAULT_MANIFEST,
    verdictPath: get("--verdict") ?? DEFAULT_VERDICT,
    grader: argv.includes("--grader"),
    provider: providerRaw === "codex" ? "codex" : "claude",
  };
}

/**
 * Default `--max-calls` ceiling when omitted (T5 review fix): the true
 * no-op-equivalent ceiling that lets a plain `--execute --provider codex`
 * run pass `checkCallGate` at its documented default. The gate compares
 * against `estimatedArmCalls = examples × arms × repeats`
 * (`buildDryRunPlan`) — a default of `examples.length` ALONE (the old
 * behavior) was always < that product (arms=4, repeats≥1), so every
 * unadorned default run refused before any paid call.
 */
function defaultMaxCalls(exampleCount: number, repeats: number): number {
  return exampleCount * ARMS.length * repeats;
}

function loadManifest(path: string): EvalManifest | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as EvalManifest;
}

/** One retry with the same timeout, no backoff — a loaded dev box's transient
 * SIGTERM/timeout must not poison a cell. A second failure propagates. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

export interface ArmBrainHandle {
  call: (opts: CallBrainOptions) => Promise<BrainCallResult>;
  /** Last-seen servedModel across all calls made through this handle
   * (track #7 T5, AC12) — undefined for claude (no ambiguity to record) or
   * before any codex call has completed. */
  getServedModel: () => string | undefined;
}

/**
 * Build the arm-under-test Brain-call handle for a given provider — the
 * SAME `callBrainFn` seam `makeRealRunArm` already expects (real-arm.ts),
 * swapped per provider (spec §7). Exported so tests can exercise the codex
 * branch directly with a fake `ReviewerBrainProvider`, without going through
 * the gated `--execute` CLI path (which requires a real, INV2-passing
 * frozen manifest).
 *
 * claude branch: byte-identical to the pre-T5 inline closure — `callBrain`
 * + `spendTracker.add(usage.total_cost_usd)`.
 * codex branch: `codexProvider.call` + `callTracker.add()` (a COUNT, not a
 * dollar amount — AC12) + capture the LAST servedModel seen.
 */
export function makeArmBrainForProvider(opts: {
  provider: EvalProvider;
  timeoutMs: number;
  spendTracker?: SpendTracker;
  callTracker?: CallCountTracker;
  codexProvider?: ReviewerBrainProvider;
  claudeCallFn?: (o: CallBrainOptions) => Promise<BrainCallResult>;
}): ArmBrainHandle {
  let lastServedModel: string | undefined;
  if (opts.provider === "codex") {
    const provider = opts.codexProvider ?? makeCodexProvider();
    return {
      call: async (callOpts: CallBrainOptions): Promise<BrainCallResult> => {
        const r = await withRetry(() => provider.call({ timeoutMs: opts.timeoutMs, ...callOpts }));
        lastServedModel = r.servedModel ?? lastServedModel;
        opts.callTracker?.add();
        return r;
      },
      getServedModel: () => lastServedModel,
    };
  }
  const claudeCall = opts.claudeCallFn ?? callBrain;
  return {
    call: async (callOpts: CallBrainOptions): Promise<BrainCallResult> => {
      const r = await withRetry(() => claudeCall({ timeoutMs: opts.timeoutMs, ...callOpts }));
      opts.spendTracker?.add(r.usage.total_cost_usd);
      return r;
    },
    getServedModel: () => undefined,
  };
}

/**
 * Entry point.
 *   (no flags)  → print the dry-run plan + cost projection, return 0.
 *   --execute   → gate on the projection (USD ceiling for claude via
 *                 --max-usd; call-count ceiling for codex via --max-calls,
 *                 default = examples × arms × repeats, see defaultMaxCalls),
 *                 then run all arms with a hard tracker; write verdict.md
 *                 (+ verdict.provenance.json for codex runs); print the
 *                 body. The gate is un-bypassable: no ceiling / over-budget /
 *                 missing frozen set all refuse before any paid call.
 */
export async function main(argv: string[] = []): Promise<number> {
  const args = parseArgs(argv);
  const out = (s: string) => process.stdout.write(`${s}\n`);

  const manifest = loadManifest(args.manifestPath);
  if (!manifest || manifest.examples.length === 0) {
    out(`frozen set not populated at ${args.manifestPath} — run the frozen-set builder first.`);
    if (!args.execute) {
      out(buildDryRunPlan({ version: "0-unpopulated", examples: [], contentHash: "" }, 1, false, args.provider).lines.join("\n"));
      return 0;
    }
    return 1;
  }

  const plan = buildDryRunPlan(manifest, args.repeats, args.grader, args.provider);
  const projection = projectSpend(plan);

  if (!args.execute) {
    const gateLines =
      args.provider === "codex"
        ? [
            `quota-billed — no USD projection; --max-calls caps the call COUNT (default = examples × arms × repeats = ${manifest.examples.length} × ${plan.armCount} × ${args.repeats} = ${defaultMaxCalls(manifest.examples.length, args.repeats)})`,
          ]
        : projection.lines;
    out([...plan.lines, "", ...gateLines, "", "NOT RUN — re-invoke with --execute (+ --max-usd/--max-calls) to authorize."].join("\n"));
    return 0;
  }

  // --- gated paid path ---
  let maxCalls: number | undefined;
  let gateOkReason: string;
  if (args.provider === "codex") {
    maxCalls = args.maxCalls ?? defaultMaxCalls(manifest.examples.length, args.repeats); // default = examples × arms × repeats (T5 review fix — see defaultMaxCalls doc)
    const callGate = checkCallGate(plan.estimatedArmCalls, maxCalls);
    if (!callGate.ok) {
      out(`REFUSED: ${callGate.reason}`);
      return 1;
    }
    if (args.grader && args.maxUsd === undefined) {
      // The grader is ALWAYS claude (real USD), independent of the arm
      // provider — a codex run with --grader still needs a $ ceiling for it.
      out("REFUSED: --grader is claude-billed even under --provider codex — pass --max-usd to cap grader spend.");
      return 1;
    }
    gateOkReason = callGate.reason;
  } else {
    const gate = checkGate(projection, args.maxUsd);
    if (!gate.ok) {
      out(`REFUSED: ${gate.reason}`);
      return 1;
    }
    gateOkReason = gate.reason;
  }

  // INV2 (non-vacuous): re-derive the manifest's examples from live repo source
  // and refuse if they drifted from the frozen hash. The runner's own guard
  // compares the manifest to itself (catches only tampering); THIS compares to a
  // fresh build, so a changed source file invalidates the run before any spend.
  try {
    const ids = new Set(manifest.examples.map((e) => e.id));
    const live = buildAllExamples().filter((e) => ids.has(e.id));
    const drift = freezeGuard(manifest, live);
    if (!drift.ok) {
      out(`REFUSED (INV2 frozen-set drift — source changed since freeze): ${drift.reason}`);
      return 1;
    }
  } catch (err) {
    out(`REFUSED (INV2 could not re-derive live examples — repo moved/deleted?): ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  out(
    args.provider === "codex"
      ? `call gate OK: ${gateOkReason}. Executing ${plan.estimatedArmCalls} arm calls...`
      : `cost gate OK: ${gateOkReason}. Executing ${plan.estimatedArmCalls} arm calls...`,
  );

  const callTracker = args.provider === "codex" ? new CallCountTracker(maxCalls!) : undefined;
  // For claude, one SpendTracker covers BOTH arm + grader spend (unchanged
  // pre-T5 behavior). For codex, arm spend is call-counted; the grader (if
  // enabled) gets its OWN SpendTracker (refused above when --max-usd absent).
  const spendTracker =
    args.provider === "codex" ? (args.grader ? new SpendTracker(args.maxUsd!) : undefined) : new SpendTracker(args.maxUsd!);

  const personality = await loadPersonality(siltpokeRoot());
  const systemPromptBase = await buildSystemPrompt(personality, undefined, null);

  const armBrainHandle = makeArmBrainForProvider({
    provider: args.provider,
    timeoutMs: EVAL_TIMEOUT_MS,
    spendTracker,
    callTracker,
  });
  const graderCall = async (opts: Parameters<typeof callBrainRaw>[0]) => {
    const r = await withRetry(() => callBrainRaw({ timeoutMs: EVAL_TIMEOUT_MS, ...opts }));
    spendTracker?.add(r.usage.total_cost_usd);
    return r;
  };

  const runArm = makeRealRunArm({
    grep: new GrepCallerResolver(),
    graph: graphThenGrep(new GraphCallerResolver(), new GrepCallerResolver()),
    callBrainFn: armBrainHandle.call,
    systemPromptBase,
  });
  const grader = args.grader ? makeSemanticGrader({ call: graderCall }) : undefined;

  let results: Awaited<ReturnType<typeof runArmsOverSet>>;
  try {
    results = await runArmsOverSet(manifest, runArm, { repeats: args.repeats, ...(grader ? { grader } : {}) });
  } catch (err) {
    const spent =
      callTracker !== undefined
        ? `${callTracker.callsMade} calls made`
        : `$${(spendTracker?.spentUsd ?? 0).toFixed(4)} spent`;
    out(`ABORTED mid-run (${spent}): ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const provenance: VerdictProvenance | undefined =
    args.provider === "codex"
      ? { provider: "codex", servedModel: armBrainHandle.getServedModel() ?? null, ts: new Date().toISOString() }
      : undefined;
  const report = writeVerdictMd(results, undefined, provenance);
  writeFileSync(args.verdictPath, report.body, "utf8");
  if (report.provenance !== undefined) {
    writeFileSync(
      verdictProvenancePathFor(args.verdictPath),
      `${JSON.stringify({ schemaVersion: 1, ...report.provenance }, null, 2)}\n`,
      "utf8",
    );
  }
  out("");
  out(report.body);
  out("");
  const spentSummary =
    callTracker !== undefined
      ? `${callTracker.callsMade} calls made (ceiling ${maxCalls})`
      : `$${(spendTracker?.spentUsd ?? 0).toFixed(4)}`;
  out(`verdict.md written to ${args.verdictPath}. actual spend: ${spentSummary}`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

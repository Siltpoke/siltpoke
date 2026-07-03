// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { callBrain, callBrainRaw } from "../../brain/brain";
import { buildSystemPrompt, loadPersonality } from "../../brain/personality";
import { GrepCallerResolver } from "../../critic/caller-impact/caller-resolver";
import { GraphCallerResolver } from "../../critic/caller-impact/caller-resolver-graph";
import { graphThenGrep } from "../../critic/caller-impact/inject";
import { buildAllExamples } from "./build-frozen-set";
import { checkGate, projectSpend, SpendTracker } from "./cost-gate";
import { makeSemanticGrader } from "./grader";
import { type EvalManifest, freezeGuard } from "./manifest";
import { makeRealRunArm } from "./real-arm";
import { ARMS, runArmsOverSet } from "./runner";
import { writeVerdictMd } from "./verdict-writer";

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
  lines: string[];
}

/**
 * Build (do not print) the dry-run plan. Counts the paid calls the gated
 * `--execute` path WOULD make, so the cost is visible before authorization.
 */
export function buildDryRunPlan(manifest: EvalManifest, repeats = 1, withGrader = false): DryRunPlan {
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
    `blind grader:    ${withGrader ? "ON (Sonnet, secondary annotation)" : "OFF (deterministic oracle only — primary verdict)"}`,
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
    lines,
  };
}

interface ParsedArgs {
  execute: boolean;
  maxUsd?: number;
  repeats: number;
  manifestPath: string;
  verdictPath: string;
  /** Opt-in blind Sonnet grader (secondary annotation; the cost driver). */
  grader: boolean;
}

const DEFAULT_MANIFEST = join(import.meta.dir, "frozen-manifest.json");
const DEFAULT_VERDICT = join(import.meta.dir, "verdict.md");

function parseArgs(argv: string[]): ParsedArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const maxUsdRaw = get("--max-usd");
  const repeatsRaw = get("--repeats");
  return {
    execute: argv.includes("--execute"),
    maxUsd: maxUsdRaw !== undefined ? Number(maxUsdRaw) : undefined,
    repeats: repeatsRaw !== undefined ? Math.max(1, Number(repeatsRaw)) : 1,
    manifestPath: get("--manifest") ?? DEFAULT_MANIFEST,
    verdictPath: get("--verdict") ?? DEFAULT_VERDICT,
    grader: argv.includes("--grader"),
  };
}

function loadManifest(path: string): EvalManifest | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as EvalManifest;
}

/**
 * Entry point.
 *   (no flags)  → print the dry-run plan + cost projection, return 0.
 *   --execute   → require --max-usd; gate on the projection; run all arms with a
 *                 hard SpendTracker; write verdict.md; print the body. The gate
 *                 is un-bypassable: no ceiling / over-budget / missing frozen set
 *                 all refuse before any paid call.
 */
export async function main(argv: string[] = []): Promise<number> {
  const args = parseArgs(argv);
  const out = (s: string) => process.stdout.write(`${s}\n`);

  const manifest = loadManifest(args.manifestPath);
  if (!manifest || manifest.examples.length === 0) {
    out(`frozen set not populated at ${args.manifestPath} — run the frozen-set builder first.`);
    if (!args.execute) {
      out(buildDryRunPlan({ version: "0-unpopulated", examples: [], contentHash: "" }).lines.join("\n"));
      return 0;
    }
    return 1;
  }

  const plan = buildDryRunPlan(manifest, args.repeats, args.grader);
  const projection = projectSpend(plan);

  if (!args.execute) {
    out([...plan.lines, "", ...projection.lines, "", "NOT RUN — re-invoke with --execute --max-usd <n> to authorize."].join("\n"));
    return 0;
  }

  // --- gated paid path ---
  const gate = checkGate(projection, args.maxUsd);
  if (!gate.ok) {
    out(`REFUSED: ${gate.reason}`);
    return 1;
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
  out(`cost gate OK: ${gate.reason}. Executing ${plan.estimatedArmCalls} arm calls...`);

  const tracker = new SpendTracker(args.maxUsd!);
  const personality = await loadPersonality(join(process.env.HOME ?? "", ".siltpoke"));
  const systemPromptBase = await buildSystemPrompt(personality, undefined, null);

  // Eval Brain calls run on a loaded dev box; a single transient timeout/SIGTERM
  // must not poison a cell. Retry once with a longer timeout before giving up.
  const EVAL_TIMEOUT_MS = 180_000;
  async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      return await fn(); // one retry; a second failure propagates to the per-cell catch
    }
  }
  const armBrain = async (opts: Parameters<typeof callBrain>[0]) => {
    const r = await withRetry(() => callBrain({ timeoutMs: EVAL_TIMEOUT_MS, ...opts }));
    tracker.add(r.usage.total_cost_usd);
    return r;
  };
  const graderCall = async (opts: Parameters<typeof callBrainRaw>[0]) => {
    const r = await withRetry(() => callBrainRaw({ timeoutMs: EVAL_TIMEOUT_MS, ...opts }));
    tracker.add(r.usage.total_cost_usd);
    return r;
  };

  const runArm = makeRealRunArm({
    grep: new GrepCallerResolver(),
    graph: graphThenGrep(new GraphCallerResolver(), new GrepCallerResolver()),
    callBrainFn: armBrain,
    systemPromptBase,
  });
  const grader = args.grader ? makeSemanticGrader({ call: graderCall }) : undefined;

  let results: Awaited<ReturnType<typeof runArmsOverSet>>;
  try {
    results = await runArmsOverSet(manifest, runArm, { repeats: args.repeats, ...(grader ? { grader } : {}) });
  } catch (err) {
    out(`ABORTED mid-run (spent $${tracker.spentUsd.toFixed(4)}): ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const report = writeVerdictMd(results);
  writeFileSync(args.verdictPath, report.body, "utf8");
  out("");
  out(report.body);
  out("");
  out(`verdict.md written to ${args.verdictPath}. actual spend: $${tracker.spentUsd.toFixed(4)}`);
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

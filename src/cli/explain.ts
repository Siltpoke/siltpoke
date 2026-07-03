// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * `/siltpoke-explain` CLI.
 *
 * Usage:
 *   bun src/cli/explain.ts <target>             # depth=1, cache OK
 *   bun src/cli/explain.ts <target> --depth 2
 *   bun src/cli/explain.ts <target> --force
 *   bun src/cli/explain.ts <target> --json
 *
 * Target can be:
 *   - bare symbol            (`runDoctor`)
 *   - file path              (`src/cli/doctor.ts`)
 *   - qualified path:symbol  (`src/cli/doctor.ts:runDoctor`)
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { resolveRepoGraphLocation } from "../repo-graph/proj-hash";
import { siltpokeRoot } from "../installer/paths";
import { makeDefaultBrainProvider, makeDefaultSourceProvider } from "../explain/providers";
import {
  runExplain,
  type BrainProvider,
  type ExplainOutcome,
  type SourceProvider,
} from "../explain/explain";

export interface CliOptions {
  target: string | undefined;
  depth: 1 | 2;
  force: boolean;
  json: boolean;
}

export const EXIT_CODE = {
  explained: 0,
  pre_check_failed: 1,
  ambiguous: 1,
  not_found: 2,
  cost_cap_exceeded: 3,
} as const;

export function parseArgs(argv: readonly string[]): CliOptions {
  let target: string | undefined;
  let depth: 1 | 2 = 1;
  let force = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") {
      force = true;
      continue;
    }
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--depth") {
      const next = argv[i + 1];
      if (next === "1" || next === "2") {
        depth = Number.parseInt(next, 10) as 1 | 2;
      }
      i++;
      continue;
    }
    if (!a.startsWith("--") && target === undefined) {
      target = a;
    }
  }
  return { target, depth, force, json };
}

function formatExplained(o: Extract<ExplainOutcome, { kind: "explained" }>): string {
  const meta = o.result.meta;
  const cost = meta.brain_usage.total_cost_usd ?? 0;
  const lines: string[] = [];
  lines.push(o.result.markdown.trimEnd());
  lines.push("");
  if (o.lowConfidence) {
    lines.push(
      `⚠ low confidence — evidence_score ${meta.evidence_score.toFixed(2)} (<0.9). Review citations carefully.`,
    );
  }
  if (o.truncated) {
    lines.push(
      "⚠ subgraph or prompt truncated — explanation may be partial.",
    );
  }
  if (o.softCapExceeded) {
    lines.push(
      `⚠ soft cost cap hit — $${cost.toFixed(4)} > $${o.softCapUsd.toFixed(4)}. Override via SILTPOKE_EXPLAIN_SOFT_CAP_USD if expected.`,
    );
  }
  lines.push(
    `Brain cost: $${cost.toFixed(4)}  ·  evidence ${meta.evidence_score.toFixed(2)}  ·  ${o.result.fromCache ? "cached" : "fresh"}`,
  );
  lines.push(`Cached at ${o.result.mdPath} (meta: ${o.result.metaPath})`);
  return `${lines.join("\n")}\n`;
}

function formatAmbiguous(
  o: Extract<ExplainOutcome, { kind: "ambiguous" }>,
): string {
  const lines: string[] = [];
  lines.push(`⚠ "${o.candidates[0]?.name ?? "target"}" matches ${o.candidates.length} symbols. Pick one:`);
  lines.push("");
  o.candidates.forEach((c, idx) => {
    lines.push(
      `  [${idx + 1}] ${c.name} — ${c.path}:${c.lineRange[0]}  (${c.type})`,
    );
  });
  lines.push("");
  lines.push(
    "Re-run with the qualified form, e.g. `/siltpoke-explain <path>:<symbol>`.",
  );
  return `${lines.join("\n")}\n`;
}

function formatNotFound(
  o: Extract<ExplainOutcome, { kind: "not_found" }>,
): string {
  const lines: string[] = [];
  lines.push(`Target "${o.target}" not found in the repo-graph.`);
  if (o.suggestions.length > 0) {
    lines.push("");
    lines.push("Did you mean:");
    for (const s of o.suggestions) lines.push(`  • ${s}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatPreCheck(
  o: Extract<ExplainOutcome, { kind: "pre_check_failed" }>,
): string {
  return `${o.message}\n`;
}

function formatCostCap(
  o: Extract<ExplainOutcome, { kind: "cost_cap_exceeded" }>,
): string {
  return `⚠ cost cap exceeded ($${o.costUsd.toFixed(3)}). Explanation not written.\nUsage: ${JSON.stringify(o.usage)}\n`;
}

export function formatHuman(outcome: ExplainOutcome): string {
  switch (outcome.kind) {
    case "explained":
      return formatExplained(outcome);
    case "ambiguous":
      return formatAmbiguous(outcome);
    case "not_found":
      return formatNotFound(outcome);
    case "pre_check_failed":
      return formatPreCheck(outcome);
    case "cost_cap_exceeded":
      return formatCostCap(outcome);
  }
}

export function formatJson(outcome: ExplainOutcome): string {
  let envelope: Record<string, unknown>;
  switch (outcome.kind) {
    case "explained":
      envelope = {
        success: true,
        data: {
          kind: "explained",
          target: outcome.result.meta.target,
          target_node_id: outcome.result.meta.target_node_id,
          mdPath: outcome.result.mdPath,
          metaPath: outcome.result.metaPath,
          evidence_score: outcome.result.meta.evidence_score,
          low_confidence: outcome.result.meta.low_confidence,
          truncated: outcome.truncated,
          depth: outcome.result.meta.depth,
          fromCache: outcome.result.fromCache,
          usage: outcome.usage,
        },
        error: null,
      };
      break;
    case "ambiguous":
      envelope = {
        success: false,
        data: {
          kind: "ambiguous",
          candidates: outcome.candidates,
        },
        error: "ambiguous target",
      };
      break;
    case "not_found":
      envelope = {
        success: false,
        data: {
          kind: "not_found",
          target: outcome.target,
          suggestions: outcome.suggestions,
        },
        error: "target not found",
      };
      break;
    case "pre_check_failed":
      envelope = {
        success: false,
        data: { kind: "pre_check_failed", message: outcome.message },
        error: "pre-check failed",
      };
      break;
    case "cost_cap_exceeded":
      envelope = {
        success: false,
        data: {
          kind: "cost_cap_exceeded",
          costUsd: outcome.costUsd,
          usage: outcome.usage,
        },
        error: "cost cap exceeded",
      };
      break;
  }
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Real providers (used by CLI entry; tests inject their own).

// makeDefaultSourceProvider + makeDefaultBrainProvider now live in
// src/explain/providers.ts (shared with the daemon explain route, M5).

export async function runCli(argv: readonly string[]): Promise<number> {
  const opts = parseArgs(argv);
  if (!opts.target) {
    process.stderr.write(
      "usage: /siltpoke-explain <target> [--depth 1|2] [--force] [--json]\n",
    );
    return 1;
  }
  const cwd = process.cwd();
  const { project_root, storage_dir } = resolveRepoGraphLocation(cwd);
  const parsePositiveFloat = (raw: string | undefined): number | undefined => {
    if (!raw) return undefined;
    const v = Number.parseFloat(raw);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const outcome = await runExplain(
    { target: opts.target, depth: opts.depth, force: opts.force },
    {
      cwd: project_root,
      graphStorageDir: storage_dir,
      sourceProvider: makeDefaultSourceProvider(project_root),
      brainProvider: makeDefaultBrainProvider(),
      ttyInteractive: Boolean(process.stdin.isTTY),
      costSoftCapUsd: parsePositiveFloat(process.env.SILTPOKE_EXPLAIN_SOFT_CAP_USD),
      costHardCapUsd: parsePositiveFloat(process.env.SILTPOKE_EXPLAIN_HARD_CAP_USD),
      ledgerBasePath: siltpokeRoot(),
    },
  );
  process.stdout.write(opts.json ? formatJson(outcome) : formatHuman(outcome));
  return EXIT_CODE[outcome.kind];
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}

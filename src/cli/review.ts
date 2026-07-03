// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * siltpoke review — standalone-now CLI.
 *
 * Runs tool-augmented critic immediately against git diff HEAD
 * (or --base <ref>). Does NOT write a wake token. Respects budget gate.
 *
 * Exit codes:
 *   0  critique written (NORMAL accepted or PASSIVE_BUBBLE), or empty-diff bail
 *   1  abstention (HARD_SUPPRESS) or budget exhausted
 *   2  guard rejected (NORMAL not-accepted)
 *   3  flag/CLI error (--path not supported, unknown flag)
 */

import { join } from "node:path";
import { loadPersonality, buildSystemPrompt } from "../brain/personality";
import { readMemory } from "../memory/memory";
import { readRecent, resolveRecentPath } from "../memory/recent";
import { getProjectCapabilities } from "../critic/capabilities";
import { runCritic, type RunCriticDeps, type BrainContext } from "../critic/run-critic";
import { loadBudgetConfig, evaluateBudget } from "../state/budget-config";
import { loadDailyRollup } from "../state/usage";
import { runGitDiff } from "../critic/tools/run-git-diff";
import { spawnWithTimeout } from "../critic/spawn";

// ---------------------------------------------------------------------------
// Output helper — use process.stdout.write for easy capture in tests
// ---------------------------------------------------------------------------

export type OutputFn = (msg: string) => void;

const defaultOutput: OutputFn = (msg: string) => {
  process.stdout.write(`${msg}\n`);
};

// ---------------------------------------------------------------------------
// CLI option types
// ---------------------------------------------------------------------------

export type ReviewOpts = {
  /** Override the base ref for git diff. Default: HEAD (working tree). */
  base?: string;
  /** Path glob — not yet supported (exits 3). */
  path?: string;
  /** CWD to operate in. Default: process.cwd(). */
  cwd?: string;
  /** Siltpoke home directory. Default: $HOME/.siltpoke. */
  homeBase?: string;
  /** Dependency injection seam for unit tests. */
  deps?: RunCriticDeps & {
    /** Inject a fake evaluateBudgetFn returning "hard" to test budget gate. */
    evaluateBudgetFn?: typeof evaluateBudget;
  };
  /** Override output function (default: process.stdout.write). */
  output?: OutputFn;
};

export type ReviewResult = {
  exitCode: 0 | 1 | 2 | 3;
};

// ---------------------------------------------------------------------------
// Arg parsing (hand-rolled — no CLI lib)
// ---------------------------------------------------------------------------

type ParsedArgs =
  | { ok: true; base?: string; path?: string }
  | { ok: false; message: string };

export function parseReviewArgs(argv: string[]): ParsedArgs {
  let base: string | undefined;
  let path: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--base") {
      i++;
      if (i >= argv.length || argv[i]?.startsWith("--")) {
        return { ok: false, message: "--base requires a <ref> argument" };
      }
      base = argv[i]!;
    } else if (arg === "--path") {
      i++;
      if (i >= argv.length || argv[i]?.startsWith("--")) {
        return { ok: false, message: "--path requires a <glob> argument" };
      }
      path = argv[i]!;
    } else if (arg.startsWith("--")) {
      return { ok: false, message: `unknown flag: ${arg}` };
    }
    i++;
  }
  return { ok: true, base, path };
}

// ---------------------------------------------------------------------------
// Collect changed files via git diff --name-only (handles renames, binaries, etc.)
// ---------------------------------------------------------------------------

async function getChangedFilesFromGit(cwd: string, revisionRange: string | undefined): Promise<string[]> {
  const argv = ["git", "diff", "--name-only"];
  if (revisionRange !== undefined && revisionRange.trim() !== "") {
    argv.push(revisionRange);
  } else {
    argv.push("HEAD");
  }

  const result = await spawnWithTimeout({ argv, cwd, timeoutMs: 10_000 });
  if (result.timedOut || result.exitCode !== 0 || result.stdout.trim() === "") {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function runReview(opts: ReviewOpts = {}): Promise<ReviewResult> {
  const out = opts.output ?? defaultOutput;
  const cwd = opts.cwd ?? process.cwd();
  const homeBase =
    opts.homeBase ?? join(process.env.HOME ?? "", ".siltpoke");

  // --path: not yet supported
  if (opts.path !== undefined) {
    out("--path: not yet supported");
    return { exitCode: 3 };
  }

  // Determine git diff scope
  const base = opts.base;
  const scopeDescription = base ? `git diff ${base}...HEAD` : "git diff HEAD";

  out(`Siltpoke reviewing ${scopeDescription}...`);
  out("");

  // Budget gate — no bypass here (that's siltpoke wake's job)
  const budgetConfig = await loadBudgetConfig(homeBase);
  const now = new Date();
  const rollup = await loadDailyRollup(homeBase, now, budgetConfig.resetAtMinutes);
  const evaluateBudgetFn = opts.deps?.evaluateBudgetFn ?? evaluateBudget;
  const budget = evaluateBudgetFn(rollup, budgetConfig);
  if (budget.stage === "hard") {
    out("budget exhausted — use `siltpoke wake` to bypass once");
    return { exitCode: 1 };
  }

  // Run git diff to determine changed files and check for empty diff
  const revisionRange = base ? `${base}...HEAD` : undefined;
  const gitDiffResult = await runGitDiff({ cwd, revisionRange });

  // Empty-diff bail
  if (
    gitDiffResult.status === "ok" &&
    gitDiffResult.parsed.length === 0
  ) {
    out("nothing to review — try `--base main`?");
    return { exitCode: 0 };
  }

  // Non-git or git error → also no hunks to review
  if (
    gitDiffResult.status === "not_applicable" ||
    gitDiffResult.status === "not_installed" ||
    gitDiffResult.status === "error"
  ) {
    out("nothing to review — try `--base main`?");
    return { exitCode: 0 };
  }

  const changedFiles = await getChangedFilesFromGit(cwd, revisionRange);

  // Project capabilities
  const caps = await getProjectCapabilities(cwd);

  // Assemble brain context
  const stateBase = join(cwd, ".siltpoke");
  const personality = await loadPersonality(homeBase);
  const memory = await readMemory(homeBase);
  const recentPath = resolveRecentPath(cwd, homeBase);
  const recent = await readRecent(recentPath);
  const personalitySystemPrompt = await buildSystemPrompt(
    personality,
    undefined,
    memory?.personality_drift ?? null,
  );

  const brainContext: BrainContext = {
    personalitySystemPrompt,
    memory,
    recent,
    sessionId: "review-cli",
    cwd,
    stateBase,
  };

  // Run critic (DI seam for tests).
  // Deliberately NO brain-breaker pre-check here: /siltpoke-review is an
  // explicit user request — like /siltpoke-wake, it means "try now" even
  // while a breaker is open (the breaker gate is scoped to Stop-hook
  // ticks). A failure here still records to brain-health as usual.
  const criticDeps: RunCriticDeps = {};
  if (opts.deps?.runToolsFn) criticDeps.runToolsFn = opts.deps.runToolsFn;
  if (opts.deps?.callBrainFn) criticDeps.callBrainFn = opts.deps.callBrainFn;
  if (opts.deps?.writeCritiqueFn) criticDeps.writeCritiqueFn = opts.deps.writeCritiqueFn;

  const result = await runCritic(
    {
      source: "review-cli",
      cwd,
      changedFiles,
      caps,
      gitBaseline: null,
      brainContext,
      homeBase,
    },
    criticDeps,
  );

  // Render terminal output based on decision
  switch (result.decision) {
    case "HARD_SUPPRESS": {
      out("no usable evidence — Siltpoke is silent this run");
      return { exitCode: 1 };
    }

    case "PASSIVE_BUBBLE": {
      const critique = result.critique;
      out(critique.bubble_short);
      return { exitCode: 0 };
    }

    case "NORMAL": {
      if (!result.accepted) {
        out(
          "Siltpoke had concerns but the evidence guard rejected them",
        );
        out(`reason: ${result.reason}`);
        return { exitCode: 2 };
      }

      const critique = result.critique;

      // Print evidence tool summary line
      if (critique.evidence.length > 0) {
        const toolsUsed = [...new Set(critique.evidence.map((e) => e.tool))].join(
          " + ",
        );
        out(`evidence: ${toolsUsed}`);
        out("");
      }

      // bubble_short and bubble_long
      out(critique.bubble_short);
      if (critique.bubble_long) {
        out("");
        out(critique.bubble_long);
      }

      // critique_for_claude (if non-null / non-empty)
      if (critique.critique_for_claude && critique.critique_for_claude.trim().length > 0) {
        out("");
        out("for Claude:");
        out(critique.critique_for_claude);
      }

      // evidence list
      if (critique.evidence.length > 0) {
        out("");
        out("  evidence cited:");
        for (const ev of critique.evidence) {
          const linePart = ev.line !== undefined ? `:${ev.line}` : "";
          out(`    - ${ev.tool} ${ev.file}${linePart} — ${ev.snippet}`);
        }
      }

      out("");
      out(
        `critique saved to ${homeBase}/critiques/archive/ (exit 0)`,
      );

      return { exitCode: 0 };
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  // Strip node/bun binary + script path from argv
  const rawArgs = process.argv.slice(2);
  const parsed = parseReviewArgs(rawArgs);

  if (!parsed.ok) {
    process.stdout.write(`siltpoke review: ${parsed.message}\n`);
    process.exit(3);
  }

  const result = await runReview({ base: parsed.base, path: parsed.path });
  process.exit(result.exitCode);
}

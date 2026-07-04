// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * POST /api/repo-summary — generate (and cache) the 1-2 sentence "what this
 * repo is about" blurb for the active-repos card.
 *
 * One small gated Brain call from the repo's existing arch-model. Idempotent:
 * a repo that already has a cached blurb returns it for $0 without spending.
 * Blocked by the same daily-budget + quiet-hours gate as chat sends.
 */
import type { Hono } from "hono";
import { join } from "node:path";
import { isAuthorized } from "../auth";
import { computeProjHash } from "../../repo-graph/proj-hash";
import { readJsonObject } from "../../repo-graph/repo-card";
import {
  SUMMARY_SYSTEM_PROMPT,
  buildSummaryContext,
  parseSummaryOutput,
  writeRepoSummary,
  repoSummaryPath,
} from "../../repo-graph/repo-summary-gen";
import { callBrainRaw, type BrainUsage } from "../../brain/brain";
import { loadBudgetConfig } from "../../state/budget-config";
import { loadQuietHoursConfig } from "../../state/quiet-hours";
import { loadDailyRollup } from "../../state/usage";
import { evaluateChatSendGate } from "./chat-send-gate";
import { appendUsageEvent } from "../../state/usage";

const SUMMARY_MODEL = "claude-haiku-4-5";

/** Injectable Brain call so the route can be tested without a real `claude -p`. */
export type SummaryBrainCall = (opts: {
  systemPrompt: string;
  contextBundle: string;
  model: string;
}) => Promise<{ output: unknown; usage: BrainUsage }>;

export interface RepoSummaryRouteDeps {
  home: string;
  secret: string;
  /** Defaults to the real `callBrainRaw`. */
  callBrain?: SummaryBrainCall;
  /** Injectable clock for the gate / timestamps. */
  now?: () => Date;
}

export function mountRepoSummaryRoute(app: Hono, deps: RepoSummaryRouteDeps): void {
  const home = deps.home;
  const callBrain: SummaryBrainCall =
    deps.callBrain ?? ((opts) => callBrainRaw(opts));
  const nowFn = deps.now ?? (() => new Date());

  app.post("/api/repo-summary", async (c) => {
    if (!isAuthorized(deps.secret, c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let projectRoot = "";
    try {
      const body = (await c.req.json()) as { project_root?: unknown };
      if (typeof body.project_root === "string") projectRoot = body.project_root;
    } catch {
      projectRoot = "";
    }
    if (projectRoot.length === 0) {
      return c.json({ error: "project_root is required" }, 400);
    }

    const storageDir = join(home, "repo-memory", computeProjHash(projectRoot));

    // Must be indexed with an arch-model — the blurb is derived from it.
    const archModel = readJsonObject(join(storageDir, "arch-model.json"));
    if (!archModel) {
      return c.json({ error: "repo has no architecture model — generate it first" }, 400);
    }

    // Idempotent: return the cached blurb without spending if it already exists.
    const cached = readJsonObject(repoSummaryPath(home, projectRoot));
    if (cached && typeof cached.text === "string" && cached.text.trim().length > 0) {
      return c.json({ summary_text: cached.text, cost_usd: 0, cached: true });
    }

    // Daily-budget + quiet-hours gate (same as chat sends).
    const now = nowFn();
    const budgetConfig = await loadBudgetConfig(home);
    const quietConfig = await loadQuietHoursConfig(home);
    const rollup = await loadDailyRollup(home, now, budgetConfig.resetAtMinutes);
    const gate = evaluateChatSendGate(budgetConfig, rollup, quietConfig, now);
    if (gate) {
      const reason =
        gate.blocked === "quiet_hours"
          ? "quiet hours — try again later"
          : "daily budget reached — try again tomorrow";
      return c.json({ error: reason, blocked: gate.blocked }, 429);
    }

    // Re-check the cache after the gate: a concurrent request (second tab,
    // reload-then-click) may have just generated it in the read-then-spend
    // window. Cheap insurance against a double Brain spend.
    const fresh = readJsonObject(repoSummaryPath(home, projectRoot));
    if (fresh && typeof fresh.text === "string" && fresh.text.trim().length > 0) {
      return c.json({ summary_text: fresh.text, cost_usd: 0, cached: true });
    }

    // One small Brain call.
    let summaryText: string;
    let usage: BrainUsage;
    try {
      const result = await callBrain({
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        contextBundle: buildSummaryContext(archModel),
        model: SUMMARY_MODEL,
      });
      summaryText = parseSummaryOutput(result.output);
      usage = result.usage;
    } catch (err) {
      return c.json(
        { error: `summary generation failed: ${err instanceof Error ? err.message : String(err)}` },
        502,
      );
    }

    const costUsd = usage.total_cost_usd ?? 0;
    writeRepoSummary(home, projectRoot, {
      text: summaryText,
      model: SUMMARY_MODEL,
      generated_ts: now.toISOString(),
      cost_usd: costUsd,
    });

    await appendUsageEvent(home, {
      ts: now.toISOString(),
      kind: "repo_summary",
      session_id: `repo-summary:${computeProjHash(projectRoot)}`,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      total_cost_usd: usage.total_cost_usd,
      basis: "real",
    });

    return c.json({ summary_text: summaryText, cost_usd: costUsd, cached: false });
  });
}

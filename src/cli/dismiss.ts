// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  findCritiqueByIdOrLatest,
  setStatus,
  readStatus,
} from "../state/critique-status";
import { appendPreferenceEntry } from "../preference-log/writer";
import { appendRecent, resolveRecentPath, type RecentEntry } from "../memory/recent";
import {
  appendFeedbackArchive,
  type FeedbackArchiveEntry,
} from "../memory/feedback-archive";
import { appendLearnedRule, type LearnedRule } from "../memory/memory";
import {
  callReflection as defaultCallReflection,
  type CallReflectionOptions,
  type ReflectionCallResult,
} from "../brain/reflection";
import { BrainError, type BrainUsage } from "../brain/brain";
import { appendUsageEvent } from "../state/usage";

export type DismissSkipReason =
  | "no_reason"
  | "low_confidence"
  | "duplicate"
  | "validation_failed"
  | "error";

export interface DismissReflectionSummary {
  ran: boolean;
  rule_appended: boolean;
  skip_reason?: DismissSkipReason;
  rule_id?: string;
  rule_text?: string;
  rule_category?: string;
  confidence?: string;
}

export interface DismissResult {
  critique_id: string;
  status_set: "dismissed" | "already_dismissed" | "not_found";
  recent_appended: boolean;
  archive_appended: boolean;
  reflection: DismissReflectionSummary;
}

export interface DismissOptions {
  critiqueId: string;
  reason: string | null;
  cwd: string;
  // Per-project base for critique lookup. Defaults to {cwd}/.siltpoke/.
  projectBase?: string;
  // Global base for archive + reflection log. Defaults to ~/.siltpoke/.
  homeBase?: string;
  // Override preference-log path (for test isolation). When unset, the writer's
  // global default (~/.siltpoke/preference-log.jsonl) is used.
  preferenceLogPath?: string;
  reflectionFn?: (opts: CallReflectionOptions) => Promise<ReflectionCallResult>;
  now?: () => Date;
}

function siltpokeHome(envHome: string | undefined): string {
  return join(envHome ?? "", ".siltpoke");
}

function projectSiltpoke(cwd: string): string {
  return join(cwd, ".siltpoke");
}

function newRuleId(): string {
  return `lr-${randomBytes(2).toString("hex")}`;
}

async function logReflection(
  homeBase: string,
  payload: unknown,
): Promise<void> {
  try {
    await mkdir(homeBase, { recursive: true });
    await appendFile(
      join(homeBase, "brain-calls.jsonl"),
      `${JSON.stringify(payload)}\n`,
    );
  } catch {
    // never crash the CLI
  }
}

export async function runDismiss(opts: DismissOptions): Promise<DismissResult> {
  const homeBase = opts.homeBase ?? siltpokeHome(process.env.HOME);
  const projectBase = opts.projectBase ?? projectSiltpoke(opts.cwd);
  const reflectionFn = opts.reflectionFn ?? defaultCallReflection;
  const now = opts.now ?? (() => new Date());

  // Critique storage is per-project, so look up under projectBase. The
  // reflection archive + learned-rule append go through the canonical V3 home
  // base (homeBase); V3 does per-project scoping internally via
  // resolveProjectRoot(process.cwd()).
  const critiquePath = await findCritiqueByIdOrLatest(projectBase, opts.critiqueId);
  if (!critiquePath) {
    return {
      critique_id: opts.critiqueId,
      status_set: "not_found",
      recent_appended: false,
      archive_appended: false,
      reflection: { ran: false, rule_appended: false },
    };
  }

  const previous = await readStatus(critiquePath);
  const wasAlreadyDismissed = previous === "dismissed";
  if (!wasAlreadyDismissed) {
    await setStatus(critiquePath, "dismissed");
  }

  const recentEntry: RecentEntry = {
    ts: now().toISOString(),
    critique_id: opts.critiqueId,
    verdict: "dismissed",
    reason: opts.reason,
  };
  await appendRecent(resolveRecentPath(opts.cwd, homeBase), recentEntry);

  const archiveEntry: FeedbackArchiveEntry = {
    ts: recentEntry.ts,
    critique_id: opts.critiqueId,
    verdict: "dismissed",
    reason: opts.reason,
  };

  const result: DismissResult = {
    critique_id: opts.critiqueId,
    status_set: wasAlreadyDismissed ? "already_dismissed" : "dismissed",
    recent_appended: true,
    archive_appended: false,
    reflection: { ran: false, rule_appended: false },
  };

  // Without a reason, there is nothing meaningful for Reflection to learn.
  if (!opts.reason || opts.reason.trim().length === 0) {
    result.reflection.skip_reason = "no_reason";
    await appendFeedbackArchive(homeBase, archiveEntry);
    result.archive_appended = true;
    await logReflection(homeBase, {
      timestamp: now().toISOString(),
      kind: "reflection",
      critique_id: opts.critiqueId,
      ran: false,
      skip_reason: "no_reason",
    });
    appendPreferenceEntry(
      {
        critique_id: opts.critiqueId,
        signal: "dismiss",
        reason_text: null,
        critique_snapshot: {},
        diff_snapshot_sha: null,
        intent_at_critique: null,
        reflexion_rule_fired: null,
      },
      opts.preferenceLogPath ? { path: opts.preferenceLogPath } : undefined,
    ).catch(() => {
      // preference log is non-fatal
    });
    return result;
  }

  let critiqueBody = "";
  try {
    critiqueBody = await readFile(critiquePath, "utf8");
  } catch {
    // best-effort — reflection still useful with just the reason
  }

  let reflectionCall: ReflectionCallResult | undefined;
  let reflectionError: string | undefined;
  try {
    reflectionCall = await reflectionFn({
      critiqueBody,
      userReason: opts.reason,
    });
  } catch (err) {
    reflectionError = err instanceof BrainError ? err.message : String(err);
  }

  let appendOutcome: { appended: boolean; reason?: string; rule_id?: string } = {
    appended: false,
  };
  let usage: BrainUsage | undefined;

  if (reflectionCall) {
    usage = reflectionCall.usage;
    await appendUsageEvent(homeBase, {
      ts: now().toISOString(),
      kind: "reflection",
      session_id: opts.critiqueId,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      total_cost_usd: usage.total_cost_usd,
    });
    const r = reflectionCall.output;
    result.reflection.ran = true;
    result.reflection.confidence = r.confidence;

    if (r.confidence !== "high") {
      result.reflection.skip_reason = "low_confidence";
    } else {
      const rule: LearnedRule = {
        id: newRuleId(),
        rule: r.learned_rule,
        category: r.rule_category,
        created_at: now().toISOString(),
        applied_count: 0,
        effectiveness: "good",
        source: `from dismissing critique ${opts.critiqueId}: ${r.reflection}`,
      };
      // Rules live in the canonical V3 store (homeBase); V3 scopes per-project.
      appendOutcome = await appendLearnedRule(homeBase, rule);
      if (appendOutcome.appended) {
        result.reflection.rule_appended = true;
        result.reflection.rule_id = appendOutcome.rule_id;
        result.reflection.rule_text = r.learned_rule;
        result.reflection.rule_category = r.rule_category;
      } else if (appendOutcome.reason === "duplicate") {
        result.reflection.skip_reason = "duplicate";
        result.reflection.rule_id = appendOutcome.rule_id;
      }
    }
  } else {
    result.reflection.skip_reason = "error";
  }

  archiveEntry.reflection = {
    rule_id: appendOutcome.rule_id ?? null,
    rule_category: result.reflection.rule_category ?? null,
    confidence: result.reflection.confidence ?? null,
    // v1.1-J — true iff THIS dismissal appended a new rule (not a
    // duplicate match). Undismiss reads this to decide whether the
    // rule is safe to remove or shared with other critiques.
    rule_created: appendOutcome.appended === true,
  };
  await appendFeedbackArchive(homeBase, archiveEntry);
  result.archive_appended = true;

  await logReflection(homeBase, {
    timestamp: now().toISOString(),
    kind: "reflection",
    critique_id: opts.critiqueId,
    ran: result.reflection.ran,
    skip_reason: result.reflection.skip_reason,
    rule_id: appendOutcome.rule_id,
    usage,
    error: reflectionError,
  });

  appendPreferenceEntry(
    {
      critique_id: opts.critiqueId,
      signal: "dismiss",
      reason_text: opts.reason,
      critique_snapshot: critiqueBody ? { raw_md: critiqueBody } : {},
      diff_snapshot_sha: null,
      intent_at_critique: null,
      reflexion_rule_fired: result.reflection.rule_id ?? null,
    },
    opts.preferenceLogPath ? { path: opts.preferenceLogPath } : undefined,
  ).catch(() => {
    // preference log is non-fatal
  });

  return result;
}

if (import.meta.main) {
  const critiqueId = process.argv[2];
  const reason = process.argv.slice(3).join(" ") || null;
  if (!critiqueId) {
    process.stdout.write(
      `${JSON.stringify({ error: "usage: dismiss <critique_id> [reason]" })}\n`,
    );
    process.exit(0);
  }
  const result = await runDismiss({
    critiqueId,
    reason,
    cwd: process.cwd(),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

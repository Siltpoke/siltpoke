// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * What the Settings page says happened last (spec 2026-10-13-agent-in-use-truth
 * AC7–AC11): read from records of calls that ran, never from the current
 * setting. Chat from the chat call records; review from brain-calls.jsonl (the
 * newest review that ran — a skipped one is not "the last review"). The
 * summarizer has no per-call record today (spec §4, §7.1 [4]), so there is
 * nothing to read and the page says so.
 */
import type { ChatRunStore } from "../../chat/run-store";
import { readBrainCalls } from "../../state/critic-event-log";

export interface LastCall {
  /** null = no agent was decided for that call (a "choose an agent" reply). */
  family: string | null;
  /** The model the agent reported, else null — never the configured one. */
  model: string | null;
  /** The model the call asked for (chat records keep it), else null. */
  requested: string | null;
  at: string;
  outcome: string;
}

/** How far back to look for a review that ran (rows are newest-first). */
const REVIEW_SCAN = 50;

export async function lastCalls(
  homeBase: string,
  store: ChatRunStore,
): Promise<{ chat: LastCall | null; review: LastCall | null }> {
  const [run, calls] = await Promise.all([
    store.latest().catch(() => null),
    readBrainCalls(homeBase, REVIEW_SCAN).catch(() => ({ calls: [], hasMore: false })),
  ]);
  // A record with no agent is still a call that happened: it is reported as
  // such, never as "nothing recorded".
  const chat: LastCall | null =
    run === null ? null : {
          family: run.family,
          model: run.model_reported,
          requested: run.model_requested,
          at: run.started_at,
          outcome: run.outcome,
        };
  const ran = calls.calls.find((c) => c.status === "fired");
  const review: LastCall | null =
    ran === undefined ? null : { family: ran.provider, model: ran.model ?? null, requested: null, at: ran.timestamp, outcome: "ok" };
  return { chat, review };
}

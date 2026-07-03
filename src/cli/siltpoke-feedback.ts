#!/usr/bin/env bun
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * siltpoke-feedback
 *
 * CLI runner: parses `<critique_id> <text...>` and appends a preference-log
 * entry with signal="feedback". Outputs JSON so the slash-command handler can
 * translate it for the user.
 *
 * Usage: bun src/cli/siltpoke-feedback.ts <critique_id> <text...>
 */
import { appendPreferenceEntry } from "../preference-log/writer";

export interface FeedbackOptions {
  critiqueId: string;
  text: string;
  /** Override default preference-log path (useful for tests). */
  logPath?: string;
}

export interface FeedbackResult {
  ok: boolean;
  critique_id: string;
}

export async function runFeedback(opts: FeedbackOptions): Promise<FeedbackResult> {
  const snapshot: Record<string, unknown> = { critique_id: opts.critiqueId };
  await appendPreferenceEntry(
    {
      critique_id: opts.critiqueId,
      signal: "feedback",
      reason_text: opts.text,
      critique_snapshot: snapshot,
      diff_snapshot_sha: null,
      intent_at_critique: null,
      reflexion_rule_fired: null,
    },
    opts.logPath ? { path: opts.logPath } : {},
  );
  return { ok: true, critique_id: opts.critiqueId };
}

if (import.meta.main) {
  const [, , critiqueId, ...textParts] = process.argv;
  if (!critiqueId || textParts.length === 0) {
    process.stdout.write(
      `${JSON.stringify({ error: "usage: siltpoke-feedback <critique_id> <text>" })}\n`,
    );
    process.exit(1);
  }
  const text = textParts.join(" ");
  const result = await runFeedback({ critiqueId, text });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

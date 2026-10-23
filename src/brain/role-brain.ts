// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Role-routed brain functions (single-brain identity #10, S2).
 *
 * Produces drop-in replacements for callBrainRaw / callBrainText that resolve
 * the given role's provider from <homeBase>/config.json and force that role's
 * resolved model — so a family selected for `extract`/`chat` reaches the
 * consumer without changing its injection seam. Routed through the guarded
 * callRaw so a quota-billed family is capped exactly like the critic. NO
 * persona injection (callRaw passes systemPrompt verbatim; spec §6).
 */

import type { BrainCallRawResult, BrainUsage, CallBrainOptions } from "./brain";
import type { BrainRole } from "./brain-config";
import { loadBrainConfig } from "./brain-config";
import { makeGuardedCallRaw } from "./brain-guarded";
import { parseRawJson } from "./parse-raw";
import { resolveRole } from "./registry";

async function callRole(homeBase: string, role: BrainRole, opts: CallBrainOptions) {
  const config = await loadBrainConfig(homeBase);
  const resolved = resolveRole(config, role);
  // Each role counts in its own daily bucket (spec §12.3): chat (and the chat
  // recap, which uses the chat role), extract (summaries, memory), review.
  const guarded = makeGuardedCallRaw({ homeBase, provider: resolved.provider, usedBy: role });
  // Read-only, always: every role-routed call (memory summarizer, facts,
  // events, entity tags, episodes, recap, repo summary, remember) carries
  // transcript text — tool output from other repos — and none needs a tool
  // that writes, runs commands or fetches. A captured summarizer call was
  // offered Bash/Write/Edit/WebFetch + the user's MCP servers (2026-10-18);
  // replayed read-only, its output scored the same (0 tool calls either way).
  // Not "no tools": zero tools measurably changed answers (#1072 / #1076).
  // Project settings off, always, for the same reason: these calls run in
  // whatever folder their process sits in — for a daemon revived by a codex or
  // agy Stop hook, a project claude never asked the user to trust. The review
  // is not role-routed; it sets the same flag itself (critic phases + the
  // legacy path in handle-stop.ts, #1091).
  return guarded({ ...opts, readOnly: true, projectSettingsOff: true, model: resolved.model });
}

/** callBrainRaw-shaped: returns { output: unknown (JSON-parsed), usage }. */
export function makeRoleRawBrain(
  homeBase: string,
  role: BrainRole,
): (opts: CallBrainOptions) => Promise<BrainCallRawResult> {
  return async (opts) => {
    const { text, usage } = await callRole(homeBase, role, opts);
    return { output: parseRawJson(text), usage };
  };
}

/** callBrainText-shaped: returns { text, usage } (for recap's prose path). */
export function makeRoleTextBrain(
  homeBase: string,
  role: BrainRole,
): (opts: CallBrainOptions) => Promise<{ text: string; usage: BrainUsage }> {
  return async (opts) => {
    const { text, usage } = await callRole(homeBase, role, opts);
    return { text, usage };
  };
}

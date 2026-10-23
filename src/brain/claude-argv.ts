// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * argv for `claude -p`.
 *
 * Split out of brain.ts, which sits at its length pin: the flag set carries a
 * lot of load-bearing rationale (see `--verbose` below) and defect `[26]` added
 * a second shape for the system prompt on top of it.
 */

import { PROJECT_SETTINGS_OFF } from "./project-settings-off";

/** What a read-only call may use. The chat's list (`chat-argv.ts`), kept separate on purpose. */
export const READ_ONLY_TOOLS = "Read,Grep,Glob";

export function buildClaudeArgv(
  model: string,
  promptArgs: readonly string[],
  readOnly = false,
  projectSettingsOff = false,
): string[] {
  const argv = [
      "claude",
      "-p",
      "--model",
      model,
      ...promptArgs,
      "--output-format",
      "json",
      // Defect [12]: `--output-format json` returns the full event ARRAY
      // only when verbose is on, and that is the USER's
      // `~/.claude/settings.json` — off in a clean new-user config, which
      // made every review fail silently. The argv flag wins over the
      // setting (measured against CC 2.1.274), so the shape is ours.
      //
      // ⚠️ CHANGING THIS FLAG CHANGES WHAT THE FAILURE CLASSIFIER READS.
      // With it, stdout is the whole event stream, and one of the stream's
      // own type names (`rate_limit_event`) matches a frozen classifier
      // marker (`/rate[ _-]?limit/i` in failure-classify.ts). That is why
      // the exit!==0 path below hands the classifier `classifierStdout()`
      // — the result event alone — instead of the raw tail: without it a
      // plain `ambiguous` failure classified as `throttle` and authorized
      // a second PAID spawn (measured; tests/brain/classifier-verbose-noise
      // .test.ts opens with that device check). If this flag ever goes
      // away, `classifierStdout` must be revisited in the same change.
      "--verbose",
      "--no-session-persistence",
    ];
  // `readOnly`: the review sets it. Its prompt carries the diff — text from
  // the reviewed repo — and a review needs no shell: 48 replays of 8 real
  // reviews, with and without these flags, made 0 tool calls either way.
  //
  // Not `--tools=` (no tools at all), though the review never calls one:
  // with zero tools claude answers differently. Measured 2026-10-18 on the
  // same captured prompts — the diff summary's file count was right 18/28
  // with no tools vs 18/18 read-only and 28/28 with every tool, and the
  // review found the planted problems 7/12 vs 9/12.
  //
  // `--tools` takes several values, so it must not sit before a positional
  // argument; the prompt arrives on stdin. `--tools` alone leaves the user's
  // MCP servers on — `--strict-mcp-config` with no `--mcp-config` turns them off.
  //
  // `projectSettingsOff`: every role-routed call sets it (role-brain.ts) —
  // memory summarizer, facts, repo summary, diff summary, recap. These run in
  // whatever folder their process sits in, and a daemon revived by a codex or
  // agy Stop hook sat in that session's project: a folder claude never asked
  // the user to trust. Every review path sets it too; the main one
  // (critic/phases/normal.ts) gets the project's CLAUDE.md as fenced data instead.
  // Placed before `--tools` so the tool list stays the argv's tail.
  const withSettings = projectSettingsOff ? [...argv, ...PROJECT_SETTINGS_OFF] : argv;
  return readOnly ? [...withSettings, "--tools", READ_ONLY_TOOLS, "--strict-mcp-config"] : withSettings;
}


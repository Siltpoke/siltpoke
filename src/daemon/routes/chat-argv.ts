// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The argv a chat turn hands `claude -p`, with the system prompt staged for
 * the platform.
 *
 * Its own module rather than a closure inside `startClaudeSession` because
 * defect `[26]`'s fix pushed both that function and `chat-stream.ts` past
 * their length pins, and a pin is a ratchet that only turns down.
 */
import { PROJECT_SETTINGS_OFF } from "../../brain/project-settings-off";
import { systemPromptArgs } from "../../brain/system-prompt-file";

interface StagedArgv {
  /** The full argv, ready for `Bun.spawn`. */
  readonly args: string[];
  /**
   * Removes the staged prompt file, if one was written. Safe to call more than
   * once, and it MUST be called on every exit path — including the ones that
   * never build a session.
   */
  readonly cleanup: () => void;
}

/**
 * The only tools a chat turn's `claude` may use. Without `--tools` it was
 * offered all of them, and a real run executed `uname -a ; whoami` through
 * Bash when asked (2026-10-17) — the sibling of defect `[83]` in explain.
 * Reading stays so chat can still open a file it is asked about.
 */
export const CHAT_TOOLS = "Read,Grep,Glob";

/**
 * Build `claude -p`'s argv for one chat turn.
 *
 * Defect `[26]`: on Windows the runtime refuses to hand `claude.cmd` any
 * argument carrying a cmd.exe special character, which a system prompt always
 * does, so the whole turn failed before the process started. On win32 the
 * prompt is staged in a temp file and only its path travels in argv; every
 * other platform keeps the argv form it has always had.
 */
export function buildChatArgv(
  model: string,
  systemPrompt: string | undefined,
  platform?: NodeJS.Platform,
): StagedArgv {
  const args = [
    "claude",
    "-p",
    "--model",
    model,
    "--output-format",
    "stream-json",
    // Defect [12], the loudest of the three sites: `--print
    // --output-format=stream-json` EXITS 1 without --verbose ("requires
    // --verbose"), so dashboard chat was dead on any clean install rather
    // than merely mis-shaped.
    "--verbose",
    "--no-session-persistence",
    "--tools",
    CHAT_TOOLS,
    // `--tools` does not reach MCP servers: the user's own (some can edit
    // files) stayed on offer until this skipped loading them.
    "--strict-mcp-config",
    // A pinned turn runs in the project's folder: never load its CLAUDE.md or
    // run its hooks (see project-settings-off.ts).
    ...PROJECT_SETTINGS_OFF,
  ];
  if (systemPrompt === undefined || systemPrompt === "") {
    return { args, cleanup: () => {} };
  }
  const staged = systemPromptArgs(systemPrompt, { supportsFile: true, platform });
  args.push(...staged.args);
  return { args, cleanup: staged.cleanup };
}

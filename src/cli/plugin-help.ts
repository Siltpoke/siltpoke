// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The `/siltpoke-help` manual.
 *
 * Lives in code (not in the command's markdown) for one reason: the command
 * surface a `/plugin install` actually exposes is the 10 commands below, and
 * that list has to be derivable from the shipped bundle rather than from a
 * prose file that can drift from it. `tests/plugin/commands.test.ts` asserts
 * this text lists exactly the commands that exist.
 */

/** The complete command surface of the installed plugin. Keep in sync with `.claude-plugin/commands/`. */
export const PLUGIN_COMMANDS: ReadonlyArray<{ name: string; blurb: string }> = [
  { name: "/siltpoke-setup", blurb: "Create your pet + finish the install (statusline, dashboard)." },
  { name: "/siltpoke-last", blurb: "Pull Siltpoke's most recent review INTO this conversation." },
  { name: "/siltpoke-dashboard", blurb: "Open the dashboard (http://127.0.0.1:9876)." },
  { name: "/siltpoke-restart-daemon", blurb: "Restart the dashboard daemon." },
  { name: "/siltpoke-menubar", blurb: "Put the pet in your macOS menu bar (needs SwiftBar). install/status/remove." },
  { name: "/siltpoke-mute", blurb: "Silence Siltpoke for a duration (15m / 1h / 2d / indefinite)." },
  { name: "/siltpoke-unmute", blurb: "Un-silence Siltpoke." },
  { name: "/siltpoke-brain", blurb: "Show or set which CLI + model reviews your code (set review <family> [model])." },
  { name: "/siltpoke-doctor", blurb: "Install-health diagnostic (✓/✗ checklist)." },
  { name: "/siltpoke-help", blurb: "This manual." },
];

function commandTable(): string {
  const width = Math.max(...PLUGIN_COMMANDS.map((c) => c.name.length));
  return PLUGIN_COMMANDS.map((c) => `  ${c.name.padEnd(width)}   ${c.blurb}`).join("\n");
}

export function helpText(): string {
  return `╭──────────────────────────────────────────────────────────╮
│  Siltpoke — a second pair of eyes on your code            │
╰──────────────────────────────────────────────────────────╯

WHAT IT DOES

  After every turn, a separate reviewer reads over Claude's shoulder,
  looks for what Claude missed, and writes a review to disk.
  Reviews NEVER auto-inject into your chat — nothing interrupts you.
  You pull one in when you want it, with /siltpoke-last.

COMMANDS (the whole surface — there are only 10)

${commandTable()}

THE DASHBOARD IS WHERE EVERYTHING ELSE LIVES

  /siltpoke-dashboard opens it at http://127.0.0.1:9876.
  The full review history, the chat with your pet, and the code-map of
  your repo all live there — not behind slash commands. If you are
  looking for something that is not in the list above, it is in the
  dashboard.

WHICH MODEL REVIEWS YOUR CODE

  By default, reviews run through the \`claude\` CLI you already have
  installed — Siltpoke shells out to it. Nothing extra is downloaded and
  no API key of ours is involved; the reviews cost what that CLI costs
  you (typically a few cents a day, thanks to prompt caching).

  A local model (Ollama) is available instead if you want reviews to run
  entirely on your machine with no cloud call. It is not installed by
  default — it is a several-GB download — so ask for it and it can be
  switched on.

QUIET

  /siltpoke-mute 1h        silence for an hour (mute beats everything)
  /siltpoke-unmute         resume

TROUBLE

  /siltpoke-doctor         tells you exactly which piece is not wired up
`;
}

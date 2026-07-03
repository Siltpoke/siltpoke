// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Generic action CLI. Accepts one of feed/play/clean/pet/sleep/tease as the
 * sole arg, drives the same recordAction() pipeline the dashboard /api/action
 * route uses. Stats + XP cap are therefore shared across CLI and dashboard.
 *
 * Prints a JSON result on stdout, mirroring src/cli/pet.ts shape:
 *   { action, awarded, capped, grumpy, action_count, level, xp, bubble }
 *
 * Slash commands in .claude-plugin/commands/ wrap this script per action.
 */
import { join } from "node:path";
import {
  readProgression,
  writeProgression,
  recordAction,
  type PetAction,
} from "../state/progression";
import { writeState } from "../state/state";
import { dayKey } from "../state/usage";

const VALID_ACTIONS: readonly PetAction[] = [
  "feed", "play", "clean", "pet", "sleep", "tease",
];

const BUBBLES: Record<PetAction, readonly string[]> = {
  feed:  ["nom nom nom", "thank you human", "more snacks please", "tasty"],
  play:  ["zoomies!", "again again", "i love this", "WHEE"],
  clean: ["shiny", "ahh fresh", "no more dust", "spotless"],
  pet:   ["rrrrrr 🐾", "Mmrrp!", "soft squish detected", "I will allow this"],
  sleep: ["zzzz", "dreaming of bugs (fixed ones)", "do not disturb"],
  tease: ["rude.", "I will remember this", "¬.¬", "stop that"],
};

const MOOD_BY_ACTION: Record<PetAction, "happy" | "sleepy" | "sad"> = {
  feed:  "happy",
  play:  "happy",
  clean: "happy",
  pet:   "happy",
  sleep: "sleepy",
  tease: "sad",
};

function siltpokeHome(envHome: string | undefined): string {
  return join(envHome ?? "", ".siltpoke");
}

export interface ActionResult {
  action: PetAction;
  awarded: number;
  capped: boolean;
  grumpy: boolean;
  action_count: number;
  level: number;
  xp: number;
  bubble: string;
}

export async function runActionCli(
  action: PetAction,
  opts: { homeBase?: string; now?: () => Date } = {},
): Promise<ActionResult> {
  const homeBase = opts.homeBase ?? siltpokeHome(process.env.HOME);
  const now = (opts.now ?? (() => new Date()))();
  const day = dayKey(now, 0);

  const current = await readProgression(homeBase);
  const result = recordAction(current, day, action);
  await writeProgression(homeBase, result.next);

  const bubbles = BUBBLES[action];
  const bubble =
    bubbles[Math.floor(Math.random() * bubbles.length)] ?? bubbles[0]!;

  await writeState(homeBase, {
    schemaVersion: 1,
    mood: MOOD_BY_ACTION[action],
    pose: "base",
    bubble_short: bubble,
    severity: "info",
    confidence: "high",
    last_updated_ms: now.getTime(),
    last_session_id: `action:${action}`,
  });

  return {
    action,
    awarded: result.awarded,
    capped: result.capped,
    grumpy: result.grumpy,
    action_count: result.action_count,
    level: result.next.level,
    xp: result.next.xp,
    bubble,
  };
}

if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg || !(VALID_ACTIONS as readonly string[]).includes(arg)) {
    process.stderr.write(
      `usage: bun src/cli/action.ts <${VALID_ACTIONS.join("|")}>\n`,
    );
    process.exit(2);
  }
  const r = await runActionCli(arg as PetAction);
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  process.exit(0);
}

// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { join } from "node:path";
import {
  readProgression,
  writeProgression,
  recordAction,
} from "../state/progression";
import { writeState } from "../state/state";
import { dayKey } from "../state/usage";

const PET_BUBBLES = [
  "rrrrrr 🐾",
  "Mmrrp! more please",
  "soft squish detected",
  "I will allow this",
  "tail twitches happily",
  "you are forgiven for that one bug",
];

function siltpokeHome(envHome: string | undefined): string {
  return join(envHome ?? "", ".siltpoke");
}

export interface PetOptions {
  homeBase?: string;
  now?: () => Date;
}

export interface PetResult {
  awarded: number;
  capped: boolean;
  pets_today: number;
  level: number;
  xp: number;
  bubble: string;
}

export async function runPet(opts: PetOptions = {}): Promise<PetResult> {
  const homeBase = opts.homeBase ?? siltpokeHome(process.env.HOME);
  const now = (opts.now ?? (() => new Date()))();
  const day = dayKey(now, 0);

  const current = await readProgression(homeBase);
  // Route through recordAction so the CLI shares the dashboard's
  // ACTION_XP_DAILY_CAP budget. `capped` now means "XP capped today" rather
  // than "petted enough" — stats always apply per click.
  const result = recordAction(current, day, "pet");
  await writeProgression(homeBase, result.next);

  const bubble =
    PET_BUBBLES[Math.floor(Math.random() * PET_BUBBLES.length)] ??
    PET_BUBBLES[0]!;

  await writeState(homeBase, {
    schemaVersion: 1,
    mood: "happy",
    pose: "base",
    bubble_short: bubble,
    severity: "info",
    confidence: "high",
    last_updated_ms: now.getTime(),
    last_session_id: "pet",
  });

  return {
    awarded: result.awarded,
    capped: result.capped,
    pets_today: result.action_count,
    level: result.next.level,
    xp: result.next.xp,
    bubble,
  };
}

if (import.meta.main) {
  const r = await runPet();
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  process.exit(0);
}

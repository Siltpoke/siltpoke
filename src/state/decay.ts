// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Pet stat decay.
 *
 * Applies time-based stat decay to a Progression snapshot.
 * Called by the daemon's 10-min background tick (petTick.ts).
 */
import type { Progression } from "./progression";
import type { Stats } from "./progression";

export const DECAY_RATES_PER_HOUR: Record<keyof Stats, number> = {
  hp:     0,
  bond:   0,
  hunger: 0.5,
  energy: 0.3,
  mood:   0.2,
};

function clamp(v: number): number {
  return Math.max(0, Math.min(10, v));
}

/**
 * Apply decay to stats over a given elapsed time window.
 * Pure function — returns new Stats.
 *
 * Starvation rule: if hunger was already 0 when entering this window,
 * mood takes an additional -0.5/hr penalty.
 */
export function applyDecay(stats: Readonly<Stats>, hoursElapsed: number): Stats {
  if (hoursElapsed <= 0) return { ...stats };
  const starving = stats.hunger <= 0;
  return {
    hp:     clamp(stats.hp),
    bond:   clamp(stats.bond),
    hunger: clamp(stats.hunger - DECAY_RATES_PER_HOUR.hunger * hoursElapsed),
    energy: clamp(stats.energy - DECAY_RATES_PER_HOUR.energy * hoursElapsed),
    mood:   clamp(
      stats.mood -
        DECAY_RATES_PER_HOUR.mood * hoursElapsed -
        (starving ? 0.5 * hoursElapsed : 0),
    ),
  };
}

/**
 * Apply catch-up decay to a Progression based on wall-clock time elapsed
 * since stats_last_tick_at. Returns updated Progression.
 */
export function tickDecay(prog: Progression, now: Date): Progression {
  const last = new Date(prog.stats_last_tick_at).getTime();
  const hoursElapsed = Math.max(0, (now.getTime() - last) / 3_600_000);
  const stats = applyDecay(prog.stats, hoursElapsed);
  return { ...prog, stats, stats_last_tick_at: now.toISOString() };
}

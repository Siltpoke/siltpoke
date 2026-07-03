// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Pet decay background tick.
 *
 * Starts a setInterval loop that applies time-based stat decay every
 * `intervalMs` milliseconds (default 10 min). A cleanup function is
 * returned to cancel the timer on shutdown.
 */
import { readProgression, writeProgression } from "../state/progression";
import { tickDecay } from "../state/decay";

export interface PetTickDeps {
  homeBase: string;
  /** Override tick interval in ms. Defaults to 600_000 (10 min). */
  intervalMs?: number;
  /** Injectable clock for deterministic tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * Start the background decay tick loop.
 * Returns a cleanup function — call it to cancel the interval.
 */
export function startDecayTick(deps: PetTickDeps): () => void {
  const interval = deps.intervalMs ?? 600_000;
  const timer = setInterval(() => {
    pokeOnce(deps).catch(() => {
      // Swallow errors — daemon stays up.
    });
  }, interval);
  // Belt-and-suspenders: unref so even a future un-cleared timer can't pin
  // the event loop and resurrect the SIGTERM-hang zombie. Mirrors task-registry.ts.
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

/**
 * Apply a single decay tick to the persisted progression.
 * Exported for use in tests and manual triggering.
 */
export async function pokeOnce(deps: PetTickDeps): Promise<void> {
  const now = deps.now ? deps.now() : new Date();
  const prog = await readProgression(deps.homeBase);
  const next = tickDecay(prog, now);
  await writeProgression(deps.homeBase, next);
}

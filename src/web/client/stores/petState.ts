// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * petState — nanostore for current pet identity.
 *
 * Uses `atom` (whole-object reads) rather than `map` (per-key subscriptions)
 * because screen surfaces always read the full pet object.
 *
 * Types are imported from the creature module so the store is type-safe
 * end-to-end with the ASCII renderer.
 */
import { atom } from "nanostores";
import type { Species, Mood } from "../../creature/parts";

export interface Pet {
  name: string;
  species: Species;
  mood: Mood;
  level: number;
}

const DEFAULT_PET: Pet = {
  name: "siltpoke",
  species: "slime",
  mood: "neutral",
  level: 1,
};

/** Writable atom holding current pet identity. */
export const $pet = atom<Pet>(DEFAULT_PET);

/**
 * Shallow-merge `next` into current pet state.
 *
 * `Partial<Pet>` permits `undefined` values at the type level; we strip
 * them at runtime so `setPet({ species: undefined })` does NOT overwrite
 * the existing species with `undefined`. Only explicitly provided non-
 * undefined keys are merged.
 *
 * Returns a new object — never mutates the existing value.
 */
export function setPet(next: Partial<Pet>): void {
  const defined: Partial<Pet> = {};
  for (const [k, v] of Object.entries(next) as [keyof Pet, Pet[keyof Pet]][]) {
    if (v !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (defined as any)[k] = v;
    }
  }
  $pet.set({ ...$pet.get(), ...defined });
}

// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Pure ASCII creature renderer.
 *
 * All functions are pure (no side effects, no React, no DOM).
 *
 * Design notes:
 *   1. 8 moods are supported (neutral / happy / sleepy / sad / hungry / poke /
 *      snark / wow). Kept all 8 because cutting moods loses product surface
 *      used elsewhere (StatuslinePet, previews).
 *   2. composeAscii signature takes 4 args:
 *      composeAscii(slots, mood, stage, species) — the `slots` object carries
 *      no species origin tag, so the per-species face-line dispatch in
 *      faceLineFor cannot be reached without knowing which species produced
 *      the slots. This keeps Slots as a pure data type and avoids inference
 *      magic; it's the minimal API shape.
 */

import { EGG_ART, MOOD_EYES, SPECIES } from './parts';
import type { Mood, Slots, Species, Stage } from './parts';

// ── defaultSlotsFor ──────────────────────────────────────────────────────────

/**
 * Returns the species's 3 default frame lines as named slots.
 * This is the seam future customizers override slot-by-slot before
 * passing into composeAscii.
 */
export function defaultSlotsFor(species: Species): Slots {
  const entry = SPECIES[species];
  return {
    head: entry.base[0],
    face: entry.base[1],
    legs: entry.base[2],
  };
}

// ── faceLineFor ──────────────────────────────────────────────────────────────

/**
 * Builds the middle line for a given species + mood.
 * Ported verbatim from the source's switch; now keyed by typed literals.
 */
export function faceLineFor(species: Species, mood: Mood): string {
  const eyes = MOOD_EYES[mood];
  switch (species) {
    case 'cat':   return ` (${eyes}) `;
    case 'bunny': return ` (${eyes}) `;
    case 'bun':   return ` (${eyes})v`;
    case 'otter': return ` (${eyes}) `;
    case 'crab':  return ` (${eyes}) `;
    case 'robot': return ` │${eyes.replace(/\./g, '_').replace(/[a-zA-Z<>T^¬⊙]/g, '■')}│ `;
    case 'alien': return ` <${eyes}> `;
    case 'slime': return ` /${eyes.replace('.', ' ')}\\ `;
    default: {
      // Exhaustiveness guard — adding a new species to `Species` without
      // extending this switch is a compile error here (and a runtime throw
      // if a deserialized payload ever wanders in past types).
      const _exhaustive: never = species;
      throw new Error(`Unknown species: ${String(_exhaustive)}`);
    }
  }
}

// ── decorateFor ──────────────────────────────────────────────────────────────

/**
 * Applies mood-based post-processing to the 3-line tuple.
 *   poke  → appends '>' to face line (trim trailing spaces first)
 *   sleepy → appends 'z' to top line (trim trailing spaces first)
 * Ported verbatim from the source; species arg removed (source had it but
 * never used it in the logic).
 */
export function decorateFor(
  mood: Mood,
  lines: [string, string, string],
): [string, string, string] {
  if (mood === 'poke') {
    return [lines[0], `${lines[1].replace(/\s+$/, '')}>`, lines[2]];
  }
  if (mood === 'sleepy') {
    return [`${lines[0].replace(/\s+$/, '')}z`, lines[1], lines[2]];
  }
  return lines;
}

// ── composeAscii ─────────────────────────────────────────────────────────────

/**
 * THE composition entry point. Returns a 3-line tuple after applying mood and
 * stage transformations.
 *
 * Stage semantics:
 *   egg      → returns EGG_ART regardless of slots/species
 *   juvenile → [slots.head, faceLineFor(species, mood), slots.legs] + decorateFor
 *   adult    → juvenile output wrapped with ★ corners + padded blank middle
 *              (aura corners from PROGRESSION.md lv15+ ★ aura)
 *
 * @param slots   Named slot rows (head/face/legs). For juvenile/adult stages,
 *                `slots.face` is intentionally IGNORED — the face line is
 *                rebuilt by faceLineFor(species, mood). Customizers wanting
 *                to override face must extend faceLineFor or use a future
 *                slot-overlay API; overriding `slots.face` alone is a no-op.
 *                Only `slots.head` and `slots.legs` are read for non-egg
 *                stages. Egg stage ignores slots entirely.
 * @param mood    Active mood — drives eye-pair + decoration.
 * @param stage   Life-stage — drives structural transformation.
 * @param species Required so faceLineFor can choose the correct bracket style.
 *                (See module docblock design note #2.)
 */
export function composeAscii(
  slots: Slots,
  mood: Mood,
  stage: Stage,
  species: Species,
): [string, string, string] {
  if (stage === 'egg') {
    return [...EGG_ART] as [string, string, string];
  }

  // Build juvenile lines
  let lines: [string, string, string] = [
    slots.head,
    faceLineFor(species, mood),
    slots.legs,
  ];
  lines = decorateFor(mood, lines);

  if (stage === 'juvenile') {
    return lines;
  }

  // adult: wrap with ★ corners + a padded blank middle line
  // (aura corners per PROGRESSION.md lv15+)
  return [
    `★${lines[0]}★`,
    ` ${lines[1]} `,
    `★${lines[2]}★`,
  ];
}

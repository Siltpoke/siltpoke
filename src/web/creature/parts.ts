// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Typed data tables for the ASCII creature renderer.
 *
 * Holds the 8 canonical species frames, 8 mood eye-pairs, egg art, and all
 * exported literal types. Pure data — no rendering logic, no side effects.
 */

// ── Literal types ────────────────────────────────────────────────────────────

export type Species = 'cat' | 'bunny' | 'robot' | 'bun' | 'otter' | 'alien' | 'slime' | 'crab';

/**
 * 8 moods. Honored the source (authoritative) — see deviation note in renderer.ts.
 */
export type Mood =
  | 'neutral'
  | 'happy'
  | 'sleepy'
  | 'sad'
  | 'hungry'
  | 'poke'
  | 'snark'
  | 'wow';

export type Stage = 'egg' | 'juvenile' | 'adult';

/**
 * Three named slots for the creature's ASCII art rows.
 * `head` = top line, `face` = middle line (species brackets + eyes), `legs` = bottom line.
 * Future customizer overrides individual slots before calling composeAscii.
 */
export interface Slots {
  head: string;
  face: string;
  legs: string;
}

// ── Species metadata ─────────────────────────────────────────────────────────

export interface SpeciesMeta {
  /** Special face-line rendering: robot uses block characters */
  monoFace?: true;
  /** Which bracket style wraps the eyes: 'angle' = < > */
  bracket?: 'angle';
  /** Open-face species (slime): replaces the '.' separator with a space */
  openFace?: true;
}

export interface SpeciesEntry {
  id: Species;
  /** [topLine, middleLine, bottomLine] — the default 3-line ASCII frame */
  base: [string, string, string];
  meta?: SpeciesMeta;
}

/**
 * Locked species table. Do NOT add or remove entries without careful review.
 * Order matches the source; do not reorder (tests rely on stable iteration).
 */
export const SPECIES: Record<Species, SpeciesEntry> = {
  cat: {
    id: 'cat',
    base: [' /\\_/\\ ', ' (o.o) ', ' > ^ < '],
  },
  bunny: {
    id: 'bunny',
    base: [' (\\_/) ', ' (o.o) ', ' (")(") '],
  },
  robot: {
    id: 'robot',
    base: [' ┌─◉─┐ ', ' │■_■│ ', ' └─┴─┘ '],
    meta: { monoFace: true },
  },
  bun: {
    id: 'bun',
    base: [' ⌒⌒⌒⌒ ', ' (o.o)v', '  ◡ ◡  '],
  },
  otter: {
    id: 'otter',
    base: ['  ___  ', ' (o.o) ', ' \\uuu/ '],
  },
  alien: {
    id: 'alien',
    base: ['  ___  ', ' <o,o> ', " [`-'] "],
    meta: { bracket: 'angle' },
  },
  slime: {
    id: 'slime',
    base: ['  ___  ', ' /o o\\ ', "`-----'"],
    meta: { openFace: true },
  },
  crab: {
    id: 'crab',
    // base[1] uses 1 leading space to match the source verbatim — a
    // 2-space "centering" produced a body shifted one column right of the
    // claws under center-aligned <pre>. Reverted after a live-smoke check.
    base: ['(\\/)_(\\/)', ' (o.o) ', ' /\\  /\\ '],
  },
} as const;

// ── Mood eyes ────────────────────────────────────────────────────────────────

/**
 * Eye-pair string keyed by mood.
 * Single-pair eyes; the species frame supplies the surrounding brackets.
 */
export const MOOD_EYES: Record<Mood, string> = {
  neutral: 'o.o',
  happy:   '^.^',
  sleepy:  '-.-',
  sad:     'T_T',
  hungry:  '>.<',
  poke:    'o.o',
  snark:   '¬.¬',
  wow:     '⊙.⊙',
} as const;

// ── Egg art ──────────────────────────────────────────────────────────────────

/** 3-line egg ASCII shown for stage='egg' regardless of species. */
export const EGG_ART: [string, string, string] = [
  '  .--.  ',
  ' /    \\ ',
  ' \\____/ ',
] as const;

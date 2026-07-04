// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Hono JSX SSR component for the ASCII Siltpoke creature.
 *
 * Pure SSR — no React hooks, no DOM, no animations. Those belong elsewhere.
 */
import { tokens } from '../tokens/tokens';
import { defaultSlotsFor, composeAscii } from './renderer';
import type { Mood, Species, Stage } from './parts';

export interface CreatureProps {
  species: Species;
  mood?: Mood;
  stage?: Stage;
  /** Legacy pixel-unit cell size (matches original Siltpoke API). Default 6. */
  cell?: number;
  color?: string;
}

/**
 * Renders the Siltpoke creature as a monospace <pre> block.
 *
 * `cell` maps to font-size via `size = Math.max(9, Math.round(cell * 3.0 + 4))`
 * so existing layouts that sized the old pixel sprite still scale sensibly.
 */
export function Creature(props: CreatureProps) {
  const {
    species,
    mood = 'neutral',
    stage = 'juvenile',
    cell = 6,
    color = tokens.color.ink,
  } = props;

  // Mirror source's cell → font-size mapping exactly.
  const size = Math.max(9, Math.round(cell * 3.0 + 4));

  const slots = defaultSlotsFor(species);
  const [line0, line1, line2] = composeAscii(slots, mood, stage, species);
  const text = `${line0}\n${line1}\n${line2}`;

  return (
    <pre
      style={{
        margin: 0,
        padding: 0,
        fontFamily: tokens.font.mono,
        fontSize: size,
        lineHeight: 1.05,
        color,
        whiteSpace: 'pre',
        textAlign: 'center',
      }}
    >
      {text}
    </pre>
  );
}

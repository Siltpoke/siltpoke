// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Preview stories for the Creature component.
 *
 * Generates one story per (species × mood × stage) combination programmatically.
 * 8 species × 8 moods × 3 stages = 192 stories total.
 */
import type { PreviewStory } from '../routes/preview';
import { Creature } from './Creature';
import type { Mood, Species, Stage } from './parts';

const SPECIES: Species[] = ['cat', 'bunny', 'robot', 'bun', 'otter', 'alien', 'slime', 'crab'];
const MOODS: Mood[] = ['neutral', 'happy', 'sleepy', 'sad', 'hungry', 'poke', 'snark', 'wow'];
const STAGES: Stage[] = ['egg', 'juvenile', 'adult'];

const stories: PreviewStory[] = SPECIES.flatMap((species) =>
  MOODS.flatMap((mood) =>
    STAGES.map((stage) => ({
      name: `${species}-${mood}-${stage}`,
      render: () => <Creature species={species} mood={mood} stage={stage} />,
    })),
  ),
);

export default stories;

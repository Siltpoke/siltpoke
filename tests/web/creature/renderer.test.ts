import { test, expect, describe } from 'bun:test';
import {
  defaultSlotsFor,
  faceLineFor,
  decorateFor,
  composeAscii,
} from '../../../src/web/creature/renderer';
import { EGG_ART } from '../../../src/web/creature/parts';

// ── defaultSlotsFor ──────────────────────────────────────────────────────────

describe('defaultSlotsFor', () => {
  test('returns correct 3 slots for cat', () => {
    const slots = defaultSlotsFor('cat');
    expect(slots.head).toBe(' /\\_/\\ ');
    expect(slots.face).toBe(' (o.o) ');
    expect(slots.legs).toBe(' > ^ < ');
  });

  test('returns correct 3 slots for slime', () => {
    const slots = defaultSlotsFor('slime');
    expect(slots.head).toBe('  ___  ');
    expect(slots.face).toBe(' /o o\\ ');
    expect(slots.legs).toBe("`-----'");
  });
});

// ── faceLineFor ──────────────────────────────────────────────────────────────

describe('faceLineFor', () => {
  test('cat uses round brackets', () => {
    expect(faceLineFor('cat', 'neutral')).toBe(' (o.o) ');
  });

  test('robot replaces dot with _ and letters with ■', () => {
    // neutral eyes = 'o.o' → o→■, .→_, o→■ → '■_■'
    expect(faceLineFor('robot', 'neutral')).toBe(' │■_■│ ');
  });

  test('alien uses angle brackets', () => {
    expect(faceLineFor('alien', 'neutral')).toBe(' <o.o> ');
  });

  test('slime replaces dot with space', () => {
    expect(faceLineFor('slime', 'neutral')).toBe(' /o o\\ ');
  });

  test('bun appends v suffix', () => {
    expect(faceLineFor('bun', 'neutral')).toBe(' (o.o)v');
  });
});

// ── decorateFor ──────────────────────────────────────────────────────────────

describe('decorateFor', () => {
  test('poke: appends > to face line after trimming trailing spaces', () => {
    const lines: [string, string, string] = ['  ___  ', ' /o o\\ ', "`-----'"];
    const result = decorateFor('poke', lines);
    expect(result[1]).toBe(' /o o\\>');
    expect(result[0]).toBe('  ___  ');
    expect(result[2]).toBe("`-----'");
  });

  test('sleepy: appends z to top line after trimming trailing spaces', () => {
    const lines: [string, string, string] = [' /\\_/\\ ', ' (-.-) ', ' > ^ < '];
    const result = decorateFor('sleepy', lines);
    expect(result[0]).toBe(' /\\_/\\z');
    expect(result[1]).toBe(' (-.-) ');
    expect(result[2]).toBe(' > ^ < ');
  });

  test('neutral: no decoration applied', () => {
    const lines: [string, string, string] = [' /\\_/\\ ', ' (o.o) ', ' > ^ < '];
    const result = decorateFor('neutral', lines);
    expect(result).toEqual([' /\\_/\\ ', ' (o.o) ', ' > ^ < ']);
  });
});

// ── composeAscii: 3 stages on cat-neutral ───────────────────────────────────

describe('composeAscii — cat / neutral', () => {
  const slots = defaultSlotsFor('cat');

  test('stage=egg returns EGG_ART regardless of species/mood', () => {
    const result = composeAscii(slots, 'neutral', 'egg', 'cat');
    expect(result).toEqual(['  .--.  ', ' /    \\ ', ' \\____/ ']);
    expect(result).toEqual([...EGG_ART]);
  });

  test('stage=juvenile returns species frame with mood face', () => {
    const result = composeAscii(slots, 'neutral', 'juvenile', 'cat');
    expect(result).toEqual([' /\\_/\\ ', ' (o.o) ', ' > ^ < ']);
  });

  test('stage=adult wraps with ★ corners', () => {
    const result = composeAscii(slots, 'neutral', 'adult', 'cat');
    expect(result[0]).toBe('★ /\\_/\\ ★');
    expect(result[1]).toBe('  (o.o)  ');
    expect(result[2]).toBe('★ > ^ < ★');
  });

  test('adult top and bottom lines start and end with ★', () => {
    const result = composeAscii(slots, 'neutral', 'adult', 'cat');
    expect(result[0].startsWith('★')).toBe(true);
    expect(result[0].endsWith('★')).toBe(true);
    expect(result[2].startsWith('★')).toBe(true);
    expect(result[2].endsWith('★')).toBe(true);
  });
});

// ── composeAscii: all 8 moods on slime-juvenile ──────────────────────────────

describe('composeAscii — slime / juvenile / all moods', () => {
  const slots = defaultSlotsFor('slime');

  test('neutral', () => {
    expect(composeAscii(slots, 'neutral', 'juvenile', 'slime')).toEqual(
      ['  ___  ', ' /o o\\ ', "`-----'"],
    );
  });

  test('happy', () => {
    expect(composeAscii(slots, 'happy', 'juvenile', 'slime')).toEqual(
      ['  ___  ', ' /^ ^\\ ', "`-----'"],
    );
  });

  test('sleepy — appends z to top line', () => {
    expect(composeAscii(slots, 'sleepy', 'juvenile', 'slime')).toEqual(
      ['  ___z', ' /- -\\ ', "`-----'"],
    );
  });

  test('sad', () => {
    expect(composeAscii(slots, 'sad', 'juvenile', 'slime')).toEqual(
      ['  ___  ', ' /T_T\\ ', "`-----'"],
    );
  });

  test('hungry', () => {
    expect(composeAscii(slots, 'hungry', 'juvenile', 'slime')).toEqual(
      ['  ___  ', ' /> <\\ ', "`-----'"],
    );
  });

  test('poke — appends > to face line', () => {
    expect(composeAscii(slots, 'poke', 'juvenile', 'slime')).toEqual(
      ['  ___  ', ' /o o\\>', "`-----'"],
    );
  });

  test('snark', () => {
    expect(composeAscii(slots, 'snark', 'juvenile', 'slime')).toEqual(
      ['  ___  ', ' /¬ ¬\\ ', "`-----'"],
    );
  });

  test('wow', () => {
    expect(composeAscii(slots, 'wow', 'juvenile', 'slime')).toEqual(
      ['  ___  ', ' /⊙ ⊙\\ ', "`-----'"],
    );
  });
});

// ── composeAscii: species-specific face dispatch paths ───────────────────────

describe('composeAscii — species face dispatch paths', () => {
  test('robot-neutral (monoFace path — block characters)', () => {
    const result = composeAscii(defaultSlotsFor('robot'), 'neutral', 'juvenile', 'robot');
    // robot neutral face: neutral eyes 'o.o' → o→■, .→_, o→■ = '■_■'
    expect(result).toEqual([' ┌─◉─┐ ', ' │■_■│ ', ' └─┴─┘ ']);
    // Exact middle line check
    expect(result[1]).toBe(' │■_■│ ');
  });

  test('alien-neutral (bracket=angle path — angle brackets)', () => {
    const result = composeAscii(defaultSlotsFor('alien'), 'neutral', 'juvenile', 'alien');
    // alien face wraps eyes in < >
    expect(result[1]).toBe(' <o.o> ');
  });

  test('slime-neutral (openFace path — dot replaced with space)', () => {
    const result = composeAscii(defaultSlotsFor('slime'), 'neutral', 'juvenile', 'slime');
    // slime replaces '.' with ' ' so 'o.o' → 'o o'
    expect(result[1]).toBe(' /o o\\ ');
  });

  test('bunny-neutral (paren-wrap path)', () => {
    expect(faceLineFor('bunny', 'neutral')).toBe(' (o.o) ');
  });

  test('otter-neutral (paren-wrap path)', () => {
    expect(faceLineFor('otter', 'neutral')).toBe(' (o.o) ');
  });

  test('crab-neutral (source-verbatim 1 leading space)', () => {
    // This was bumped to 2 leading spaces for "centering" at one point,
    // but center-aligned <pre> rendered the body shifted right of the claws.
    // Reverted to the source 1-leading-space pattern.
    expect(faceLineFor('crab', 'neutral')).toBe(' (o.o) ');
  });

  test('bun-neutral (paren-wrap + trailing v ear)', () => {
    expect(faceLineFor('bun', 'neutral')).toBe(' (o.o)v');
  });

  test('cat-neutral (paren-wrap path baseline)', () => {
    expect(faceLineFor('cat', 'neutral')).toBe(' (o.o) ');
  });
});

// ── composeAscii: decoration edge cases ─────────────────────────────────────

describe('composeAscii — decoration edge cases', () => {
  test('poke mood appends > to face line', () => {
    const result = composeAscii(defaultSlotsFor('cat'), 'poke', 'juvenile', 'cat');
    expect(result[1].endsWith('>')).toBe(true);
    expect(result[1]).toBe(' (o.o)>');
  });

  test('sleepy mood appends z to top line', () => {
    const result = composeAscii(defaultSlotsFor('cat'), 'sleepy', 'juvenile', 'cat');
    expect(result[0].endsWith('z')).toBe(true);
    expect(result[0]).toBe(' /\\_/\\z');
    expect(result[1]).toBe(' (-.-) ');
  });

  test('adult stage adds ★ corners on top and bottom lines', () => {
    const result = composeAscii(defaultSlotsFor('bunny'), 'happy', 'adult', 'bunny');
    expect(result[0]).toMatch(/^★.*★$/);
    expect(result[2]).toMatch(/^★.*★$/);
  });

  test('egg stage always returns EGG_ART even for robot+wow', () => {
    const result = composeAscii(defaultSlotsFor('robot'), 'wow', 'egg', 'robot');
    expect(result).toEqual(['  .--.  ', ' /    \\ ', ' \\____/ ']);
  });
});

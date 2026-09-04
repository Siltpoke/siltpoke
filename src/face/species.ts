// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
export interface SpeciesArt {
  base: string;
  concerned: string;
  sleeping: string;
  // Optional pose variants unlocked via progression. Brain may pick any
  // of them in its `pose` field; resolveArt only renders the variant if
  // the species defines it AND the pose is in the user's unlocked_poses
  // list. Unlock levels are defined in src/state/progression.ts.
  peek?: string;
  blink?: string;
  arms_crossed?: string;
  shrug?: string;
  wave?: string;
  stretch?: string;
  zen?: string;
}

export interface Species {
  name: string;
  /**
   * Compact single-glyph face for the macOS menu-bar pet — a small,
   * species-recognizable emoji "head" (🐱 / 🤖 / …). Deliberately STABLE
   * (not mood-driven): the menu bar aggregates many sessions at once, so it
   * can't flip expressions the way the per-session statusline face does.
   * Severity/attention is carried by the `⚠N` badge instead.
   */
  menubarEmoji: string;
  art: SpeciesArt;
}

const slime: Species = {
  name: "slime",
  menubarEmoji: "🟢",
  art: {
    base: [" .---. ", " (o.o) ", " (___) "].join("\n"),
    concerned: [" .---. ", " (>.<) ", " (___) "].join("\n"),
    sleeping: [" .---. ", " (-.-) ", "  zzz  "].join("\n"),
    peek: [" .---. ", " (o.-) ", " (___) "].join("\n"),
    blink: [" .---. ", " (^.^) ", " (___) "].join("\n"),
    arms_crossed: [" .---. ", " (-_-) ", " [___] "].join("\n"),
    shrug: [" .---. ", " (o.O) ", " ¯\\_/¯ "].join("\n"),
    wave: [" .---. ", " (^o^) ", " (_o/) "].join("\n"),
    stretch: [" .---. ", " (o.~) ", " ~o/^\\~ "].join("\n"),
    zen: [" .---. ", " (-。-) ", " ☯___☯ "].join("\n"),
  },
};

const cat: Species = {
  name: "cat",
  menubarEmoji: "🐱",
  art: {
    base: [" /\\_/\\ ", " (o.o) ", " > ^ < "].join("\n"),
    concerned: [" /\\_/\\ ", " (>.<) ", " > _ < "].join("\n"),
    sleeping: [" /\\_/\\ ", " (-.-) ", "  zzz  "].join("\n"),
    peek: [" /\\_/\\ ", " (o.-) ", " > ^ < "].join("\n"),
    blink: [" /\\_/\\ ", " (^.^) ", " > ^ < "].join("\n"),
    arms_crossed: [" /\\_/\\ ", " (-_-) ", " >=-=< "].join("\n"),
    shrug: [" /\\_/\\ ", " (o.O) ", " ¯\\_/¯ "].join("\n"),
    wave: [" /\\_/\\ ", " (^o^) ", " >o/^< "].join("\n"),
    stretch: [" /\\_/\\ ", " (o.~) ", " ~o/^\\~ "].join("\n"),
    zen: [" /\\_/\\ ", " (-。-) ", " ☯ ^ ☯ "].join("\n"),
  },
};

const owl: Species = {
  name: "owl",
  menubarEmoji: "🦉",
  art: {
    base: [" ,-,-, ", " (O,O) ", " ===== "].join("\n"),
    concerned: [" ,-,-, ", " (>,<) ", " ===== "].join("\n"),
    sleeping: [" ,-,-, ", " (-,-) ", " ===== "].join("\n"),
    peek: [" ,-,-, ", " (O,-) ", " ===== "].join("\n"),
    blink: [" ,-,-, ", " (^,^) ", " ===== "].join("\n"),
    arms_crossed: [" ,-,-, ", " (=,=) ", " =[X]= "].join("\n"),
    shrug: [" ,-,-, ", " (O,o) ", " ¯===¯ "].join("\n"),
    wave: [" ,-,-, ", " (^,^) ", " ==o/= "].join("\n"),
    stretch: [" ,-,-, ", " (O,~) ", " ~o=o~ "].join("\n"),
    zen: [" ,-,-, ", " (-。-) ", " ☯===☯ "].join("\n"),
  },
};

const robot: Species = {
  name: "robot",
  menubarEmoji: "🤖",
  art: {
    base: [" [---] ", " |o-o| ", " [___] "].join("\n"),
    concerned: [" [---] ", " |x-x| ", " [___] "].join("\n"),
    sleeping: [" [---] ", " |---| ", " [___] "].join("\n"),
    peek: [" [---] ", " |o-_| ", " [___] "].join("\n"),
    blink: [" [---] ", " |^-^| ", " [___] "].join("\n"),
    arms_crossed: [" [---] ", " |=-=| ", " [X-X] "].join("\n"),
    shrug: [" [---] ", " |o-O| ", " [¯_¯] "].join("\n"),
    wave: [" [---] ", " |^-^| ", " [_o/] "].join("\n"),
    stretch: [" [---] ", " |o-~| ", " [~o~] "].join("\n"),
    zen: [" [---] ", " |-。-| ", " [☯_☯] "].join("\n"),
  },
};

const bunny: Species = {
  name: "bunny",
  menubarEmoji: "🐰",
  art: {
    base: [" (\\_/) ", " (o.o) ", " (=v=) "].join("\n"),
    concerned: [" (\\_/) ", " (>.<) ", " (=v=) "].join("\n"),
    sleeping: [" (\\_/) ", " (-.-) ", "  zzz  "].join("\n"),
    peek: [" (\\_/) ", " (o.-) ", " (=v=) "].join("\n"),
    blink: [" (\\_/) ", " (^.^) ", " (=v=) "].join("\n"),
    arms_crossed: [" (\\_/) ", " (-_-) ", " [=v=] "].join("\n"),
    shrug: [" (\\_/) ", " (o.O) ", " ¯=v=¯ "].join("\n"),
    wave: [" (\\_/) ", " (^o^) ", " (=v/) "].join("\n"),
    stretch: [" (\\_/) ", " (o.~) ", " ~=v=~ "].join("\n"),
    zen: [" (\\_/) ", " (-。-) ", " ☯=v=☯ "].join("\n"),
  },
};

const SPECIES: Record<string, Species> = {
  slime,
  cat,
  owl,
  robot,
  bunny,
};

export const DEFAULT_SPECIES = "slime";

export function getSpecies(name: string | undefined): Species {
  if (!name) return SPECIES[DEFAULT_SPECIES]!;
  return SPECIES[name] ?? SPECIES[DEFAULT_SPECIES]!;
}

export function listSpeciesNames(): string[] {
  return Object.keys(SPECIES);
}

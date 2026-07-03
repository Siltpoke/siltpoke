// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import type { Species, SpeciesArt } from "../face/species";

type VariantKey = keyof SpeciesArt;

const MOOD_TO_VARIANT: Record<string, VariantKey> = {
  happy: "base",
  excited: "base",
  idle: "base",
  watching: "base",
  annoyed: "concerned",
  concerned: "concerned",
  tired: "concerned",
  sleeping_quiet: "sleeping",
  sleeping_broke: "sleeping",
};

// Moods that BYPASS the brain-picked pose: when Siltpoke is sleeping or
// concerned, those moods overrule whatever pose the brain chose so the
// face never looks happy while the mood is grim.
const POSE_OVERRIDING_MOODS = new Set([
  "annoyed",
  "concerned",
  "tired",
  "sleeping_quiet",
  "sleeping_broke",
]);

// Poses the brain may select. Renderable only if (a) the species defines
// art for that key and (b) the pose is in the user's unlocked_poses list.
// "base" is always unlocked and always renderable.
const POSE_KEYS = new Set<VariantKey>([
  "base",
  "peek",
  "blink",
  "arms_crossed",
  "shrug",
  "wave",
  "stretch",
  "zen",
]);

// Moods that ROTATE between two frames over time. Kept as the legacy
// escape hatch for the idle/watching animation; not used once a brain
// pose is supplied.
const ANIMATED_MOODS = new Set(["idle", "watching"]);

const PHASE_DURATION_MS = 2000;

function variantsAvailable(species: Species): VariantKey[] {
  const keys: VariantKey[] = ["base", "concerned", "sleeping"];
  return keys.filter((k) => typeof species.art[k] === "string");
}

export function resolveArt(
  species: Species,
  mood: string,
  pose?: string,
  unlockedPoses?: readonly string[],
  nowMs: number = Date.now(),
): string {
  // Grim moods overrule the brain's pose choice — use mood-mapped variant.
  if (POSE_OVERRIDING_MOODS.has(mood)) {
    const baseVariant = MOOD_TO_VARIANT[mood] ?? "base";
    return species.art[baseVariant] ?? species.art.base;
  }

  // Brain-picked pose path: render the pose variant if the species has it
  // AND it's unlocked. "base" is always unlocked.
  if (
    pose &&
    POSE_KEYS.has(pose as VariantKey) &&
    pose !== "base" &&
    (unlockedPoses?.includes(pose) ?? false)
  ) {
    const poseArt = species.art[pose as VariantKey];
    if (typeof poseArt === "string") return poseArt;
  }

  const baseVariant = MOOD_TO_VARIANT[mood] ?? "base";
  if (!ANIMATED_MOODS.has(mood)) {
    return species.art[baseVariant] ?? species.art.base;
  }

  // Legacy animated-mood rotation for callers that don't pass a pose.
  const available = variantsAvailable(species).filter(
    (v) => v === baseVariant,
  );
  if (available.length <= 1) return species.art[baseVariant] ?? species.art.base;
  const phase = Math.floor(nowMs / PHASE_DURATION_MS) % available.length;
  const chosen = available[phase] ?? baseVariant;
  return species.art[chosen] ?? species.art.base;
}

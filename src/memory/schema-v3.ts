// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * v3 schemas for the hybrid two-store memory model.
 *
 * - `globalSchema` lives at `~/.siltpoke/global.json` — pet identity, XP
 *   ledger, streak, achievements, daily caps, base personality.
 * - `projectMemorySchema` lives at `~/.siltpoke/projects/<sha>/memory.json`
 *   — observed memory (facts / chats / learned rules / drift / consolidation).
 * - `markerSchema` is the opt-in `.siltpoke/marker.json` users drop in a
 *   project root to override automatic resolution.
 *
 * v2 sub-schemas (Fact, Goal, LearnedRule, ChatSession, UserProfile) are
 * re-exported from `memory.ts` unchanged — only their containers move.
 */
import { z } from "zod";
import {
  factSchema,
  chatSessionSchema,
  learnedRuleSchema,
  goalSchema,
} from "./memory";
import { eventFragmentSchema } from "./event-fragment";
import { episodeSchema } from "./episode";

// Personality v3 adds a 5th dimension `curiosity`. Same shape used by both
// `personality_base` (global, static) and `personality_drift` (per-project,
// contextual offset over base).
export const personalityV3Schema = z.object({
  snark: z.number().int().min(-3).max(3).default(0),
  patience: z.number().int().min(-3).max(3).default(0),
  style_strictness: z.number().int().min(-3).max(3).default(0),
  proactivity: z.number().int().min(-3).max(3).default(0),
  curiosity: z.number().int().min(-3).max(3).default(0),
});
export type PersonalityV3 = z.infer<typeof personalityV3Schema>;

export const xpSourceEnum = z.enum([
  "forwarded_critique",
  "accepted_fact",
  "fact_inferred",
  "first_chat_of_day",
  "streak_milestone",
  "achievement_unlock",
  "manual_pet",
]);
export type XpSource = z.infer<typeof xpSourceEnum>;

export const xpEventSchema = z.object({
  id: z.string().min(1),
  ts: z.string().min(1),
  amount: z.number().int().nonnegative(),
  source: xpSourceEnum,
  source_id: z.string().nullable().default(null),
  source_project: z.string().nullable().default(null),
  capped: z.boolean().default(false),
  note: z.string().nullable().default(null),
});
export type XpEvent = z.infer<typeof xpEventSchema>;

export const streakSchema = z.object({
  current_days: z.number().int().nonnegative().default(0),
  longest_days: z.number().int().nonnegative().default(0),
  last_qualifying_local_date: z.string().nullable().default(null),
});
export type Streak = z.infer<typeof streakSchema>;

export const achievementScopeSchema = z.union([
  z.literal("global"),
  z.object({ project: z.string().min(1) }),
]);
export type AchievementScope = z.infer<typeof achievementScopeSchema>;

export const achievementSchema = z.object({
  id: z.string().min(1),
  unlocked_at: z.string().min(1),
  scope: achievementScopeSchema.default("global"),
});
export type Achievement = z.infer<typeof achievementSchema>;

export const dailyCapsSchema = z.object({
  local_date: z.string().min(1),
  per_source_counts: z.record(z.string(), z.number().int().nonnegative()),
});
export type DailyCaps = z.infer<typeof dailyCapsSchema>;

export const appearanceSchema = z.object({
  head: z.string().min(1),
  face: z.string().min(1),
  legs: z.string().min(1),
});
export type Appearance = z.infer<typeof appearanceSchema>;

export const globalUserProfileSchema = z.object({
  name: z.string().default(""),
  communication_style: z
    .enum(["terse", "verbose", "playful", "neutral"])
    .default("neutral"),
});

export const globalSchema = z.object({
  schemaVersion: z.literal(3),
  name: z.string().default("siltpoke"),
  species: z.string().default("cat"),
  appearance: appearanceSchema,
  level: z.number().int().nonnegative().default(1),
  xp_total: z.number().int().nonnegative().default(0),
  xp_log: z.array(xpEventSchema).default([]),
  achievements_unlocked: z.array(achievementSchema).default([]),
  streak: streakSchema.default(() => ({
    current_days: 0,
    longest_days: 0,
    last_qualifying_local_date: null,
  })),
  bond_meter: z.number().int().min(0).max(100).default(0),
  daily_caps_state: dailyCapsSchema,
  personality_base: personalityV3Schema.default(() => ({
    snark: 0,
    patience: 0,
    style_strictness: 0,
    proactivity: 0,
    curiosity: 0,
  })),
  user_profile: globalUserProfileSchema.default(() => ({
    name: "",
    communication_style: "neutral" as const,
  })),
});
export type GlobalMemory = z.infer<typeof globalSchema>;

export const projectUserProfileOverrideSchema = z.object({
  goals: z.array(goalSchema).default([]),
  constraints: z.array(z.string()).default([]),
  prefs: z.record(z.string(), z.unknown()).default({}),
  communication_style: z
    .enum(["terse", "verbose", "playful", "neutral"])
    .nullable()
    .default(null),
});

export const projectMemorySchema = z.object({
  schemaVersion: z.literal(3),
  project_id: z.string().min(1),
  project_root: z.string().min(1),
  display_name: z.string().min(1),
  facts: z.array(factSchema).default([]),
  // Episodic-fragment capture — distinct from facts[]. Default [] = back-compat.
  event_fragments: z.array(eventFragmentSchema).default([]),
  // Episode synthesis — day-bucketed narratives over
  // event_fragments[]. Own collection, paralleling event_fragments[]. Default
  // [] = back-compat.
  episodes: z.array(episodeSchema).default([]),
  chat_sessions: z.array(chatSessionSchema).default([]),
  learned_rules: z.array(learnedRuleSchema).default([]),
  long_term_summary: z.string().default(""),
  last_consolidated_at: z.string(),
  consolidation_due_at: z.string(),
  personality_drift: personalityV3Schema.default(() => ({
    snark: 0,
    patience: 0,
    style_strictness: 0,
    proactivity: 0,
    curiosity: 0,
  })),
  user_profile_override: projectUserProfileOverrideSchema.default(() => ({
    goals: [],
    constraints: [],
    prefs: {},
    communication_style: null,
  })),
});
export type ProjectMemory = z.infer<typeof projectMemorySchema>;

export const markerSchema = z.object({
  project_id: z.string().min(1),
  project_root: z.string().min(1),
  display_name: z.string().min(1),
  written_by: z.literal("siltpoke"),
  written_at: z.string().min(1),
});
export type Marker = z.infer<typeof markerSchema>;

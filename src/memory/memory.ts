// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { writeFile, rename, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { quarantineCorrupt } from "../utils/quarantine";
import { entityRefSchema } from "./entity";
import { eventFragmentSchema, type EventFragment } from "./event-fragment";
import { episodeSchema, type Episode } from "./episode";

export const learnedRuleSchema = z.object({
  id: z.string(),
  rule: z.string(),
  category: z.string(),
  created_at: z.string(),
  last_triggered_at: z.string().optional(),
  applied_count: z.number().int().nonnegative(),
  effectiveness: z.enum(["good", "neutral", "retired"]).default("neutral"),
  source: z.string().optional(),
});

export const personalityDriftSchema = z.object({
  snark: z.number().int().min(-3).max(3).default(0),
  patience: z.number().int().min(-3).max(3).default(0),
  style_strictness: z.number().int().min(-3).max(3).default(0),
  proactivity: z.number().int().min(-3).max(3).default(0),
});

export const goalSchema = z.object({
  id: z.string(),
  text: z.string(),
  created_at: z.string(),
  status: z.enum(["active", "paused", "done"]),
});

export const userProfileSchema = z
  .object({
    name: z.string().optional(),
    communication_style: z
      .enum(["terse", "verbose", "playful", "neutral"])
      .default("neutral"),
    goals: z.array(goalSchema).default([]),
    constraints: z.array(z.string()).default([]),
    prefs: z.record(z.string(), z.unknown()).default({}),
  })
  .default(() => ({
    communication_style: "neutral" as const,
    goals: [],
    constraints: [],
    prefs: {},
  }));

/**
 * The repo-graph node a chat conversation is pinned to. Set ONCE at
 * conversation creation (INV1: immutable except via an explicit re-anchor),
 * carries the file-level fingerprint at pin time (for stale detection). The
 * frozen context bundle lives in a sidecar (`chat/anchor-store.ts`); this is
 * just the metadata the UI + stale-check need.
 */
export const chatAnchorSchema = z.object({
  node_id: z.string(),
  proj_hash: z.string(),
  node_name: z.string(),
  node_type: z.string(),
  fingerprint: z.string().nullable(),
  pinned_at: z.string(),
});

export const factEventSchema = z.object({
  action: z.enum(["created", "approved", "reaffirmed", "retired", "reactivated"]),
  at: z.string(),
  reason: z.string().nullable().default(null),
});

export const chatSessionSchema = z.object({
  id: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  message_count: z.number().int().nonnegative(),
  summary: z.string(),
  // Lazy-recap: null = `summary` is still the deterministic first-message
  // placeholder; a timestamp = a real LLM recap was written. Additive + default
  // → zero migration (mirrors `anchor`). Set by the recap endpoint + consolidate.
  summary_generated_at: z.string().nullable().default(null),
  tags: z.array(z.string()),
  anchor: chatAnchorSchema.nullable().default(null),
});

export const factSchema = z.object({
  id: z.string(),
  text: z.string(),
  source_session_id: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  status: z
    .enum(["pending", "active", "retired", "retire_proposed"])
    .default("pending"),
  created_at: z.string(),
  last_seen_at: z.string(),
  supersedes: z.string().nullable(),
  // Reverse pointer set on the OLD fact when a newer fact supersedes it.
  superseded_by: z.string().nullable().default(null),
  // Manual hard-constraint protection; pinned facts are exempt from decay.
  pinned: z.boolean().default(false),
  // How many times this fact was recalled at decision time (incremented
  // later); factors into the decay score. Starts at 0.
  recall_count: z.number().int().nonnegative().default(0),
  retired_reason: z
    .enum([
      "superseded",
      "user_rejected",
      "low_confidence_pruned",
      "pending_too_long",
      "decayed",
    ])
    .nullable()
    .default(null),
  // Lifecycle fields. All optional + .default() so a persisted legacy fact
  // round-trips with no migration.
  // stability class: permanent = identity/constraints; durable = working-style/
  // general prefs (the safe default); time-bound = anything with a temporal expr.
  stability: z.enum(["permanent", "durable", "time-bound"]).default("durable"),
  // provenance: which stream produced this fact + the originating session (structured).
  // "user" — typed directly by the user via the /memory NL-edit composer.
  learned_from: z
    .object({
      stream: z.enum(["chat", "critique", "dismissal", "remember", "user", "commit"]),
      session_id: z.string().nullable(),
    })
    .nullable()
    .default(null),
  // Communication-style vs personal-profile classification.
  // The Brain/critic recall injects ONLY kind:"style" facts (language / depth /
  // tone); profile facts (boyfriend, color, pets) stay chat-only — noise for a
  // code review. `.optional()` (not a required default) so the many existing fact
  // literals across the codebase round-trip untouched; an untagged fact (null /
  // undefined) is NOT injected to the Brain (conservative — never leak profile).
  // Seeded once by classifyFactKind (src/memory/recall.ts).
  kind: z.enum(["style", "profile"]).nullable().optional(),
  // Entity model (keystone) — the named entities this fact is about. `.optional()`
  // (NOT .default) so the many existing Fact literals round-trip untouched, exactly
  // like `kind`. Empty / absent = untagged (the consolidate janitor backfills it).
  // `type` is reserved for later bridge/star-map layers; grouping uses name only.
  entities: z.array(entityRefSchema).optional(),
  // ISO; set when a fact is approved / reconfirmed (staleness checks read this).
  last_confirmed_at: z.string().nullable().default(null),
  // ISO; set only for time-bound facts (expiry checks read this).
  expires_at: z.string().nullable().default(null),
  // Memory Book (Change A) — free-text "why this was worth saving", from the
  // summarizer's reasoning-before-verdict step. Optional + default null so
  // legacy facts + pre-change summarizer output round-trip with no migration.
  save_reason: z.string().nullable().default(null),
  // Memory Book NL-edit — ISO timestamp stamped when this fact is
  // superseded (recency-wins soft-invalidate); null while the fact is valid.
  // Nullable + .default(null) so legacy facts back-fill to null with no
  // migration (name follows Graphiti).
  invalid_at: z.string().nullable().default(null),
  // Memory Book Action-Log — append-only list of state transitions.
  // Immutable once written; populated by transition Core fns.
  // Default [] so legacy facts round-trip with no migration.
  events: z.array(factEventSchema).default([]),
});


export const coreMemorySchema = z.object({
  schemaVersion: z.literal(2),
  long_term_summary: z.string(),
  learned_rules: z.array(learnedRuleSchema),
  personality_drift: personalityDriftSchema,
  last_consolidated_at: z.string(),
  consolidation_due_at: z.string(),
  user_profile: userProfileSchema,
  chat_sessions: z.array(chatSessionSchema).default([]),
  facts: z.array(factSchema).default([]),
  // Episodic-fragment capture — the "what happened" layer, kept distinct from
  // the semantic facts[] layer. Default [] so legacy v2 stores round-trip.
  event_fragments: z.array(eventFragmentSchema).default([]),
  // Episode synthesis — day-bucketed narratives over
  // event_fragments[]. Default [] so legacy v2 stores round-trip.
  episodes: z.array(episodeSchema).default([]),
});

export type CoreMemory = z.infer<typeof coreMemorySchema>;
export type LearnedRule = z.infer<typeof learnedRuleSchema>;
export type Goal = z.infer<typeof goalSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type ChatSession = z.infer<typeof chatSessionSchema>;
export type ChatAnchor = z.infer<typeof chatAnchorSchema>;
export type FactEvent = z.infer<typeof factEventSchema>;
export type Fact = z.infer<typeof factSchema>;
export type { EntityRef } from "./entity";
export type { EventFragment } from "./event-fragment";
export type { Episode } from "./episode";

export function newId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

const FILENAME = "memory.json";

function memoryPath(basePath: string): string {
  return join(basePath, FILENAME);
}

export function emptyMemory(): CoreMemory {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    long_term_summary: "",
    learned_rules: [],
    personality_drift: {
      snark: 0,
      patience: 0,
      style_strictness: 0,
      proactivity: 0,
    },
    last_consolidated_at: now,
    consolidation_due_at: now,
    user_profile: {
      communication_style: "neutral",
      goals: [],
      constraints: [],
      prefs: {},
    },
    chat_sessions: [],
    facts: [],
    event_fragments: [],
    episodes: [],
  };
}

function globalJsonPath(basePath: string): string {
  return join(basePath, "global.json");
}

/**
 * Compat shim — v3-aware readMemory.
 *
 * When v3 layout is present (`<basePath>/global.json` exists), merge global
 * + per-project (resolved via `projectCwd`, defaulting to process.cwd() when
 * omitted) into the v2 `CoreMemory` shape that all earlier callers
 * expect. Otherwise fall through to the legacy v2 read path.
 *
 * `projectCwd` — HIGH-finding fix: the long-lived daemon's process.cwd() is
 * frozen at launch, so daemon-side callers responding to a SPECIFIC repo's
 * event (Stop-hook critic, consolidate) must pass that repo's cwd explicitly
 * instead of relying on the daemon's own cwd. Omitted = today's behavior,
 * unchanged (process.cwd()).
 *
 * Dynamic imports break the static cycle (memory.ts ↔ schema-v3.ts).
 */
export async function readMemory(
  basePath: string,
  projectCwd?: string,
): Promise<CoreMemory | null> {
  if (existsSync(globalJsonPath(basePath))) {
    return await readMemoryV3Merged(basePath, projectCwd);
  }
  const path = memoryPath(basePath);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    const raw = await readFile(path, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCorrupt(path);
    return null;
  }
  const result = coreMemorySchema.safeParse(parsed);
  if (!result.success) {
    await quarantineCorrupt(path);
    return null;
  }
  return result.data;
}

/**
 * Compat shim — v3-aware writeMemory.
 *
 * When v3 layout is present, split the v2-shaped `memory` into global +
 * per-project slices per the v3 field assignment and write both
 * atomically. Otherwise fall through to the legacy v2 write path.
 */
export async function writeMemory(
  basePath: string,
  memory: CoreMemory,
  projectCwd?: string,
): Promise<void> {
  if (existsSync(globalJsonPath(basePath))) {
    await writeMemoryV3Split(basePath, memory, projectCwd);
    return;
  }
  try {
    await mkdir(basePath, { recursive: true });
    const finalPath = memoryPath(basePath);
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmpPath, JSON.stringify(memory, null, 2), "utf8");
    await rename(tmpPath, finalPath);
  } catch {
    // never crash the caller
  }
}

async function readMemoryV3Merged(
  basePath: string,
  projectCwd?: string,
): Promise<CoreMemory | null> {
  const { readGlobal, emptyGlobal } = await import("./global");
  const { resolveProjectRoot, readProject, emptyProject } = await import("./project");
  const global = (await readGlobal(basePath)) ?? emptyGlobal();
  const resolved = resolveProjectRoot(projectCwd ?? process.cwd());
  const project = (await readProject(basePath, resolved.project_id)) ?? emptyProject(resolved);

  const communication_style =
    project.user_profile_override.communication_style ??
    global.user_profile.communication_style;

  const merged: CoreMemory = {
    schemaVersion: 2,
    long_term_summary: project.long_term_summary,
    learned_rules: project.learned_rules,
    personality_drift: {
      snark: project.personality_drift.snark,
      patience: project.personality_drift.patience,
      style_strictness: project.personality_drift.style_strictness,
      proactivity: project.personality_drift.proactivity,
    },
    last_consolidated_at: project.last_consolidated_at,
    consolidation_due_at: project.consolidation_due_at,
    user_profile: {
      name: global.user_profile.name,
      communication_style,
      goals: project.user_profile_override.goals,
      constraints: project.user_profile_override.constraints,
      prefs: project.user_profile_override.prefs,
    },
    chat_sessions: project.chat_sessions,
    facts: project.facts,
    event_fragments: project.event_fragments,
    episodes: project.episodes,
  };
  return merged;
}

async function writeMemoryV3Split(
  basePath: string,
  memory: CoreMemory,
  projectCwd?: string,
): Promise<void> {
  const { readGlobal, writeGlobal, emptyGlobal } = await import("./global");
  const { resolveProjectRoot, readProject, writeProject, emptyProject } = await import("./project");

  const existingGlobal = (await readGlobal(basePath)) ?? emptyGlobal();
  const resolved = resolveProjectRoot(projectCwd ?? process.cwd());
  const existingProject =
    (await readProject(basePath, resolved.project_id)) ?? emptyProject(resolved);

  const updatedGlobal = {
    ...existingGlobal,
    user_profile: {
      name: memory.user_profile.name ?? existingGlobal.user_profile.name,
      communication_style: memory.user_profile.communication_style,
    },
  };
  const updatedProject = {
    ...existingProject,
    long_term_summary: memory.long_term_summary,
    learned_rules: memory.learned_rules,
    personality_drift: {
      ...existingProject.personality_drift,
      snark: memory.personality_drift.snark,
      patience: memory.personality_drift.patience,
      style_strictness: memory.personality_drift.style_strictness,
      proactivity: memory.personality_drift.proactivity,
    },
    last_consolidated_at: memory.last_consolidated_at,
    consolidation_due_at: memory.consolidation_due_at,
    chat_sessions: memory.chat_sessions,
    facts: memory.facts,
    event_fragments: memory.event_fragments,
    episodes: memory.episodes,
    user_profile_override: {
      ...existingProject.user_profile_override,
      goals: memory.user_profile.goals,
      constraints: memory.user_profile.constraints,
      prefs: memory.user_profile.prefs,
    },
  };

  await writeGlobal(basePath, updatedGlobal);
  await writeProject(basePath, resolved.project_id, updatedProject);
}

export interface AppendRuleResult {
  appended: boolean;
  reason?: "duplicate";
  rule_id?: string;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function appendLearnedRule(
  basePath: string,
  rule: LearnedRule,
): Promise<AppendRuleResult> {
  const existing = (await readMemory(basePath)) ?? emptyMemory();
  const nCategory = normalize(rule.category);
  const nText = normalize(rule.rule);
  const dup = existing.learned_rules.find(
    (r) => normalize(r.category) === nCategory && normalize(r.rule) === nText,
  );
  if (dup) return { appended: false, reason: "duplicate", rule_id: dup.id };

  const updated: CoreMemory = {
    ...existing,
    learned_rules: [...existing.learned_rules, rule],
  };
  await writeMemory(basePath, updated);
  return { appended: true, rule_id: rule.id };
}

export interface RemoveRuleResult {
  removed: boolean;
  /** When removed = false, the reason: "not_found" (no rule with that id) or "no_memory" (memory.json doesn't exist). */
  reason?: "not_found" | "no_memory";
}

/**
 * v1.1-J — remove a learned_rule from memory.json by its id. Used by
 * `/siltpoke-undismiss` to roll back a rule auto-generated by a
 * dismissal. Atomic read-modify-write.
 *
 * Returns `{ removed: true }` if a rule was filtered, `{ removed:
 * false, reason }` otherwise. Never throws on missing memory file —
 * surfaces the reason in the result.
 */
export async function removeLearnedRuleById(
  basePath: string,
  rule_id: string,
): Promise<RemoveRuleResult> {
  const existing = await readMemory(basePath);
  if (existing === null) return { removed: false, reason: "no_memory" };
  const before = existing.learned_rules.length;
  const filtered = existing.learned_rules.filter((r) => r.id !== rule_id);
  if (filtered.length === before) return { removed: false, reason: "not_found" };
  const updated: CoreMemory = { ...existing, learned_rules: filtered };
  await writeMemory(basePath, updated);
  return { removed: true };
}

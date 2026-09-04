// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { quarantineCorrupt } from "../utils/quarantine";
import { entityRefSchema } from "./entity";
import { type Episode, episodeSchema } from "./episode";
import { type EventFragment, eventFragmentSchema } from "./event-fragment";
import type { GlobalMemory } from "./schema-v3";

export const learnedRuleSchema = z.object({
  id: z.string(),
  // [hardening] Control 2 (2026-07-13, amended same day): NO length cap here
  // deliberately — this is the READ schema, parsed over the WHOLE persisted
  // memory.json by `readMemory`/`readProject`. On ANY field failing
  // `safeParse` those callers quarantine (rename + drop) the ENTIRE file and
  // return an empty memory. A `.max(200)` here would reject legacy rules
  // written before this cap existed and silently wipe a real user's whole
  // memory store (learned_rules, summary, personality drift, chat sessions,
  // facts, episodes) on their first post-upgrade run — see
  // tests/memory/memory.test.ts and tests/memory/project.test.ts
  // "[hardening][regression]" cases. The 200-char security property is
  // enforced at the WRITE boundary instead, where it belongs and where it
  // cannot be bypassed by a future writer: `reflectionOutputSchema.learned_rule`
  // (src/brain/reflection-schema.ts) caps the LLM-output path, and
  // `sanitizeRuleText`/`appendLearnedRule` below re-cap + strip structural
  // tokens for every writer regardless of how the `LearnedRule` was built. No
  // rule created from now on can exceed 200 chars; this field just has to be
  // able to LOAD whatever is already on disk.
  rule: z.string(),
  category: z.string(),
  created_at: z.string(),
  last_triggered_at: z.string().optional(),
  applied_count: z.number().int().nonnegative(),
  effectiveness: z.enum(["good", "neutral", "retired"]).default("neutral"),
  source: z.string().optional(),
  // [hardening] Control 5 (2026-07-13, dismiss.ts bug fix): threaded from
  // `ReflectionOutput.applies_to_file_types` (src/brain/reflection-schema.ts)
  // onto the persisted rule so `rule-selector.ts`'s `isUniversal()` scopes it
  // correctly instead of every dismiss-created rule silently defaulting to
  // universal (applies to every file type, every review, forever) by
  // omission. `.optional()` (no `.default([])`) — additive, zero migration:
  // an existing persisted rule without this field round-trips unchanged and
  // is still treated as universal by `rule-selector.ts` (same as today).
  applies_to_file_types: z.array(z.string()).optional(),
  // Build-1 auto-writer (2026-07-15): confidence is now STORED, not a write
  // gate. The dismiss.ts gate that dropped sub-"high" rules is removed;
  // confidence instead RANKS rules at read time (rule-selector.ts). Additive,
  // zero migration — `.optional()` with no `.default()`: a legacy rule lacking
  // the field round-trips unchanged and is treated as "medium" by the selector
  // (same rationale as the Control-5 applies_to_file_types addition above).
  confidence: z.enum(["high", "medium", "low"]).optional(),
  // Build-2 (2026-07-15): read-only provenance — how the rule was learned.
  // "dismissed" = negative path (Build 1), "acted_on" = positive path (Build 2).
  // NOT consulted by rule-selector.ts; additive, zero migration (.optional(), no .default()).
  origin: z.enum(["dismissed", "acted_on"]).optional(),
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
  // Anchor variant. "node" (default) = repo-graph node anchor (existing
  // behavior; node_id is a canonical graph id, fingerprint tracks the file).
  // "critique" = pinned to a fired critique; node_id holds the critique id,
  // fingerprint is null (critiques are immutable append-only files — no stale
  // check). Additive + defaulted → legacy anchors round-trip as "node".
  kind: z.enum(["node", "critique"]).default("node"),
  // Set only for kind:"critique"; mirrors node_id for that variant. null for
  // node anchors. Additive + defaulted → zero migration.
  critique_id: z.string().nullable().default(null),
});

/**
 * Shared literal for the "this is a plain graph-node anchor" pair of fields
 * (`kind: "node", critique_id: null`). DRY: this exact pair was duplicated
 * verbatim at every `ChatAnchor` node-anchor construction site (3 in
 * src/daemon/routes/chat.ts, 3 in tests/chat/sessions.test.ts). Spread it in
 * (`...NODE_ANCHOR_DEFAULTS`) rather than repeating the literal.
 */
export const NODE_ANCHOR_DEFAULTS = { kind: "node", critique_id: null } as const;

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

/**
 * The global/project routing boundary for facts. User-level facts —
 * communication `style` (language/tone/depth) and personal `profile`
 * (name/partner/pets) — live in the cwd-independent global store so they
 * survive across repos and under launchd (daemon cwd=`/`). Untagged
 * (`null`/`undefined`) facts stay in the per-project slice.
 *
 * Single source of truth for the partition in `writeMemoryV3Split`, the
 * merge in `readMemoryV3Merged`, and the T2 migration sweep — keep every
 * boundary decision here so the two halves stay exact complements.
 */
export function isGlobalFact(f: Fact): boolean {
  return f.kind === "style" || f.kind === "profile";
}

export type { EntityRef } from "./entity";
export type { Episode } from "./episode";
export type { EventFragment } from "./event-fragment";

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
 * Sentinel for the "no project context" memory scope (T3 — daemon launchd
 * env-hardening). The machine-global daemon (cwd=`/` under launchd) has no
 * single correct project cwd; a request that carries no project signal (the
 * facts API, an un-anchored chat) must read/write the cwd-independent GLOBAL
 * store — NEVER resolve `process.cwd()`, which under launchd is `/` and hashes
 * to an empty `/`-slice (the 0-facts bug).
 *
 * A `unique symbol` (not a string) so it can never collide with a real
 * filesystem path passed as `projectCwd`. Three-way `projectCwd` meaning across
 * readMemory / writeMemory / readMemoryV3Merged / writeMemoryV3Split:
 *   - `undefined`     → `process.cwd()` (UNCHANGED — every CLI caller relies on this).
 *   - `GLOBAL_ONLY`   → the global store only; NO project slice read or written.
 *   - `"<path>"` str  → that project (unchanged).
 */
export const GLOBAL_ONLY: unique symbol = Symbol("global-only");

/** The `projectCwd` argument type shared by the memory read/write surface. */
export type ProjectScope = string | typeof GLOBAL_ONLY;

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
 * unchanged (process.cwd()). `GLOBAL_ONLY` (T3) = the cwd-independent global
 * store only, no project slice — for requests with no project signal.
 *
 * Dynamic imports break the static cycle (memory.ts ↔ schema-v3.ts).
 */
export async function readMemory(
  basePath: string,
  projectCwd?: ProjectScope,
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
  projectCwd?: ProjectScope,
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
  projectCwd?: ProjectScope,
): Promise<CoreMemory | null> {
  const { readGlobal, emptyGlobal } = await import("./global");
  const global = (await readGlobal(basePath)) ?? emptyGlobal();

  // GLOBAL_ONLY (T3): the request carries no project signal (facts API,
  // un-anchored chat). Return the cwd-independent global store with NO project
  // slice merged — process.cwd() is deliberately never resolved (it is `/`
  // under launchd → an empty `/`-hash slice). Every project-scoped field
  // (learned_rules, chat_sessions, event_fragments, episodes, goals/constraints)
  // comes back empty by construction, so no `/` slice can leak in.
  if (projectCwd === GLOBAL_ONLY) {
    // Reuse emptyMemory() for the project-scoped fields (all empty by
    // construction — no `/` slice can leak) and overlay the cwd-independent
    // global identity + facts. Avoids hand-syncing a second "empty" literal.
    const base = emptyMemory();
    return {
      ...base,
      user_profile: {
        ...base.user_profile,
        name: global.user_profile.name,
        communication_style: global.user_profile.communication_style,
      },
      facts: dedupeFactsById([...global.facts]),
    };
  }

  const { resolveProjectRoot, readProject, emptyProject } = await import("./project");
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
    // User-level facts live in the global store (kind "style" | "profile");
    // untagged facts stay project-scoped. Merge both, dedupe by id (global
    // wins on collision — it's the canonical store post-migration).
    facts: dedupeFactsById([...global.facts, ...project.facts]),
    event_fragments: project.event_fragments,
    episodes: project.episodes,
  };
  return merged;
}

/**
 * The global-slice `user_profile` projection — identical in both the
 * GLOBAL_ONLY and the normal write branch. Keeps `name` sticky (a write that
 * omits it doesn't blank the existing global name).
 */
function globalUserProfilePatch(
  memory: CoreMemory,
  existingGlobal: GlobalMemory,
): GlobalMemory["user_profile"] {
  return {
    name: memory.user_profile.name ?? existingGlobal.user_profile.name,
    communication_style: memory.user_profile.communication_style,
  };
}

async function writeMemoryV3Split(
  basePath: string,
  memory: CoreMemory,
  projectCwd?: ProjectScope,
): Promise<void> {
  const { readGlobal, writeGlobal, emptyGlobal } = await import("./global");

  const existingGlobal = (await readGlobal(basePath)) ?? emptyGlobal();

  // GLOBAL_ONLY (T3): persist ONLY the global store (user_profile + facts).
  // writeProject is NEVER called — a request with no project (facts API /
  // un-anchored chat) must not rewrite or wipe an arbitrary project slice (the
  // `/`-hash slice under launchd). This is the branch the T1 guard note in this
  // function calls for.
  //
  // GLOBAL_ONLY means "no project target" → EVERY fact goes to global, none is
  // dropped. Facts are born with kind:null (addFactCore / captureChatFactCore),
  // and classifyFactKind is only run by ensureFactKinds at startup over
  // already-persisted facts — which never sees a fact dropped before it is
  // persisted. So we classify born-null facts HERE (idempotent: keeps an
  // existing style/profile kind) so a freshly `记住`-ed or dashboard-added fact
  // both survives AND is correctly typed for critic injection. (Fixes the T3
  // data-loss the review caught: the old `.filter(isGlobalFact)` silently
  // discarded every born-null user fact on the un-anchored path.)
  if (projectCwd === GLOBAL_ONLY) {
    const { classifyFactKind } = await import("./recall");
    const classifiedFacts = memory.facts.map((f) =>
      f.kind ? f : { ...f, kind: classifyFactKind(f.text) },
    );
    const updatedGlobal = {
      ...existingGlobal,
      user_profile: globalUserProfilePatch(memory, existingGlobal),
      facts: dedupeFactsById(classifiedFacts),
    };
    await writeGlobal(basePath, updatedGlobal);
    return;
  }

  const { resolveProjectRoot, readProject, writeProject, emptyProject } = await import("./project");
  const resolved = resolveProjectRoot(projectCwd ?? process.cwd());
  const existingProject =
    (await readProject(basePath, resolved.project_id)) ?? emptyProject(resolved);

  // Partition facts by kind via isGlobalFact (single source of truth): user-level
  // facts (style/profile) go to the cwd-independent global store; untagged
  // (null/undefined) facts stay in the per-project slice. The two filters are
  // exact complements. Mirrors the merge in readMemoryV3Merged.
  const globalFacts = memory.facts.filter(isGlobalFact);
  const projectFacts = memory.facts.filter((f) => !isGlobalFact(f));

  const updatedGlobal = {
    ...existingGlobal,
    user_profile: globalUserProfilePatch(memory, existingGlobal),
    // WHOLESALE REPLACE (not merge): global.facts is fully overwritten from the
    // passed-in memory. Safe under the invariant that every writer first reads
    // via readMemoryV3Merged (which folds existing global facts INTO memory.facts).
    // A caller that builds a CoreMemory without that merged read would blank
    // global facts. T3's GLOBAL_ONLY write path must branch here so a global-only
    // write does not rewrite/wipe the project slice.
    facts: globalFacts,
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
    facts: projectFacts,
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
  reason?: "duplicate" | "garbage";
  rule_id?: string;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Dedupe facts by `id`, keeping the FIRST occurrence. Callers concat
 * `[...global.facts, ...project.facts]` so a global fact wins over a
 * same-id project copy (e.g. mid-migration before the project slice is swept).
 */
export function dedupeFactsById(facts: Fact[]): Fact[] {
  const seen = new Set<string>();
  const out: Fact[] = [];
  for (const f of facts) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

// [hardening] Control 2 (2026-07-13) — the WRITE boundary. The `.max(200)`
// caps on `reflectionOutputSchema.learned_rule` and `learnedRuleSchema.rule`
// only guard callers that route a rule through `.parse()` (the reflection
// LLM call path). `appendLearnedRule` is the ONE place every writer of a
// rule funnels through regardless of how it built the `LearnedRule` object,
// so sanitizing HERE protects every present and future reader — not just
// the reflection path. Strips the exact structural tokens that could let a
// rule text escape its `<core_memory>` fence (`</core_memory>`), forge a
// `<recent_feedback>` block, forge a `<<<TAG:nonce ... TAG:nonce>>>` fence
// boundary (Control 1), or masquerade as a new markdown section header
// (`##...`) — then re-applies the length cap defensively so a caller that
// bypassed schema validation entirely still can't smuggle an oversized rule
// into the critic's highest-trust prompt position.
const STRUCTURAL_TOKEN_RE = /<\/?core_memory>|<\/?recent_feedback>|<<<|>>>/g;
const LEADING_HEADING_RE = /^#{1,6}\s*/gm;
const RULE_TEXT_MAX_LEN = 200;

export function sanitizeRuleText(text: string): string {
  const stripped = text
    .replace(STRUCTURAL_TOKEN_RE, "")
    .replace(LEADING_HEADING_RE, "");
  return stripped.trim().slice(0, RULE_TEXT_MAX_LEN);
}

// Quality gate — distinct from `sanitizeRuleText` (the SECURITY/fence gate).
// Rejects the malformed-rule shapes cogito documented for auto-written memory
// (references/narrative-garbage-detection.md, 2026-07-15): too-short,
// no-action-verb, keyword/category-salad, jargon-cluster. Conservative /
// default-admit: a real user-authored dismiss reason distilled into an
// imperative sentence contains an action verb and passes. The verb check is
// cogito's core signal — a category list ("agent, task, skill") has no verb,
// so patterns 1 (template list) and 4 (jargon cluster) fall out of it too.
const RULE_ACTION_VERBS = [
  "before", "after", "check", "grep", "verify", "confirm", "ensure",
  "avoid", "don't", "dont", "prefer", "use", "read", "look", "flag",
  "skip", "treat", "require", "validate", "match", "scope", "downrank",
  "ignore", "assume", "consider", "distinguish", "separate", "never",
  "always", "add", "remove", "drop", "keep", "run",
  // Added 2026-08-25 after measuring the filter against real rules: these are
  // verbs this repo's own conventions are actually written with, and every one
  // of them was silently rejected. `regenerate` / `measure` / `commit` each
  // killed a rule that was correct, specific and actionable.
  "regenerate", "rebuild", "measure", "commit", "stage", "rename", "replace",
  "delete", "assert", "reproduce", "prove", "cite", "record", "sanitize",
  "normalize", "retry", "pin", "quote", "count",
];

/**
 * Accepted tokens = each stem plus its regular inflections.
 *
 * WHY THIS EXISTS. The check used to be a whole-token match against the stems
 * alone, and English does not cooperate: `read` was accepted and `reads` was
 * not, `add` was accepted and `adding` was not, `check` was accepted and
 * `checking` was not. Measured 2026-08-25 against twelve real rules — SEVEN were
 * rejected, every one of them for phrasing rather than for content
 * (an internal design note
 * holds the before/after). A rule written as a sentence rather than as a bare
 * imperative could not be stored at all, which is not a quality gate, it is a
 * style gate nobody declared.
 *
 * Inflections are DERIVED, not prefix-matched. `startsWith` would have been one
 * line, and it accepts `address` for `add` and `reader` for `read` — widening a
 * filter until it stops discriminating is the failure this file already guards
 * against elsewhere. A bounded, generated set keeps the negative direction
 * intact, which the probe asserts: 0 garbage admitted, before and after.
 *
 * ⚠️ AMENDED SAME DAY, after siltpoke reviewed the first version of this and
 * said: "Consonant+y verbs: 'retry'→'retryed' not 'retried'." Correct, and
 * narrower than the truth — measured, the naive derivation was wrong for THREE
 * regular rules and eleven of the verbs below
 * (an internal design note):
 *
 *   consonant + y   verify → verifies/verified, not verifys/verifyed
 *   final-consonant drop   → dropped/dropping,  not droped/droping
 *   sibilant + s    match  → matches,           not matchs
 *
 * `verified` is the one that stung: the most likely word in a verification rule,
 * still rejected by a fix whose entire purpose was to stop rejecting real rules
 * for their phrasing.
 *
 * ⚠️ THE EXTRA FORMS ARE ADDED UNCONDITIONALLY, and that is deliberate. Modelling
 * English properly needs stress ("prefer" doubles, "consider" does not), and the
 * reference implementation written to measure this defect got THAT wrong in the
 * other direction — it produced `considerred` and `runned`. So this does not try
 * to decide; it emits the union and accepts a few non-words like `afterred`.
 * Over-generating is safe here in a way under-generating is not: a non-word
 * nobody writes can never appear in a rule, so it cannot loosen the check, while
 * a missing real form rejects a real rule. The one genuine cost is a collision —
 * `pin` yields `pined`, which IS a word — and the negative tests are what keep
 * that honest.
 */
const RULE_VERB_TOKENS: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  for (const v of RULE_ACTION_VERBS) {
    out.add(v);
    if (v.includes("'")) continue; // don't / dont take no inflections

    // Naive forms, always.
    out.add(`${v}s`);
    if (v.endsWith("e")) {
      out.add(`${v}d`);
      out.add(`${v.slice(0, -1)}ing`);
    } else {
      out.add(`${v}ed`);
      out.add(`${v}ing`);
    }

    // …plus the three regular rules the naive forms miss. Added UNCONDITIONALLY
    // rather than as an if/else — see the note above on why over-generating is
    // the safe direction.
    out.add(`${v}es`); // match → matches, distinguish → distinguishes
    if (v.endsWith("y")) {
      out.add(`${v.slice(0, -1)}ies`); // verify → verifies, retry → retries
      out.add(`${v.slice(0, -1)}ied`); // verify → verified, retry → retried
    }
    const last = v[v.length - 1];
    if (last !== undefined && !"aeiouwxy".includes(last)) {
      out.add(`${v}${last}ed`); // drop → dropped, commit → committed
      out.add(`${v}${last}ing`); // drop → dropping, pin → pinning
    }
  }
  return out;
})();

const RULE_MIN_CHARS = 20;
const RULE_MIN_WORDS = 4;

export function isGarbageRule(text: string): boolean {
  const t = text.trim();
  if (t.length < RULE_MIN_CHARS) return true; // pattern 3: extremely brief
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < RULE_MIN_WORDS) return true; // pattern 3: too few words
  // Normalize punctuation to spaces (keep apostrophes for "don't") so a token
  // like "grep," matches the verb "grep".
  const normalized = t.toLowerCase().replace(/[^a-z']+/g, " ");
  const hasVerb = normalized.split(" ").some((w) => w.length > 0 && RULE_VERB_TOKENS.has(w));
  if (!hasVerb) return true; // patterns 1, 2, 4: no directive verb
  return false;
}

export async function appendLearnedRule(
  basePath: string,
  rule: LearnedRule,
): Promise<AppendRuleResult> {
  const sanitized: LearnedRule = { ...rule, rule: sanitizeRuleText(rule.rule) };
  if (isGarbageRule(sanitized.rule)) {
    return { appended: false, reason: "garbage" };
  }
  const existing = (await readMemory(basePath)) ?? emptyMemory();
  const nCategory = normalize(sanitized.category);
  const nText = normalize(sanitized.rule);
  const dup = existing.learned_rules.find(
    (r) => normalize(r.category) === nCategory && normalize(r.rule) === nText,
  );
  if (dup) return { appended: false, reason: "duplicate", rule_id: dup.id };

  const updated: CoreMemory = {
    ...existing,
    learned_rules: [...existing.learned_rules, sanitized],
  };
  await writeMemory(basePath, updated);
  return { appended: true, rule_id: sanitized.id };
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

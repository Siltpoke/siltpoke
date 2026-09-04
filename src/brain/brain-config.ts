// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Single-brain config source-of-truth (single-brain identity #10, S1).
 *
 * Replaces the ad-hoc `reviewer_provider` readers (provider-select.ts +
 * doctor's duplicate) with ONE shape: three task-typed roles (chat/review/
 * extract), each `{ provider, model? }`, with an unset role falling back to
 * `main`. A pure `parseBrainConfig` holds all narrowing/fallback/back-compat;
 * the async + sync loaders are thin IO around it (house config idiom,
 * the config loaders throughout this repo — default on ANY throw, never
 * propagate. `src/config/review-unit-config.ts:26-38` is the current example;
 * the one this line used to cite, `trigger-modes.ts`, was deleted in S5 of the
 * review-trigger-unit track.
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ProviderFamily = "claude" | "codex" | "agy" | "qoder" | "codebuddy";
export type BrainRole = "chat" | "review" | "extract";

export interface RoleConfig {
  provider: ProviderFamily;
  model?: string;
}

/** One per-builder review rule (Brain select v2): when code built by this
 * builder family is reviewed, use `provider` (absent → the builder itself) and,
 * ONLY when the resolved reviewer is claude, `model`. */
export interface ReviewByBuilderEntry {
  provider?: ProviderFamily;
  model?: string;
}

export interface BrainConfig {
  main: ProviderFamily;
  authorFamily: ProviderFamily;
  /** Always fully populated — every role resolved (explicit, alias, or main fallback). */
  roles: Record<BrainRole, RoleConfig>;
  /** Per-builder review overrides (Brain select v2), keyed by builder family.
   * Absent → same behavior as before. Cleaned/validated at parse time. */
  review_by_builder?: Partial<Record<ProviderFamily, ReviewByBuilderEntry>>;
}

export interface BrainConfigEnv {
  /** process.env.SILTPOKE_REVIEWER_PROVIDER — back-compat review override for tests/smoke. */
  reviewerProvider?: string;
  /**
   * The family of the CLI host that actually built the code this run (Slice A, T1).
   * Resolved from SILTPOKE_HOST (+ CC-fork detection). When set to a known family,
   * the `review` role defaults to it (the builder reviews its own work) instead of
   * the hard `main` fallback, and it becomes the recorded `authorFamily`. Absent /
   * unknown -> no effect (host=claude or unresolved -> main fallback, zero regression).
   */
  hostFamily?: string;
}

export const FAMILIES: readonly ProviderFamily[] = ["claude", "codex", "agy", "qoder", "codebuddy"];

function asFamily(value: unknown): ProviderFamily | undefined {
  return typeof value === "string" && (FAMILIES as readonly string[]).includes(value)
    ? (value as ProviderFamily)
    : undefined;
}

/** Narrow a `{ provider, model? }` role object. Unknown/absent provider -> undefined (caller falls back). */
function asRoleConfig(value: unknown): RoleConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const provider = asFamily((value as { provider?: unknown }).provider);
  if (provider === undefined) return undefined;
  const rawModel = (value as { model?: unknown }).model;
  const model = typeof rawModel === "string" && rawModel.length > 0 ? rawModel : undefined;
  return model === undefined ? { provider } : { provider, model };
}

export function parseBrainConfig(raw: string | null, env?: BrainConfigEnv): BrainConfig {
  const reviewByEnv = asFamily(env?.reviewerProvider); // invalid env value -> undefined -> config wins

  let parsed: Record<string, unknown> = {};
  if (raw !== null) {
    try {
      const obj = JSON.parse(raw);
      if (typeof obj === "object" && obj !== null) parsed = obj as Record<string, unknown>;
    } catch {
      // Malformed config -> defaults, never throw (house idiom).
    }
  }

  const brain = (typeof parsed.brain === "object" && parsed.brain !== null
    ? parsed.brain
    : {}) as Record<string, unknown>;
  const rolesRaw = (typeof brain.roles === "object" && brain.roles !== null
    ? brain.roles
    : {}) as Record<string, unknown>;

  const hostFamily = asFamily(env?.hostFamily); // invalid/absent -> undefined -> no effect
  const main = asFamily(brain.main) ?? "claude";
  // Runtime builder identity: the host that actually built this run wins over the
  // config-declared author_family (which is the true builder now). Absent -> config -> claude.
  const authorFamily = hostFamily ?? asFamily(brain.author_family) ?? "claude";
  const fallback: RoleConfig = { provider: main };

  // review precedence: env override > explicit brain.roles.review > reviewer_provider alias
  //   > hostFamily (the builder reviews its own work — Slice A) > main.
  // The top-level `reviewer_model` shorthand pairs with `reviewer_provider`
  // exactly as `brain.roles.review.model` pairs with its `provider`: it only
  // attaches to the alias branch, and the verbose `brain.roles.review` block
  // (parsed by asRoleConfig, model included) wins WHOLESALE over the shorthand
  // pair when present — mirroring how brain.roles.review.provider already beats
  // reviewer_provider. Empty/non-string reviewer_model -> undefined (omitted).
  const reviewAlias = asFamily(parsed.reviewer_provider);
  const rawReviewerModel = parsed.reviewer_model;
  const reviewerModel =
    typeof rawReviewerModel === "string" && rawReviewerModel.length > 0
      ? rawReviewerModel
      : undefined;
  const reviewAliasConfig: RoleConfig | undefined =
    reviewAlias !== undefined
      ? reviewerModel !== undefined
        ? { provider: reviewAlias, model: reviewerModel }
        : { provider: reviewAlias }
      : undefined;
  const hostFamilyConfig: RoleConfig | undefined =
    hostFamily !== undefined ? { provider: hostFamily } : undefined;

  // Per-builder review overrides (Brain select v2). Cleaned into a validated
  // map for read-back, and resolved for THIS run's builder (hostFamily) into a
  // RoleConfig that slots between the reviewer_provider alias and the bare
  // same-family default. The model is honored ONLY when the resolved reviewer
  // is claude (quota families serve an auth-fixed model — a model on them is a
  // silent no-op, dropped here rather than passed downstream).
  const reviewByBuilder = cleanReviewByBuilder(brain.review_by_builder);
  const reviewByBuilderConfig: RoleConfig | undefined = (() => {
    if (hostFamily === undefined) return undefined;
    const entry = reviewByBuilder?.[hostFamily];
    if (entry === undefined) return undefined;
    const provider = entry.provider ?? hostFamily; // absent → the builder reviews itself
    const model = provider === "claude" && entry.model ? entry.model : undefined;
    return model !== undefined ? { provider, model } : { provider };
  })();

  const review: RoleConfig =
    reviewByEnv !== undefined
      ? { provider: reviewByEnv }
      : asRoleConfig(rolesRaw.review) ??
        reviewAliasConfig ??
        reviewByBuilderConfig ??
        hostFamilyConfig ??
        fallback;

  return {
    main,
    authorFamily,
    roles: {
      chat: asRoleConfig(rolesRaw.chat) ?? fallback,
      review,
      extract: asRoleConfig(rolesRaw.extract) ?? fallback,
    },
    ...(reviewByBuilder !== undefined ? { review_by_builder: reviewByBuilder } : {}),
  };
}

/** Validate + narrow a raw `brain.review_by_builder` object: keep only known
 * builder-family keys whose entry has a valid (or absent) provider family, and
 * a string model. Returns undefined when nothing valid remains (so the field
 * is omitted, keeping back-compat identical). */
function cleanReviewByBuilder(
  raw: unknown,
): Partial<Record<ProviderFamily, ReviewByBuilderEntry>> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Partial<Record<ProviderFamily, ReviewByBuilderEntry>> = {};
  let any = false;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const builder = asFamily(key);
    if (builder === undefined || typeof val !== "object" || val === null) continue;
    const v = val as Record<string, unknown>;
    const provider = asFamily(v.provider); // invalid/absent → undefined (same-family)
    const model = typeof v.model === "string" && v.model.length > 0 ? v.model : undefined;
    const entry: ReviewByBuilderEntry = {
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
    };
    out[builder] = entry;
    any = true;
  }
  return any ? out : undefined;
}

function envForRead(): BrainConfigEnv {
  return {
    reviewerProvider: process.env.SILTPOKE_REVIEWER_PROVIDER,
    // SILTPOKE_HOST is exported by the host-specific hook wrappers (e.g.
    // codex-session-start.sh sets =codex). asFamily narrows it; an unknown or
    // absent value (claude host sets none) -> no effect -> main fallback.
    hostFamily: process.env.SILTPOKE_HOST,
  };
}

export async function loadBrainConfig(homeBase: string): Promise<BrainConfig> {
  const path = join(homeBase, "config.json");
  if (!existsSync(path)) return parseBrainConfig(null, envForRead());
  try {
    return parseBrainConfig(await readFile(path, "utf8"), envForRead());
  } catch {
    return parseBrainConfig(null, envForRead());
  }
}

export function loadBrainConfigSync(homeBase: string): BrainConfig {
  const path = join(homeBase, "config.json");
  if (!existsSync(path)) return parseBrainConfig(null, envForRead());
  try {
    return parseBrainConfig(readFileSync(path, "utf8"), envForRead());
  } catch {
    return parseBrainConfig(null, envForRead());
  }
}

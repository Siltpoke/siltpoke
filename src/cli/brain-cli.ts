// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `/siltpoke-brain` — the model-select surface (Slice C / Task 7).
 *
 * Baseline, TTY-free twin of the dashboard settings screen (T8): both read and
 * write the SAME `brain.roles.<role>` block in `~/.siltpoke/config.json`, so
 * there is exactly one source of truth for "which brain reviews my code".
 *
 * Usage (args-driven, never interactive):
 *   siltpoke brain                         -> show the resolved brain per role
 *   siltpoke brain show                    -> same
 *   siltpoke brain set review <family> [model]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBrainConfigSync } from "../brain/brain-config";
import type { BrainRole, ProviderFamily } from "../brain/brain-config";
import { CLAUDE_REVIEW_MODELS, familySupportsModelChoice, resolveRoleMeta } from "../brain/registry";
import { atomicWrite } from "../utils/atomic-write";

export interface BrainCliResult {
  ok: boolean;
  message: string;
}

/** One role's resolved brain + why — the shared data shape the CLI show, the
 * daemon `/api/brain` route, and the dashboard settings screen all render. */
export interface BrainRoleView {
  role: BrainRole;
  family: ProviderFamily;
  /** undefined when the family uses its own CLI account default. */
  model?: string;
  /** why it resolved this way: "pinned here" | "follows builder" | ... */
  source: string;
}

/** One builder family's review rule (Brain select v2): when THIS family built
 * the code, review with `reviewer` (+ model, claude-only). `configured` is false
 * when no explicit `review_by_builder` entry exists (→ same-family default). */
export interface BrainBuilderView {
  builder: ProviderFamily;
  reviewer: ProviderFamily;
  model?: string;
  configured: boolean;
  /** whether this builder's REVIEWER supports a model choice (claude only). */
  reviewerSupportsModel: boolean;
}

export interface BrainView {
  authorFamily: ProviderFamily;
  roles: BrainRoleView[];
  families: readonly ProviderFamily[];
  /** One entry per builder family — the per-builder review overrides (v2). */
  reviewByBuilder: BrainBuilderView[];
  /** Model options offered when the reviewer is claude (v2). */
  claudeModels: readonly string[];
}

// Local validation lists — `asFamily` is intentionally not exported from
// brain-config, and the CLI must reject unknown tokens BEFORE they reach the
// config, so we validate against these literal sets.
const FAMILIES: readonly ProviderFamily[] = ["claude", "codex", "agy", "qoder", "codebuddy"];
const ROLES: readonly BrainRole[] = ["chat", "review", "extract"];

function isFamily(x: string): x is ProviderFamily {
  return (FAMILIES as readonly string[]).includes(x);
}

function isRole(x: string): x is BrainRole {
  return (ROLES as readonly string[]).includes(x);
}

/** The raw config.json object (or {} if absent/corrupt) — provenance the parsed
 * BrainConfig has already collapsed away, needed for the show "source" column. */
function readRawConfig(home: string): Record<string, unknown> {
  const configPath = join(home, "config.json");
  if (!existsSync(configPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * WHY a role resolved to its family — the  the show output must surface
 * (RED ①). Display-only; it mirrors the precedence chain in
 * `brain-config.ts` parseBrainConfig (the routing SoT) without re-deriving the
 * routing decision itself. Order per role must match that function.
 */
function roleSource(raw: Record<string, unknown>, role: BrainRole): string {
  const brain = raw.brain && typeof raw.brain === "object" ? (raw.brain as Record<string, unknown>) : {};
  const roles =
    brain.roles && typeof brain.roles === "object" ? (brain.roles as Record<string, unknown>) : {};
  if (roles[role] && typeof roles[role] === "object") return "pinned here";

  if (role === "review") {
    if (process.env.SILTPOKE_REVIEWER_PROVIDER) return "env override";
    if (typeof raw.reviewer_provider === "string") return "reviewer_provider";
    if (process.env.SILTPOKE_HOST) return "follows builder";
  }
  return "default";
}

/**
 * Print the resolved brain: the builder that authored this run, then each role
 * with its resolved `family · model`. A role with no pinned model shows
 * "(CLI default)" rather than a blank — the CLI account picks the model.
 */
export function brainView(home: string): BrainView {
  const config = loadBrainConfigSync(home);
  const raw = readRawConfig(home);
  const roles: BrainRoleView[] = ROLES.map((role) => {
    const meta = resolveRoleMeta(config, role);
    return { role, family: meta.family, model: meta.model, source: roleSource(raw, role) };
  });
  const rbb = config.review_by_builder ?? {};
  const reviewByBuilder: BrainBuilderView[] = FAMILIES.map((builder) => {
    const entry = rbb[builder];
    const reviewer = entry?.provider ?? builder; // absent → same-family default
    const model = reviewer === "claude" ? entry?.model : undefined;
    return {
      builder,
      reviewer,
      ...(model !== undefined ? { model } : {}),
      configured: entry !== undefined,
      reviewerSupportsModel: familySupportsModelChoice(reviewer),
    };
  });
  return {
    authorFamily: config.authorFamily,
    roles,
    families: FAMILIES,
    reviewByBuilder,
    claudeModels: CLAUDE_REVIEW_MODELS,
  };
}

export function formatBrainShow(home: string): string {
  const view = brainView(home);
  const lines: string[] = [];
  lines.push(`builder (authored the code): ${view.authorFamily}`);
  lines.push("");
  lines.push("brains by role:");
  for (const r of view.roles) {
    const model = r.model ?? "(CLI default)";
    const marker = r.role === "review" ? " ←" : "";
    lines.push(`  ${r.role.padEnd(8)} ${r.family} · ${model}  [${r.source}]${marker}`);
  }
  lines.push("");
  // Per-builder review overrides (v2): only show configured rows to keep the
  // default output quiet; the dashboard renders all five.
  const configured = view.reviewByBuilder.filter((b) => b.configured);
  if (configured.length > 0) {
    lines.push("per-builder review overrides (built by → reviewed by):");
    for (const b of configured) {
      const model = b.model ?? (b.reviewerSupportsModel ? "(CLI default)" : "(set in its own config)");
      lines.push(`  ${b.builder.padEnd(10)} → ${b.reviewer} · ${model}`);
    }
    lines.push("");
  }
  lines.push("set with:  siltpoke brain set review <family> [model]");
  lines.push("      or:  siltpoke brain set-builder <builder> <reviewer> [model]");
  lines.push(`families:  ${FAMILIES.join(" / ")}`);
  return lines.join("\n");
}

/**
 * Merge `brain.roles[role] = { provider, model? }` into config.json, preserving
 * every other key (pet, brain.main, brain.author_family, other roles). Invalid
 * family/role is rejected up front and writes nothing.
 */
export function runBrainSet(
  home: string,
  role: string,
  family: string,
  model?: string,
): BrainCliResult {
  if (!isRole(role)) {
    return { ok: false, message: `unknown role "${role}" — one of: ${ROLES.join(" / ")}` };
  }
  if (!isFamily(family)) {
    return { ok: false, message: `unknown family "${family}" — one of: ${FAMILIES.join(" / ")}` };
  }

  const configPath = join(home, "config.json");
  let prior: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (parsed && typeof parsed === "object") prior = parsed as Record<string, unknown>;
    } catch {
      // Corrupt config: start from {} rather than dying — mirrors configure.ts.
    }
  }

  const priorBrain =
    prior.brain && typeof prior.brain === "object" ? (prior.brain as Record<string, unknown>) : {};
  const priorRoles =
    priorBrain.roles && typeof priorBrain.roles === "object"
      ? (priorBrain.roles as Record<string, unknown>)
      : {};

  const roleConfig =
    model !== undefined && model.length > 0 ? { provider: family, model } : { provider: family };

  const next = {
    ...prior,
    brain: {
      ...priorBrain,
      roles: {
        ...priorRoles,
        [role]: roleConfig,
      },
    },
  };

  atomicWrite(configPath, `${JSON.stringify(next, null, 2)}\n`);
  const modelNote = model && model.length > 0 ? ` · ${model}` : " · (CLI default)";
  return { ok: true, message: `${role} brain set to ${family}${modelNote}` };
}

/**
 * Merge `brain.review_by_builder[builder] = { provider, model? }` into
 * config.json (Brain select v2), preserving every other key. Rejects an unknown
 * builder or reviewer family, and rejects a `model` for a non-claude reviewer —
 * siltpoke only chooses claude's model directly; every other family's model
 * lives in its own CLI config (single source of truth). Writes nothing on any
 * rejection.
 */
export function setReviewByBuilder(
  home: string,
  builder: string,
  reviewer: string,
  model?: string,
): BrainCliResult {
  if (!isFamily(builder)) {
    return { ok: false, message: `unknown builder family "${builder}" — one of: ${FAMILIES.join(" / ")}` };
  }
  if (!isFamily(reviewer)) {
    return { ok: false, message: `unknown reviewer family "${reviewer}" — one of: ${FAMILIES.join(" / ")}` };
  }
  const hasModel = model !== undefined && model.length > 0;
  if (hasModel && !familySupportsModelChoice(reviewer)) {
    return {
      ok: false,
      message: `"${reviewer}"'s review model is set in its own CLI config — only claude's model is chosen here`,
    };
  }

  const configPath = join(home, "config.json");
  let prior: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (parsed && typeof parsed === "object") prior = parsed as Record<string, unknown>;
    } catch {
      // Corrupt config: start from {} rather than dying — mirrors runBrainSet.
    }
  }

  const priorBrain =
    prior.brain && typeof prior.brain === "object" ? (prior.brain as Record<string, unknown>) : {};
  const priorRbb =
    priorBrain.review_by_builder && typeof priorBrain.review_by_builder === "object"
      ? (priorBrain.review_by_builder as Record<string, unknown>)
      : {};

  const entry = hasModel ? { provider: reviewer, model } : { provider: reviewer };
  const next = {
    ...prior,
    brain: {
      ...priorBrain,
      review_by_builder: { ...priorRbb, [builder]: entry },
    },
  };

  atomicWrite(configPath, `${JSON.stringify(next, null, 2)}\n`);
  const modelNote = hasModel ? ` · ${model}` : familySupportsModelChoice(reviewer) ? " · (CLI default)" : " · (set in its own config)";
  return { ok: true, message: `code built by ${builder} → reviewed by ${reviewer}${modelNote}` };
}

/** Dispatch: no verb / "show" -> show; "set <role> <family> [model]" -> global
 * role pin; "set-builder <builder> <reviewer> [model]" -> per-builder override. */
export function runBrainCli(rest: readonly string[], home: string): BrainCliResult {
  const verb = rest[0];

  if (verb === undefined || verb === "show") {
    return { ok: true, message: formatBrainShow(home) };
  }

  if (verb === "set") {
    const [, role, family, model] = rest;
    if (role === undefined || family === undefined) {
      return { ok: false, message: "usage: siltpoke brain set <role> <family> [model]" };
    }
    return runBrainSet(home, role, family, model);
  }

  if (verb === "set-builder") {
    const [, builder, reviewer, model] = rest;
    if (builder === undefined || reviewer === undefined) {
      return { ok: false, message: "usage: siltpoke brain set-builder <builder> <reviewer> [model]" };
    }
    return setReviewByBuilder(home, builder, reviewer, model);
  }

  return {
    ok: false,
    message: `usage: siltpoke brain [show | set <role> <family> [model] | set-builder <builder> <reviewer> [model]] — got "${verb}"`,
  };
}

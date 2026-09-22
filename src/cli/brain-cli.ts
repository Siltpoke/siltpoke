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
import type { BrainRole, ProviderFamily } from "../brain/brain-config";
import { loadBrainConfigSync } from "../brain/brain-config";
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
  /** whether this builder's REVIEWER can be given a model by siltpoke. */
  reviewerSupportsModel: boolean;
  /**
   * True when a global `brain.roles.review` pin outranks this rule, so the row
   * is stored and shown but NOT in effect. Without it, `show` listed overridden
   * rules identically to live ones — a silent mismatch, harder to diagnose than
   * an error (spec brain-select-four-gaps §3.2).
   */
  overriddenByGlobalPin: boolean;
}

export interface BrainView {
  authorFamily: ProviderFamily;
  roles: BrainRoleView[];
  families: readonly ProviderFamily[];
  /** One entry per builder family — the per-builder review overrides (v2). */
  reviewByBuilder: BrainBuilderView[];
  /** Model options offered when the reviewer is claude (v2). */
  claudeModels: readonly string[];
  /**
   * The families siltpoke can hand a model to, derived from each provider's argv
   * (registry `familySupportsModelChoice`). The dashboard hardcoded
   * `family === "claude"` in two `x-show` expressions and its island's send
   * filter, which is a third copy of a rule that was wrong for three of the five
   * families — this field is the one answer all of them read
   * (spec brain-select-four-gaps §3.1).
   */
  modelCapableFamilies: readonly ProviderFamily[];
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
 * WHY a role resolved to its family — the "来源" the show output must surface
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
 * The sources that outrank `review_by_builder`, i.e. that make a configured
 * per-builder rule stored-but-not-running. Straight off the precedence chain in
 * `brain-config.ts` parseBrainConfig:
 *
 *   env override > brain.roles.review > reviewer_provider > review_by_builder > …
 *
 * The first version of the "is it overridden?" check read `brain.roles.review`
 * ALONE, which left `reviewer_provider` and `SILTPOKE_REVIEWER_PROVIDER` — two
 * live, supported ways to pin the reviewer — producing exactly the silent
 * mismatch this feature exists to remove (found in review, 2026-09-12). Every
 * consumer asks THIS function, so the answer cannot differ between surfaces.
 */
const REVIEW_OVERRIDING_SOURCES: readonly string[] = [
  "env override",
  "pinned here",
  "reviewer_provider",
];

/** `null` when nothing outranks the per-builder rules; otherwise the source
 * name, which is also what the surfaces print. */
export function reviewOverrideSource(raw: Record<string, unknown>): string | null {
  const source = roleSource(raw, "review");
  return REVIEW_OVERRIDING_SOURCES.includes(source) ? source : null;
}

/**
 * Whether a role's `source` means somebody explicitly chose this family, as
 * opposed to it falling out of a default. The dashboard select must open on the
 * chosen family in the first case and on "(follow the building agent)" in the
 * second; reading only `"pinned here"` made a `reviewer_provider` pin look
 * unset, and an untouched Save then sent a DELETE that removed a key which was
 * never there — reporting success while the pin stayed (found in review).
 */
export function sourceIsExplicitPin(source: string): boolean {
  return source !== "default" && source !== "follows builder";
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
  // Three sources outrank review_by_builder, not one — see reviewOverrideSource.
  // Read from the RAW config: the resolved role always has a provider, so it
  // cannot tell a pin apart from a default.
  const reviewIsPinned = reviewOverrideSource(raw) !== null;
  const reviewByBuilder: BrainBuilderView[] = FAMILIES.map((builder) => {
    const entry = rbb[builder];
    const reviewer = entry?.provider ?? builder; // absent → same-family default
    // Show the model whenever the reviewer's argv can carry it. This read
    // `reviewer === "claude"` after every writer had moved to the capability
    // check, so a model genuinely stored AND genuinely sent to agy / qoder /
    // codebuddy printed as "(CLI default)" — configured, in effect, and shown
    // as unset (spec brain-select-four-gaps §3.1; found in review).
    const model = familySupportsModelChoice(reviewer) ? entry?.model : undefined;
    return {
      builder,
      reviewer,
      ...(model !== undefined ? { model } : {}),
      configured: entry !== undefined,
      reviewerSupportsModel: familySupportsModelChoice(reviewer),
      // A row nobody configured cannot be overridden — it is the default. The
      // flag was `reviewIsPinned` alone, so with a pin and zero rules the
      // dashboard marked all five untouched rows "overridden" (found in review).
      overriddenByGlobalPin: entry !== undefined && reviewIsPinned,
    };
  });
  return {
    authorFamily: config.authorFamily,
    roles,
    families: FAMILIES,
    reviewByBuilder,
    claudeModels: CLAUDE_REVIEW_MODELS,
    modelCapableFamilies: FAMILIES.filter(familySupportsModelChoice),
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
      const suffix = b.overriddenByGlobalPin ? "   ⚠ OVERRIDDEN by the pinned review brain" : "";
      lines.push(`  ${b.builder.padEnd(10)} → ${b.reviewer} · ${model}${suffix}`);
    }
    if (configured.some((b) => b.overriddenByGlobalPin)) {
      lines.push("  these rules are stored but NOT in effect — run: siltpoke brain unset review");
    }
    lines.push("");
  }
  lines.push("set with:  siltpoke brain set review <family> [model]");
  lines.push("      or:  siltpoke brain set-builder <builder> <reviewer> [model]");
  lines.push("   undo:  siltpoke brain unset <role>   (back to following the building agent)");
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
  // Refuse a model the family's argv cannot carry. This writer had no such check
  // at all, which made POST /api/brain/roles/:role the one way past every guard:
  // setReviewByBuilder refused it and the dashboard hid the control, but the
  // dashboard's half is client-side (role-row.ts drops the field) and the route
  // calls straight into here (spec brain-select-four-gaps §2.5 / AC1 / AC9).
  if (model !== undefined && model.length > 0 && !familySupportsModelChoice(family)) {
    return {
      ok: false,
      message: `"${family}" does not accept a model from siltpoke — its CLI serves the model set in its own config`,
    };
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

/**
 * Remove `brain.roles[role]`, leaving every other key intact — the way back from
 * a global pin. `set review <family>` outranks every per-builder rule, and until
 * 2026-09-12 nothing undid it: a user who pinned one reviewer for everything and
 * later switched to per-agent rules got silence, not an error, because the rules
 * were stored and displayed but never consulted (spec brain-select-four-gaps
 * §3.2). Unsetting a role that has no pin is a no-op success, so this is safe to
 * run blind.
 */
export function runBrainUnset(home: string, role: string): BrainCliResult {
  if (!isRole(role)) {
    return { ok: false, message: `unknown role "${role}" — one of: ${ROLES.join(" / ")}` };
  }

  const configPath = join(home, "config.json");
  if (!existsSync(configPath)) {
    return { ok: true, message: `${role} brain was not pinned — nothing to unset` };
  }
  let prior: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object") prior = parsed as Record<string, unknown>;
  } catch {
    // Corrupt config: nothing to remove, and rewriting it would destroy
    // whatever the user has in there. Report success without touching the file.
    return { ok: true, message: `${role} brain was not pinned — nothing to unset` };
  }

  const priorBrain =
    prior.brain && typeof prior.brain === "object" ? (prior.brain as Record<string, unknown>) : {};
  const priorRoles =
    priorBrain.roles && typeof priorBrain.roles === "object"
      ? (priorBrain.roles as Record<string, unknown>)
      : {};
  if (!(role in priorRoles)) {
    return { ok: true, message: `${role} brain was not pinned — nothing to unset` };
  }

  const { [role]: _removed, ...remainingRoles } = priorRoles;
  const next = {
    ...prior,
    brain: { ...priorBrain, roles: remainingRoles },
  };
  atomicWrite(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return {
    ok: true,
    message: `${role} brain unpinned — it now follows the building agent (and any per-builder rule)`,
  };
}

/** Dispatch: no verb / "show" -> show; "set <role> <family> [model]" -> global
 * role pin; "unset <role>" -> drop that pin; "set-builder <builder> <reviewer>
 * [model]" -> per-builder override. */
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

  if (verb === "unset") {
    const [, role] = rest;
    if (role === undefined) {
      return { ok: false, message: "usage: siltpoke brain unset <role>" };
    }
    return runBrainUnset(home, role);
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
    message: `usage: siltpoke brain [show | set <role> <family> [model] | unset <role> | set-builder <builder> <reviewer> [model]] — got "${verb}"`,
  };
}

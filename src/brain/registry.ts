// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Brain provider registry (single-brain identity #10, S1).
 *
 * ONE place mapping a `ProviderFamily` -> a concrete `ReviewerBrainProvider`,
 * plus that family's per-role default model tier. Generalizes the old
 * `provider-select.ts::providerFor` switch. `resolveRole` turns a parsed
 * `BrainConfig` role into the provider to call + the model to send (config
 * model wins; else the family/role default; else undefined = the CLI's own
 * account default, e.g. qoder rejects a literal "default" so we omit --model).
 */
import type { BrainConfig, BrainRole, ProviderFamily } from "./brain-config";
import { FAMILIES } from "./brain-config";
import { DEFAULT_MODEL } from "./brain";
import { makeClaudeProvider, type ReviewerBrainProvider } from "./provider";
import { makeAgyProvider } from "./providers/agy";
import { makeCodeBuddyProvider, makeQoderProvider } from "./providers/ccfork-reviewer";
import { makeCodexProvider } from "./providers/codex";

export interface ResolvedRole {
  family: ProviderFamily;
  provider: ReviewerBrainProvider;
  model?: string;
}

/** Pinned snapshot for the invisible extraction + non-streaming chat roles
 * (reproducible memory-extraction; "prefer pinned in production"). review keeps
 * the S1 alias so the critic + doctor review-row stay byte-identical. */
const CLAUDE_PINNED = "claude-haiku-4-5-20251001";

/**
 * Per-family per-role default model. claude pins DEFAULT_MODEL (the undated
 * alias) for review only, so the critic + doctor review-row stay byte-
 * identical to S1; chat/extract pin the dated snapshot (Q1, S2) for
 * reproducibility. The CC-fork/codex/agy families return undefined so the
 * CLI uses its own account default.
 */
export function familyModelDefault(family: ProviderFamily, role: BrainRole): string | undefined {
  if (family !== "claude") return undefined;
  return role === "review" ? DEFAULT_MODEL : CLAUDE_PINNED;
}

/** Whether a family lets the USER pick the review model. Only claude (USD,
 * pinnable via `claude -p --model`). The quota CLIs (codex/agy/qoder/codebuddy)
 * serve an auth-fixed model that is not selectable — so the select surface must
 * NOT offer a model for them (Brain select v2). */
export function familySupportsModelChoice(family: ProviderFamily): boolean {
  return family === "claude";
}

/** Curated claude review-model options for the select surface (Brain select
 * v2). A hand-picked one-family option list — NOT the price-ranked auto-cheapest
 * table Q1 rejected. `DEFAULT_MODEL` (haiku) is the cheapest/default and leads. */
export const CLAUDE_REVIEW_MODELS: readonly string[] = [
  DEFAULT_MODEL, // claude-haiku-4-5 (default, cheapest)
  "claude-sonnet-4-6",
  "claude-opus-4-8",
];

/** 1-indexed line of `export function familyBinary` below — the re-checkable anchor for
 * injected reviewer-external evidence (schema requires a line). Guarded by a drift test. */
export const FAMILY_BINARY_ANCHOR_LINE = 106; // ← set to the real line; the drift test enforces it

export interface ReviewerExternal {
  family: ProviderFamily;
  bin: string;
  title: string;
  evidenceFile: string;
  evidenceLine: number;
  /** A token that must appear ON `evidenceLine` for the citation to be genuine.
   * Consumers scoping this list to a repo (arch-reconcile) check the line's
   * CONTENT, not just that the path exists — otherwise any repo that happens to
   * have a file at `evidenceFile` would satisfy the citation. Kept here, beside
   * the anchor it describes, so the two cannot drift apart. */
  evidenceToken: string;
}

/** The identifier that must sit on `FAMILY_BINARY_ANCHOR_LINE`. */
export const FAMILY_BINARY_ANCHOR_TOKEN = "familyBinary";

/** Reviewer families that spawn an external PATH binary (bin != null), derived
 * mechanically from FAMILIES + familyBinary(). Excludes claude (in-process
 * `claude -p`, always LLM-emitted as its own ext node). The single manifest the
 * arch-graph reconcile pass reads so parameterized-spawn providers (codebuddy /
 * qoder, which share ccfork-reviewer.ts and have no literal call site) still
 * appear. Adding a 6th provider to FAMILIES + familyBinary auto-updates this. */
export function listReviewerExternals(): ReviewerExternal[] {
  const out: ReviewerExternal[] = [];
  for (const family of FAMILIES) {
    const bin = familyBinary(family);
    if (bin === null) continue; // claude
    const title = `${family.charAt(0).toUpperCase()}${family.slice(1)} CLI`;
    out.push({
      family, bin, title,
      evidenceFile: "src/brain/registry.ts",
      evidenceLine: FAMILY_BINARY_ANCHOR_LINE,
      evidenceToken: FAMILY_BINARY_ANCHOR_TOKEN,
    });
  }
  return out;
}

/** Family -> the PATH binary that gates that role. claude runs in-process
 * (claude -p is always present in a Claude Code env) so it has no gate. */
export function familyBinary(family: ProviderFamily): string | null {
  if (family === "codex") return "codex";
  if (family === "agy") return "agy";
  if (family === "qoder") return "qodercli";
  if (family === "codebuddy") return "codebuddy";
  return null; // claude
}

export function providerForFamily(family: ProviderFamily): ReviewerBrainProvider {
  if (family === "codex") return makeCodexProvider();
  if (family === "agy") return makeAgyProvider();
  if (family === "qoder") return makeQoderProvider();
  if (family === "codebuddy") return makeCodeBuddyProvider();
  return makeClaudeProvider();
}

export function resolveRole(config: BrainConfig, role: BrainRole): ResolvedRole {
  const rc = config.roles[role];
  return {
    family: rc.provider,
    provider: providerForFamily(rc.provider),
    model: rc.model ?? familyModelDefault(rc.provider, role),
  };
}

export interface ResolvedRoleMeta {
  family: ProviderFamily;
  model?: string;
}

/** resolveRole's display twin: family + model WITHOUT constructing a provider
 * (doctor's display path must not eagerly spawn adapter factories). */
export function resolveRoleMeta(config: BrainConfig, role: BrainRole): ResolvedRoleMeta {
  const rc = config.roles[role];
  return { family: rc.provider, model: rc.model ?? familyModelDefault(rc.provider, role) };
}

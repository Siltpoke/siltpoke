// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Reviewer-provider selection — now a thin adapter over the single brain
 * config SoT (single-brain identity #10, S1). `loadReviewerProvider` resolves
 * the `review` role from `<homeBase>/config.json` and returns the full
 * resolved role (`{ family, provider, model }`).
 *
 * The `model` field is load-bearing (reviewer_model plumbing, single-brain #10
 * critic half): before this it returned only `.provider`, so the resolved
 * review model was dropped on the floor and the critic could never send a
 * `--model` for the active reviewer_provider. Returning the whole ResolvedRole
 * lets the sole caller (run-critic.ts) thread the model through to the review
 * Brain call.
 *
 * All parsing/fallback/back-compat (`reviewer_provider` alias, `reviewer_model`
 * shorthand, `SILTPOKE_REVIEWER_PROVIDER` env override, default claude) lives in
 * brain-config.ts's `parseBrainConfig`; the family->provider wiring + per-role
 * model default live in registry.ts. Only the critic seam (run-critic.ts) calls
 * this — unchanged allowlist mechanism (AC9); every other Brain consumer still
 * imports brain.ts directly (migrated to roles in S2/S3).
 */
import { loadBrainConfig, type ProviderFamily } from "./brain-config";
import { resolveRole, type ResolvedRole } from "./registry";

/** Retained for existing importers (doctor, tests). */
export type ReviewerProviderName = ProviderFamily;

export async function loadReviewerProvider(homeBase: string): Promise<ResolvedRole> {
  const config = await loadBrainConfig(homeBase);
  return resolveRole(config, "review");
}

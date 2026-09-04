// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchModelDoc, ArchNodeDoc } from "./arch-model-schema";
import { listReviewerExternals, type ReviewerExternal } from "../brain/registry";

/** Lowercased word/identifier tokens from a string (split on non-alphanumerics). */
function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean));
}

/** The container node most likely to BE src/brain (owns the most src/brain/
 * member files). Deterministic; null when nothing qualifies (edge is then
 * skipped fail-soft — never emit an edge to a non-existent node). */
export function resolveBrainContainerId(doc: ArchModelDoc): string | null {
  let bestId: string | null = null;
  let bestCount = 0;
  for (const n of doc.nodes) {
    if (n.kind !== "cont" || !n.members) continue;
    const count = n.members.filter((m) => m.startsWith("src/brain/")).length;
    if (count > bestCount) { bestCount = count; bestId = n.id; }
  }
  return bestCount > 0 ? bestId : null;
}

/** Which reviewer externals a given repo can evidence.
 *
 * `resolved` is the field that matters, and it exists because two states were
 * being collapsed into one: **"this repo is not siltpoke"** and **"I could not
 * work out which repo this is"**. Both produce an empty family set, but only
 * the first justifies DELETING nodes. An unresolved scope suppresses injection
 * (never invent a citation you cannot check) and suppresses the prune (never
 * delete a node because you failed to look), so a model whose `project_root` is
 * missing from meta.json is left exactly as it was found. */
export interface ExternalScope {
  resolved: boolean;
  /** [] whenever `resolved` is false. */
  externals: ReviewerExternal[];
  /** Families of `externals`; membership queries only. */
  families: Set<string>;
}

export const UNRESOLVED_EXTERNAL_SCOPE: ExternalScope = {
  resolved: false,
  externals: [],
  families: new Set(),
};

/** Wrap an explicit external list as a RESOLVED scope. */
export function externalScopeOf(externals: ReviewerExternal[]): ExternalScope {
  return { resolved: true, externals, families: new Set(externals.map((e) => e.family)) };
}

/** True when the repo at `repoRoot` really carries this external's cited evidence.
 *
 * The path existing is not enough. Every entry in the registry cites the same
 * `src/brain/registry.ts`, so a bare `existsSync` is one all-or-nothing check on
 * a filename that another agent/LLM project could plausibly also use — and that
 * repo would then be handed four review CLIs citing a line that says something
 * else entirely, which is the exact unverifiable-citation failure this whole
 * pass exists to stop. So the FILE must also contain the token the citation is
 * about (`evidenceToken`, owned by the registry).
 *
 * The token is looked for anywhere in the file, NOT on `evidenceLine`, and that
 * is deliberate. `evidenceLine` is a constant compiled into the running binary;
 * `repoRoot` is whatever is checked out on disk. The two drift apart for
 * completely ordinary reasons — a branch that adds a few lines above the anchor
 * makes the running daemon disagree with the working tree — and MEASURED here
 * (2026-08-21): with the exact-line rule, siltpoke reading its own cached model
 * from a sibling checkout scored the anchor absent and pruned its own two
 * correct review-CLI nodes. Deleting real data over a line-number skew is worse
 * than the lookalike repo this was tightening against. The exact-line assertion
 * still exists where it can be true — `tests/brain/list-reviewer-externals.test.ts`,
 * against siltpoke's own source. */
function anchorResolves(repoRoot: string, e: ReviewerExternal): boolean {
  const path = join(repoRoot, e.evidenceFile);
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, "utf8").includes(e.evidenceToken);
  } catch {
    return false; // unreadable == unverifiable
  }
}

/** The externals whose evidence anchor actually resolves in `repoRoot`.
 *
 * Registry-declared injection cites siltpoke's OWN `src/brain/registry.ts`,
 * because the parameterized `spawn(bin, ...)` hides those families from the LLM
 * *in this repo*. That premise is siltpoke-specific and was never scoped: every
 * OTHER indexed repo's architecture model got the same four review CLIs
 * injected, each citing a file that repo does not contain, and each adding 3
 * inferred claims to its groundedPct denominator. Measured 2026-08-21: 3 of the
 * 5 cached models on this machine (a travel app, a Supabase app, a GitHub/Redis
 * app) carried all four.
 *
 * Impure (fs) ON PURPOSE so `reconcileReviewerExternals` stays pure: callers
 * resolve the scope here, then hand the reconcile pass plain data. */
export function scopeExternalsToRepo(
  externals: ReviewerExternal[],
  repoRoot: string | null,
): ReviewerExternal[] {
  if (!repoRoot) return [];
  return externals.filter((e) => anchorResolves(repoRoot, e));
}

/** Resolve the reviewer-external scope for the repo rooted at `repoRoot`.
 *
 * Unresolved when the root is null or is not a directory on disk — a moved or
 * deleted checkout must read as "unknown", not as "a repo without these". */
export function resolveExternalScope(repoRoot: string | null): ExternalScope {
  if (!repoRoot || !existsSync(repoRoot)) return UNRESOLVED_EXTERNAL_SCOPE;
  return externalScopeOf(scopeExternalsToRepo(listReviewerExternals(), repoRoot));
}

/** True when a model node is a registry-declared external the repo demonstrably
 * cannot evidence — the shape that must not reach any surface. Always false on
 * an UNRESOLVED scope: not knowing is not grounds for deleting.
 *
 * Deliberately takes `unknown`. The arch model is read from disk by three
 * places, and only one of them parses it into `ArchModelDoc`: the repo card and
 * the repo-summary prompt walk the raw JSON. Sharing ONE predicate is what stops
 * those two from re-deriving the rule and drifting from it — the reason they
 * were still emitting the four review CLIs after the diagram stopped. */
export function isOutOfScopeRegistryNode(node: unknown, scope: ExternalScope): boolean {
  if (!scope.resolved) return false;
  if (!node || typeof node !== "object") return false;
  const n = node as { kind?: unknown; provenance?: unknown; externalFamily?: unknown };
  if (n.kind !== "ext" || n.provenance !== "registry-declared") return false;
  return typeof n.externalFamily !== "string" || !scope.families.has(n.externalFamily);
}

/** True when a raw (unparsed) arch model still carries registry-declared
 * externals the repo cannot evidence — i.e. it was written by a generate that
 * predates the repo scope. Anything DERIVED from such a model and cached
 * separately (the repo-summary blurb) has to be treated as stale, because
 * filtering the model afterwards does not rewrite a paragraph already produced
 * from it. Shares the node predicate, so "polluted" cannot come to mean
 * something different here than it does at the filter. */
export function hasOutOfScopeRegistryNodes(archModel: unknown, scope: ExternalScope): boolean {
  if (!scope.resolved || !archModel || typeof archModel !== "object") return false;
  const nodes = (archModel as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return false;
  return nodes.some((n) => isOutOfScopeRegistryNode(n, scope));
}

/** The reviewer family an existing ext node already covers, or null. Token-EXACT
 * (never substring — `qodercli` must match the `qoder` family via the bin token,
 * and `Qoder` the title must NOT falsely swallow `qodercli`). Signals: node id,
 * title, desc tokens vs {family, bin}; plus a dedicated per-family evidence file
 * `providers/${family}.ts`. Shared `ccfork-reviewer.ts` evidence is ambiguous
 * (codebuddy AND qoder) → not a signal on its own. */
export function matchNodeFamily(node: ArchNodeDoc, externals: ReviewerExternal[]): string | null {
  if (node.kind !== "ext") return null;
  const validFamilies = new Set<string>(externals.map((e) => e.family));
  // 1. Canonical key first — an already-reconciled/enriched node carries externalFamily.
  //    This is what makes a second pass a no-op (idempotency); token matching alone would
  //    miss a node whose title was unhelpful, and re-inject a duplicate.
  if (node.externalFamily && validFamilies.has(node.externalFamily)) return node.externalFamily;

  const bag = new Set<string>([
    ...tokens(node.id),
    ...tokens(node.title.value),
    ...(node.desc ? tokens(node.desc.value) : []),
  ]);
  const evidenceFiles = [
    ...node.title.evidence.map((e) => e.file),
    ...(node.desc?.evidence.map((e) => e.file) ?? []),
  ];
  for (const ext of externals) {
    if (bag.has(ext.family) || bag.has(ext.bin.toLowerCase())) return ext.family;
    if (evidenceFiles.some((f) => f.endsWith(`providers/${ext.family}.ts`))) return ext.family;
  }
  return null;
}

export interface ReconcileResult {
  doc: ArchModelDoc;
  totalClaims: number;
  citedClaims: number;
  groundedPct: number;
  /** False when the prior counts cannot describe the reconciled doc — the
   * subtraction for pruned claims lands below `citedClaims`, which can only
   * happen if the meta was written before those claims existed. The returned
   * counts are then a guess, and callers MUST drop them rather than publish
   * them. Clamping instead produced `cited/cited = 100% grounded` on a model
   * that is mostly inferred, i.e. the exact overstatement this pass exists to
   * remove. */
  countsCoherent: boolean;
}

/** Reconcile the LLM arch model against the reviewer-provider registry: PRUNE
 * registry-declared nodes for families this repo does not carry, enrich+dedup
 * existing provider ext nodes, inject the still-missing families with
 * registry-declared provenance, add a fail-soft brain→node "spawns" edge, and
 * return the doc with grounding counts adjusted so meta/UI stay consistent.
 *
 * `scope` says what this repo can evidence. A RESOLVED-but-empty scope is the
 * foreign-repo case and makes this pass pure cleanup — exactly what an
 * already-polluted cache needs on read. An UNRESOLVED scope makes it a no-op:
 * nothing injected, nothing pruned.
 *
 * Pure + idempotent (a second pass matches the injected nodes and adds nothing,
 * and finds nothing left to prune). */
export function reconcileReviewerExternals(
  doc: ArchModelDoc,
  scope: ExternalScope,
  priorCounts: { totalClaims: number; citedClaims: number },
): ReconcileResult {
  const externals = scope.externals;

  // 0. PRUNE out-of-scope registry-declared nodes. Injection PERSISTS into
  //    arch-model.json, so narrowing the scope is not enough on its own — a
  //    model generated before the scope existed still carries the foreign
  //    nodes and would keep rendering them forever without a paid re-generate.
  //    Only `registry-declared` is ever pruned: an `llm-callsite` node was
  //    found in that repo's real source and is none of this pass's business.
  //    Claims are counted BY TIER, not assumed inferred. Everything injected
  //    today is `tier: "inferred"`, but nothing in the type system says a
  //    registry-declared claim must be — and charging a dropped CITED claim to
  //    the denominator alone would leave the numerator counting a claim that is
  //    no longer in the document, inflating groundedPct in the same direction
  //    this pass is meant to correct.
  let prunedClaims = 0; // COUNTED from what is actually dropped, mirroring injection.
  let prunedCited = 0;
  const chargeClaim = (c: { tier?: string } | undefined): void => {
    if (!c) return;
    prunedClaims += 1;
    if (c.tier === "cited") prunedCited += 1;
  };
  const dropped = new Set<string>();
  const kept = doc.nodes.filter((n) => {
    if (!isOutOfScopeRegistryNode(n, scope)) return true;
    dropped.add(n.id);
    chargeClaim(n.title);
    chargeClaim(n.band);
    chargeClaim(n.desc);
    return false;
  });
  const survivingEdges = doc.edges.filter((e) => {
    const touchesDropped = dropped.has(e.source) || dropped.has(e.target);
    if (touchesDropped) chargeClaim(e.verb);
    return !touchesDropped;
  });

  const nodes = kept.map((n) => ({ ...n }));
  const edges = [...survivingEdges];
  const covered = new Set<string>();

  // 1. Enrich + record coverage of existing provider ext nodes.
  for (const n of nodes) {
    const fam = matchNodeFamily(n, externals);
    if (!fam) continue;
    covered.add(fam);
    n.externalFamily = fam;
    if (!n.provenance) n.provenance = "llm-callsite";
  }

  const brainId = resolveBrainContainerId(doc);
  let injectedClaims = 0; // COUNTED from the objects actually built, not a hardcoded literal.

  // 2. Additive inject the missing families.
  for (const ext of externals) {
    if (covered.has(ext.family)) continue;
    // evidenceItem schema REQUIRES `line` — use the re-checkable anchor, never omit it.
    const ev = [{ file: ext.evidenceFile, line: ext.evidenceLine }];
    const node: ArchNodeDoc = {
      id: `${ext.family}-ext`,
      kind: "ext" as const,
      title: { value: ext.title, evidence: ev, tier: "inferred" as const },
      band: { value: "external", evidence: ev, tier: "inferred" as const },
      desc: {
        value: "External review CLI (registry-declared; reachability unverified)",
        evidence: ev, tier: "inferred" as const,
      },
      externalFamily: ext.family,
      provenance: "registry-declared" as const,
    };
    nodes.push(node);
    // Count claim() fields actually present (title, band, desc). If desc is ever dropped,
    // this auto-adjusts — no drift from the +3 literal the reviewers flagged.
    injectedClaims += 1 /*title*/ + 1 /*band*/ + (node.desc ? 1 : 0);

    // 3. Fail-soft edge — only when a brain container resolves (else the endpoint would
    //    be missing and validateArchIntegrity would reject the whole doc).
    if (brainId) {
      edges.push({
        source: brainId,
        target: node.id,
        verb: { value: `spawns ${ext.bin} -p`, evidence: ev, tier: "inferred" as const },
        provenance: "registry-declared" as const,
      });
      injectedClaims += 1; // edge verb
    }
  }

  // 4. Recount atomically. Injected claims are always inferred (built above);
  //    pruned claims are charged to whichever side they were on.
  //    Use Math.round to mirror arch-ground.ts pct() EXACTLY so the UI parity assertion holds.
  const citedClaims = priorCounts.citedClaims - prunedCited;
  const totalClaims = priorCounts.totalClaims + injectedClaims - prunedClaims;
  // Coherence, NOT a clamp. A prior meta that never counted the pruned claims
  // drives the total below cited; there is no denominator to recover from that,
  // only one to invent. Report it and let the caller drop the counts — a
  // clamped `cited/cited` renders as a confident 100%.
  const countsCoherent = totalClaims >= citedClaims && citedClaims >= 0;
  const groundedPct =
    countsCoherent && totalClaims > 0 ? Math.round((citedClaims / totalClaims) * 100) : 0;

  return {
    doc: { ...doc, nodes, edges, groundedPct },
    totalClaims,
    citedClaims,
    groundedPct,
    countsCoherent,
  };
}

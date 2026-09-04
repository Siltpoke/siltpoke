// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Generated-model cache + integrity gate.
 *
 * Persists the grounded ArchModelDoc beside the repo-graph artifacts
 * (`<storageDir>/arch-model.json` + `arch-model.meta.json`), reusing the explain
 * cache *lifecycle* (graph-ts + fingerprint invalidation) with a repo-scope key.
 *
 * Three states, mirroring explain:
 *   fresh — file exists, fingerprint + graph-ts match → cache hit (0 Brain).
 *   stale — file exists but a fingerprint/graph-ts mismatch → the model is
 *           returned WITH `stale: true` so the UI can offer "re-generate";
 *           the generate path treats it as a miss.
 *   miss  — no file → null.
 *
 * Integrity gate (USE-3): `writeArchModel` validates structural consistency
 * BEFORE writing — a malformed model is rejected as a typed error and NOTHING is
 * persisted (atomic: validated-or-error, no partial). The Zod schema checks
 * shape; this checks semantics (endpoints exist, ids unique, drillTo resolves,
 * each container in exactly one band, node↔band agree).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Fingerprints } from "../repo-graph/types";
import { atomicWrite } from "../utils/atomic-write";
import { reconcileReviewerExternals, resolveExternalScope } from "./arch-reconcile";
import { validateArchDoc, type ArchModelDoc } from "./arch-model-schema";
import { memberToSubdirId, type SubdirsKeyspace } from "./subdir-resolve";

const MODEL_FILE = "arch-model.json";
const META_FILE = "arch-model.meta.json";

export interface ArchModelMeta {
  schemaVersion: 1;
  /** sha256 over all in-scope file content fingerprints. */
  fingerprint: string;
  /** meta.last_indexed_ts at generate time (coarse invalidation). */
  graphIndexedTs: string;
  costUsd: number;
  groundedPct: number;
  model: string;
  generatedTs: string;
  /** END-TO-END generate task wall-clock in ms (registry startedTs → meta write),
   * i.e. Brain call PLUS grounding/sanitize/write — not a Brain-latency metric.
   * Absent on caches predating this field (legacy) — callers must treat as optional and
   * omit the segment gracefully. */
  durationMs?: number;
  /** Grounding counts from GroundResult — written at generate time.
   * Absent on legacy caches predating this field — callers MUST NOT default to 0;
   * treat as absent/undefined and omit the popover line gracefully. */
  citedClaims?: number;
  totalClaims?: number;
  topologyBlindClaims?: number;
}

export function archModelPath(storageDir: string): string {
  return join(storageDir, MODEL_FILE);
}
export function archMetaPath(storageDir: string): string {
  return join(storageDir, META_FILE);
}

/** Deterministic repo-scope fingerprint: sha256 over sorted `path:sha` lines. */
export function computeRepoFingerprint(fp: Fingerprints): string {
  // JSON-encode the (path, sha) pair so a `:` in a path can't collapse with the
  // separator and alias two different files. Sorted → order-independent.
  const lines = Object.entries(fp.files)
    .map(([path, f]) => JSON.stringify([path, f.content_sha256]))
    .sort();
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

export type ArchReadResult = { model: ArchModelDoc; meta: ArchModelMeta; stale: boolean } | null;

/** Read the cached model + classify fresh / stale (or null on miss).
 *
 * `repoRoot` is the analyzed repo's absolute root (`RepoGraphMeta.project_root`),
 * and it SCOPES the reviewer-external reconcile — required, not optional, so a
 * new call site is a compile error rather than a silent mis-scope. Pass null
 * only when the root genuinely cannot be resolved; the pass then fails closed. */
export async function readArchModel(
  storageDir: string,
  curFingerprint: string,
  curGraphIndexedTs: string,
  repoRoot: string | null,
): Promise<ArchReadResult> {
  const mPath = archModelPath(storageDir);
  const metaPath = archMetaPath(storageDir);
  if (!existsSync(mPath) || !existsSync(metaPath)) return null;
  try {
    const [rawModel, rawMeta] = await Promise.all([
      readFile(mPath, "utf8"),
      readFile(metaPath, "utf8"),
    ]);
    const parsed = validateArchDoc(JSON.parse(rawModel));
    if (!parsed.ok) return null; // corrupt/hand-edited model → miss (self-heal)
    const meta = JSON.parse(rawMeta) as ArchModelMeta;
    // Defensive: a meta that parses but lacks its key fields is treated as a
    // miss (self-heal) rather than served — keeps a stale/garbage meta from
    // masquerading as a fresh hit.
    if (typeof meta?.fingerprint !== "string" || typeof meta?.graphIndexedTs !== "string") return null;
    const stale = meta.fingerprint !== curFingerprint || meta.graphIndexedTs !== curGraphIndexedTs;

    // Reconcile against the reviewer-provider registry so EXISTING cached models
    // (predating a registry addition, e.g. codebuddy/qoder) gain the missing
    // external nodes on read — zero paid regenerate. Idempotent: matchNodeFamily's
    // externalFamily-first branch means an already-reconciled cache adds nothing
    // on a second pass.
    // SCOPED to this repo: the registry's evidence anchor is siltpoke's own
    // `src/brain/registry.ts`, so in any other repo the list narrows to [] and
    // this same pass instead PRUNES the nodes an earlier unscoped generate
    // persisted — the read path is what heals the already-written models.
    const hasCounts = typeof meta.totalClaims === "number" && typeof meta.citedClaims === "number";
    const prior = {
      totalClaims: hasCounts ? meta.totalClaims! : 0,
      citedClaims: hasCounts ? meta.citedClaims! : 0,
    };
    const rec = reconcileReviewerExternals(parsed.doc, resolveExternalScope(repoRoot), prior);
    let model = rec.doc;
    let adjustedMeta: ArchModelMeta;
    if (hasCounts && rec.countsCoherent) {
      adjustedMeta = { ...meta, totalClaims: rec.totalClaims, citedClaims: rec.citedClaims, groundedPct: rec.groundedPct };
    } else {
      // Two cases, one honest handling. (a) Legacy meta with NO counts. (b) A
      // meta whose counts predate the pruned claims, so subtracting them lands
      // below citedClaims — the numbers demonstrably do not describe this doc.
      // Either way: keep the counts ABSENT (the popover already degrades
      // gracefully) rather than fabricating a denominator, AND restore the
      // model's own groundedPct — reconcile returns 0 in both cases, which must
      // not clobber a real value. The NODES are still reconciled, so the graph
      // is correct even when the arithmetic about it is not recoverable.
      model = { ...rec.doc, groundedPct: parsed.doc.groundedPct };
      adjustedMeta = { ...meta };
      delete adjustedMeta.totalClaims;
      delete adjustedMeta.citedClaims;
    }
    return { model, meta: adjustedMeta, stale };
  } catch {
    return null;
  }
}

export type IntegrityResult = { ok: true } | { ok: false; error: string };

/**
 * USE-3 integrity gate. Structural-semantic consistency on top of the Zod shape:
 * The gate rejects only RENDER-BREAKING corruption — NOT reasonable LLM variation
 * (live-smoke finding: real models legitimately put an ext node in an "External"
 * band, and guess a `drillTo` that doesn't exactly match a subdir id). Those are
 * SANITIZED (`sanitizeArchModel`), not rejected. Hard checks:
 *  1. edge endpoints exist · 2. node/band ids unique · 3. band members are real
 *  nodes, no CONTAINER spans two bands · 4. every CONTAINER in a band.
 * (ext/person MAY appear in a band — the renderer places them outside regardless.
 * node.band is advisory: the renderer reads band membership from bands[].members,
 * not node.band, so a node.band/membership mismatch is harmless + not checked.)
 */
export function validateArchIntegrity(doc: ArchModelDoc, _validSubdirIds: Set<string>): IntegrityResult {
  // 1. unique ids.
  const nodeIds = new Set<string>();
  const kindById = new Map<string, "cont" | "person" | "ext">();
  for (const n of doc.nodes) {
    if (nodeIds.has(n.id)) return { ok: false, error: `dup node id: ${n.id}` };
    nodeIds.add(n.id);
    kindById.set(n.id, n.kind);
  }
  const bandIds = new Set<string>();
  for (const b of doc.bands) {
    if (bandIds.has(b.id)) return { ok: false, error: `dup band id: ${b.id}` };
    bandIds.add(b.id);
  }
  // 2. edge endpoints exist (else the edge render can't resolve N[s]/N[t]).
  for (const e of doc.edges) {
    if (!nodeIds.has(e.source)) return { ok: false, error: `edge endpoint missing: ${e.source}` };
    if (!nodeIds.has(e.target)) return { ok: false, error: `edge endpoint missing: ${e.target}` };
  }
  // 3. band membership: each member is a real node; no CONTAINER in two bands.
  // (ext/person band membership is allowed — they're laid out outside the bands.)
  const contToBand = new Map<string, string>();
  for (const b of doc.bands) {
    for (const m of b.members) {
      if (!nodeIds.has(m)) return { ok: false, error: `band ${b.id} lists unknown member: ${m}` };
      if (kindById.get(m) !== "cont") continue; // ext/person in a band: ignored, allowed
      if (contToBand.has(m)) return { ok: false, error: `container spans two bands: ${m}` };
      contToBand.set(m, b.id);
    }
  }
  // 4. every CONTAINER sits in exactly one band (else layout leaves it at origin).
  for (const n of doc.nodes) {
    if (n.kind !== "cont") continue;
    if (!contToBand.has(n.id)) return { ok: false, error: `container in no band: ${n.id}` };
  }
  return { ok: true };
}

/**
 * Derive a real subdir id for a container from its grounded `members`: resolve
 * each member file path to its structural subdir id via `memberToSubdirId` (the
 * same `bucketIdOfPath` the structural projection uses — longest-path-prefix over
 * the real projection subdirs). Voting over the resolved ids keeps multi-subdir
 * cohesive containers honest (majority wins). The LLM rarely guesses an exact
 * drillTo, so members resolve it structurally.
 */
function deriveDrillToFromMembers(
  members: string[] | undefined,
  validSubdirIds: Set<string>,
  subdirs: SubdirsKeyspace,
): string | undefined {
  if (!members?.length) return undefined;
  const votes = new Map<string, number>();
  for (const m of members) {
    const sd = memberToSubdirId(m, subdirs); // structural bucketer — same keyspace as the projection
    // Post-migration the `validSubdirIds.has(sd)` check is structurally guaranteed on
    // THIS path: `memberToSubdirId` only ever returns an id already in `subdirs` (the
    // same source as `validSubdirIds`), so a non-null `sd` is always a member. Retained
    // as defense-in-depth (a future resolver edit that broke that invariant would be
    // caught here) and to keep the gate identical to the LLM-raw-drillTo path in
    // `sanitizeArchModel`/`validateArchIntegrity`, where the Set IS load-bearing.
    if (sd && validSubdirIds.has(sd)) votes.set(sd, (votes.get(sd) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [seg, n] of votes) {
    if (n > bestN) {
      best = seg;
      bestN = n;
    }
  }
  return best;
}

/**
 * Sanitize a generated model into a renderable one (run BEFORE the gate + write):
 * resolve each cont's `drillTo` to a real subdir. A drillTo that already names a
 * subdir is kept. One that doesn't (the LLM guesses by name and often misses —
 * "proxy" for "proxy.ts", or a comp-name for a split container) is RE-DERIVED
 * from the container's grounded `members` (V1) so split containers stay drillable;
 * only when nothing resolves is drillTo dropped (container stays, non-drillable).
 * Returns a new doc; never mutates the input.
 */
export function sanitizeArchModel(
  doc: ArchModelDoc,
  validSubdirIds: Set<string>,
  subdirs: SubdirsKeyspace,
): ArchModelDoc {
  const nodes = doc.nodes.map((n) => {
    if (n.kind !== "cont") return n;
    if (n.drillTo && validSubdirIds.has(n.drillTo)) return n; // already valid
    const derived = deriveDrillToFromMembers(n.members, validSubdirIds, subdirs);
    if (derived) return { ...n, drillTo: derived };
    const { drillTo: _drop, ...rest } = n;
    return rest; // unresolvable → non-drillable
  });
  return { ...doc, nodes };
}

/** Per-member-file function counts, computed from
 * the graph for the union of a doc's member paths. ONE implementation for
 * both servers of it (SSR page route + GET /arch/model) so the counting rule
 * can never fork. Missing paths stay 0 (honest). */
export function computeFileFunctions(
  graph: { nodes: ReadonlyArray<{ type: string; path: string }> },
  docNodes: ReadonlyArray<{ members?: string[] }>,
): Record<string, number> | null {
  const memberPaths = new Set(docNodes.flatMap((n) => n.members ?? []));
  if (memberPaths.size === 0) return null;
  const out: Record<string, number> = {};
  for (const p of memberPaths) out[p] = 0;
  for (const n of graph.nodes) {
    if (n.type === "function" && memberPaths.has(n.path)) out[n.path] = (out[n.path] ?? 0) + 1;
  }
  return out;
}

export type WriteResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Persist the model — integrity-gated + atomic. A malformed model is rejected
 * (no file written); a valid one writes model + meta via tmp+rename.
 */
export function writeArchModel(
  storageDir: string,
  doc: ArchModelDoc,
  meta: ArchModelMeta,
  validSubdirIds: Set<string>,
): WriteResult {
  const integrity = validateArchIntegrity(doc, validSubdirIds);
  if (!integrity.ok) return { ok: false, error: integrity.error };
  // Each atomicWrite is tmp+rename; the two together are not transactional. Write
  // the model FIRST and the meta LAST so the meta acts as the commit marker —
  // `readArchModel` requires BOTH files, so a crash between the two renames
  // leaves a model-without-meta that reads as a miss (self-heals on re-generate).
  // A concurrent re-generate path would need an advisory lock; single-process
  // daemon use today does not.
  atomicWrite(archModelPath(storageDir), JSON.stringify(doc, null, 2));
  atomicWrite(archMetaPath(storageDir), JSON.stringify(meta, null, 2));
  return { ok: true, path: archModelPath(storageDir) };
}

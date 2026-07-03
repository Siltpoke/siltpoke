// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * The ONE shared member→subdir-id resolver for the arch-derive READOUT layer.
 *
 * Both grounding (`groundBands`, A) and drillTo derivation (`deriveDrillToFromMembers`,
 * B) MUST resolve "what subdir does this member belong to" through THIS function —
 * never by parsing a container-id string. A container id (`agent-state`,
 * `comp:agent/nodes/x`, `api`) is NEVER inspected; resolution is purely over the
 * container's member FILE PATHS, bucketed by the structural projection's OWN keyspace.
 *
 * It REUSES the real exported `bucketIdOfPath` (imported, not copied) so the readout
 * keyspace can NEVER diverge from the structural projection keyspace. A tripwire
 * test asserts the load-bearing CONTRACT — every resolution is either null or an id
 * that is actually IN the given keyspace (`subdirs.map(s=>s.id)`), never an
 * out-of-keyspace id. That is the property that retires the pre-migration skew, and it
 * fails if a future edit re-forks the resolver to return a depth-2 / file-as-bucket id.
 * A reverse-guard test asserts no other id→subdir resolution path exists (this is the
 * single entry point / one-fold).
 *
 * A file that no projection subdir claims (loose top-level file, out-of-root path)
 * has no structural container → `bucketIdOfPath` returns null → this returns null.
 * Callers treat a null/empty resolution as an HONEST zero contribution (the member
 * genuinely has no subdir), never a silent orphan.
 */
import { bucketIdOfPath } from "../repo-graph/project-architecture";
import type { ProjectionSubdir } from "../repo-graph/project-architecture";
import type { ArchNodeDoc } from "./arch-model-schema";

/** The subdirs keyspace type threaded into the readout resolver. */
export type SubdirsKeyspace = ReadonlyArray<Pick<ProjectionSubdir, "id" | "path">>;

/**
 * Resolve a member FILE PATH to its structural subdir id, or null if no projection
 * subdir claims the path.
 *
 * Uses `bucketIdOfPath(subdirs, path)` — longest-path-prefix over the projection's
 * real subdirs — so the readout and structural projection share exactly the same
 * keyspace. A loose file that no subdir claims returns honest-null (no depth-2
 * heuristic, no file-as-bucket id, no skew).
 */
export function memberToSubdirId(
  memberFilePath: string,
  subdirs: SubdirsKeyspace,
): string | null {
  return bucketIdOfPath(subdirs, memberFilePath);
}

/**
 * Resolve a container's member file paths to the DISTINCT set of structural subdir
 * ids it spans. Empty members (ext/person nodes, or an LLM that omitted members) →
 * empty set → the container contributes 0 to the gradient (honest, not an orphan).
 */
export function membersToSubdirIds(
  memberFilePaths: readonly string[] | undefined,
  subdirs: SubdirsKeyspace,
): string[] {
  if (!memberFilePaths?.length) return [];
  const out = new Set<string>();
  for (const p of memberFilePaths) {
    const id = memberToSubdirId(p, subdirs);
    if (id) out.add(id);
  }
  return [...out];
}

/**
 * Build the `resolveSubdir(containerId) → subdir ids` closure that `groundBands`
 * consumes — the SINGLE entry point by which a band member (a container id) maps to
 * the structural subdir ids it spans. The container id is looked up in `nodes`, and
 * resolution is over its member FILE PATHS only (never the id string). An unknown
 * id or a members-less node → empty (honest zero contribution).
 */
export function makeResolveSubdir(
  nodes: readonly ArchNodeDoc[],
  subdirs: SubdirsKeyspace,
): (containerId: string) => string[] {
  const byId = new Map<string, ArchNodeDoc>();
  for (const n of nodes) byId.set(n.id, n);
  return (containerId) => membersToSubdirIds(byId.get(containerId)?.members, subdirs);
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Per-view trust inputs (spec §3.1) — converts each of the three
 * architecture views (Generated `ArchModelDoc`, Authored `C4Model`, Subset
 * `ArchitectureProjection`) into the pure `buildTrustMap`'s (trust-map.ts)
 * `TrustInput["containers"]` / `TrustInput["edges"]` shape. No I/O; callers
 * (task 6's endpoint) own reading `graphFiles` and wiring `citationExists`.
 *
 * "Which subdir does a file belong to" always goes through `bucketIdOfPath`
 * (project-architecture.ts) — the same function the projection itself uses —
 * so `total` here and the on-screen subset counts can never disagree (AC9's
 * oracle). `total` always comes from a subdir's own `files` count, NEVER
 * from `members.length`/`memberFiles.length` (the AI's sample is a proper
 * subset, not the ground truth).
 */
import type { ArchModelDoc } from "../explain/arch-model-schema";
import type { C4Model } from "../web/client/islands/repo-graph-c4-model";
import { type ArchitectureProjection, bucketIdOfPath, ROOT_BUCKET_ID } from "./project-architecture";
import type { TrustInput } from "./trust-map";

type Containers = TrustInput["containers"];
type Edges = TrustInput["edges"];

const ROOT_FOLDER = "(repo root)";

/** A subdir's folder name as shown. The derived root bucket's path is "" —
 * it is the repo root, not a blank name. */
function folderName(path: string): string {
  return path === "" ? ROOT_FOLDER : path;
}

/** folder(path)/total for a resolved subdir id, or the `(repo root)` bucket
 * when `bucketId` is null (a member outside every subdir). */
function folderOf(
  proj: ArchitectureProjection,
  bucketId: string | null,
  rootTotal: number,
): { folder: string; total: number } {
  if (bucketId === null) return { folder: ROOT_FOLDER, total: rootTotal };
  const sub = proj.subdirs.find((s) => s.id === bucketId);
  return { folder: sub === undefined ? bucketId : folderName(sub.path), total: sub?.files ?? 0 };
}

/** Generated view (AC9): group a cont node's `members` (AI-sampled file
 * paths) by subdir bucket; `graphFiles` supplies the repo-wide "(repo root)"
 * total (files no subdir claims), independent of which members the AI listed.
 *
 * Amended after a hands-on test: the import check (`importFiles`) uses EVERY
 * file under the container's folders, bucketed exactly as the counts are — the
 * AI's sample is display-only (`listedFiles`, the "5 of 39" line). Only a
 * sampled file's import used to count, so a real import from an unsampled file
 * drew dashed. A folder two containers both list files from is ambiguous (its
 * unlisted files belong to neither for sure), so there each container keeps
 * just the files it listed: that can still miss an import, never invent one.
 * The same goes for the repo-root bucket (files under no subdir): never expanded. */
export function generatedContainers(
  doc: ArchModelDoc,
  proj: ArchitectureProjection,
  graphFiles: string[],
): Containers {
  const bucketOf = new Map(graphFiles.map((f) => [f, bucketIdOfPath(proj.subdirs, f)]));
  const rootTotal = graphFiles.filter((f) => bucketOf.get(f) === null).length;
  const conts = doc.nodes.filter((n) => n.kind === "cont");
  const bucketsOf = (members: string[]): Set<string | null> => new Set(members.map((f) => bucketIdOfPath(proj.subdirs, f)));
  const claims = new Map<string | null, number>();
  for (const n of conts) for (const b of bucketsOf(n.members ?? [])) claims.set(b, (claims.get(b) ?? 0) + 1);
  return conts.map((n) => {
    const members = n.members ?? [];
    const listedByBucket = new Map<string | null, number>();
    for (const file of members) {
      const bucket = bucketIdOfPath(proj.subdirs, file);
      listedByBucket.set(bucket, (listedByBucket.get(bucket) ?? 0) + 1);
    }
    const folders = [...listedByBucket.entries()].map(([bucket, listed]) => ({
      ...folderOf(proj, bucket, rootTotal),
      listed,
    }));
    // The repo-root bucket (files no subdir claims: scripts/, tests/, top-level) is never expanded —
    // it is not one folder a box owns, so a single root-level file listed must not hand the box every
    // unclaimed file. Root-level members count by the sample only (review of faa910ff).
    // The derived root bucket (ROOT_BUCKET_ID: files directly at the root) is the same loose set
    // and stays unexpanded for the same reason.
    const own = new Set(
      [...listedByBucket.keys()].filter((b) => b !== null && b !== ROOT_BUCKET_ID && claims.get(b) === 1),
    );
    const importFiles = [...new Set([...members, ...graphFiles.filter((f) => own.has(bucketOf.get(f) ?? null))])];
    return { id: n.id, title: n.title.value, desc: n.desc?.value ?? "", importFiles, folders, listedFiles: members };
  });
}

/** Generated edges: verb text + tier + citation straight off the doc's
 * claim wrappers — evidence classification itself happens in `buildTrustMap`. */
export function generatedEdges(doc: ArchModelDoc): Edges {
  return doc.edges.map((e) => {
    const cite = e.verb.evidence[0];
    return {
      source: e.source,
      target: e.target,
      verb: e.verb.value,
      tier: e.verb.tier ?? null,
      citation: cite ? { file: cite.file, line: cite.line } : null,
    };
  });
}

/** Authored view: a cont node's folder set is `members` (subdir ids) ??
 * `[drillTo]` ?? its own id — always a COMPLETE subdir, never a file sample,
 * so `listed` stays null (AC10). */
export function authoredContainers(model: C4Model, proj: ArchitectureProjection, graphFiles: string[]): Containers {
  return Object.entries(model.N)
    .filter(([, node]) => node.kind === "cont")
    .map(([id, node]) => {
      const folderIds = node.members ?? (node.drillTo ? [node.drillTo] : [id]);
      const importFiles = graphFiles.filter((f) => {
        const bucket = bucketIdOfPath(proj.subdirs, f);
        return bucket !== null && folderIds.includes(bucket);
      });
      const folders = folderIds.map((fid) => ({ ...folderOf(proj, fid, 0), listed: null }));
      return { id, title: node.title, desc: node.desc ?? "", importFiles, folders, listedFiles: [] };
    });
}

/** Authored edges: the raw `[source, target, verb]` tuple carries no
 * tier/citation of its own — evidence for these comes only from the (complete)
 * import check `buildTrustMap` runs against `importFiles`. */
export function authoredEdges(model: C4Model): Edges {
  return model.E.map(([source, target, verb]) => ({ source, target, verb, tier: null, citation: null }));
}

/** Subset view: one container per non-empty subdir, one folder, `listed: null`.
 * `importFiles` is unused (subset edges always carry `subsetWeight`, so
 * `buildTrustMap` never falls back to counting `importFiles`). */
export function subsetContainers(proj: ArchitectureProjection): Containers {
  return proj.subdirs
    .filter((s) => s.files > 0)
    .map((s) => ({
      id: s.id,
      title: s.id, // matches the on-screen honest-subset container title (repo-graph-c4-derive.ts: N[sd.id] = { title: sd.id, ... })
      desc: s.purpose,
      importFiles: [],
      folders: [{ folder: folderName(s.path), listed: null, total: s.files }],
      listedFiles: [],
    }));
}

/** Subset edges are always a real import — `weight` carries straight through
 * as `subsetWeight`, bypassing `buildTrustMap`'s import-pair count. */
export function subsetEdges(proj: ArchitectureProjection): Edges {
  return proj.edges.map((e) => ({ source: e.source, target: e.target, verb: "", tier: null, citation: null, subsetWeight: e.weight }));
}

/** File-bearing subdirs covered by no container's `folders[]` (AC13). */
export function notShownFolders(proj: ArchitectureProjection, containers: Containers): string[] {
  const covered = new Set(containers.flatMap((c) => c.folders.map((f) => f.folder)));
  return proj.subdirs
    .filter((s) => s.files > 0 && !covered.has(folderName(s.path)))
    .map((s) => folderName(s.path));
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Which indexed files a Code Map view leaves out of its boxes.
 *
 * The page header counts every indexed file; the boxes can hold fewer. Before
 * this, the difference was silent — agent-runtime's header said "5 files", the
 * boxes added up to 4, and nothing named the missing `main.py`. These pure
 * functions name the files so the page can say "N files not in this diagram".
 *
 *   - Auto / overlay view: a file is drawn iff some bucket claims it
 *     (`bucketIdOfPath`). The derived buckets claim every file; an authored
 *     CLAUDE.md overlay can leave files out on purpose (e.g. `scripts/` when
 *     every declared path is under `src/`) — still worth saying.
 *   - Generated view: the model is asked for "a few" member files per box,
 *     so a file is drawn iff it is a listed member of some container, or it
 *     sits in a folder that one whole-folder box (not a `comp:` split) owns.
 */
import type { ArchModelDoc } from "../explain/arch-model-schema";
import { bucketIdOfPath } from "./project-architecture";

type Buckets = ReadonlyArray<{ id: string; path: string }>;

/** How many file paths the page payload carries; the count stays exact. */
export const UNDRAWN_EXAMPLE_CAP = 50;

export interface UndrawnSummary {
  count: number;
  /** Up to UNDRAWN_EXAMPLE_CAP of the paths, sorted. */
  examples: string[];
}

/** Files no bucket claims, sorted. */
export function filesOutsideBuckets(buckets: Buckets, files: readonly string[]): string[] {
  return files.filter((f) => bucketIdOfPath(buckets, f) === null).sort();
}

/** Files the Generated model put in no box, sorted. */
export function filesOutsideGenerated(doc: ArchModelDoc, buckets: Buckets, files: readonly string[]): string[] {
  const conts = doc.nodes.filter((n) => n.kind === "cont");
  const listed = new Set(conts.flatMap((n) => n.members ?? []));
  // A folder another box splits into `comp:` parts is owned by no single box.
  const split = new Set(conts.filter((n) => n.id.startsWith("comp:") && n.drillTo).map((n) => n.drillTo!));
  const wholeFolders = new Set(
    conts
      .filter((n) => !n.id.startsWith("comp:") && n.drillTo !== undefined && !split.has(n.drillTo))
      .map((n) => n.drillTo!),
  );
  return files
    .filter((f) => {
      if (listed.has(f)) return false;
      const bucket = bucketIdOfPath(buckets, f);
      return bucket === null || !wholeFolders.has(bucket);
    })
    .sort();
}

export function summarizeUndrawn(paths: readonly string[]): UndrawnSummary {
  return { count: paths.length, examples: paths.slice(0, UNDRAWN_EXAMPLE_CAP) };
}

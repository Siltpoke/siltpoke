// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The trust map (spec §3) — a per-edge evidence classification, per-container
 * folder coverage, and a repo-relative path guard, defined once and rendered
 * twice (on-screen + export). Pure builder: no I/O, no git, no fs reads — the
 * citation existence check is injected via `TrustInput.citationExists` so this
 * module stays testable without a filesystem.
 */
import type { HeadRelation } from "./git-stamp";

export type TrustSource = "generated" | "authored" | "subset";

type EdgeEvidence =
  | { kind: "import"; count: number } // AC6 — file-level imports, both directions summed
  | { kind: "cited"; file: string; line: number } // AC7 — tier cited AND file:line exists now
  | { kind: "none"; reason: "no-import-no-citation" | "citation-stale" }; // AC8

interface TrustEdge {
  source: string;
  target: string;
  verb: string;
  solid: boolean; // derived in code from evidence.kind !== "none" — never from LLM output
  evidence: EdgeEvidence;
}

interface FolderCoverage {
  folder: string; // repo-relative subdir id
  listed: number | null; // AI-listed files in this folder; null on authored/subset (AC10)
  total: number; // index file count for this folder (AC9 — subdir bucket, not memberFiles.length)
}

interface TrustContainer {
  id: string;
  title: string;
  desc: string; // desc = AI prose, unverified (AC14)
  folders: FolderCoverage[];
  listedFiles: string[]; // exact AI-listed files; generated only, [] otherwise; export strips unless appendix (AC17/AC26)
}

export interface TrustMap {
  schema: 1;
  source: TrustSource;
  stamp: {
    mapDate: string; // ISO 8601
    commit: string | null; // short SHA
    commitsAhead: number | null; // "same" | "ahead": HEAD minus map; "behind": map minus HEAD; else null
    headRelation: HeadRelation;
  };
  containers: TrustContainer[];
  edges: TrustEdge[];
  totals: { listed: number; total: number } | null; // generated only (AC11)
  notShown: string[]; // file-bearing folders covered by no container (AC13)
}

/**
 * Input to the pure builder. Mirrors `TrustMap`'s shape but pre-classification:
 * `edges[]` carry the raw tier/citation the caller (T5) derived from the
 * architecture doc/projection, `importPairs` is the resolved import graph
 * (`resolvedImportPairs`, trust-imports.ts), and `citationExists` is injected
 * so this module never touches the filesystem itself.
 */
export interface TrustInput {
  source: TrustSource;
  containers: Array<{
    id: string;
    title: string;
    desc: string;
    importFiles: string[];
    folders: FolderCoverage[];
    listedFiles: string[];
  }>;
  edges: Array<{
    source: string;
    target: string;
    verb: string;
    tier: "cited" | "inferred" | "topology-blind" | null;
    citation: { file: string; line: number } | null;
    subsetWeight?: number;
  }>;
  importPairs: ReadonlyArray<readonly [string, string]>;
  citationExists: (file: string, line: number) => boolean;
  stamp: TrustMap["stamp"];
  notShown: string[];
  withListedFiles: boolean;
}

const OUTSIDE = "<outside repo>";

/**
 * Normalise a path to repo-relative form for the trust map's output (spec
 * §5's path guard): `\` → `/`, strip leading `./`, collapse `..` segments.
 * Any path that is absolute in any shape, or that escapes the repo root via
 * `..`, returns the literal `<outside repo>` — the guard every path field in
 * `TrustMap` passes through before it can leave the daemon.
 */
function toRepoRelative(p: string): string {
  const s = p.replace(/\\/g, "/");
  if (s.startsWith("/") || /^[A-Za-z]:\//.test(s)) return OUTSIDE;
  const parts: string[] = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return OUTSIDE;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Build the trust map from pre-classified inputs. Evidence precedence (spec
 * §3): import is checked first — if ≥1 import exists the edge is `import`
 * even when it also carries a citation. A `cited` edge whose file or line no
 * longer exists is `none / citation-stale`. Anything else with no import is
 * `none / no-import-no-citation`. `solid` is derived in code from
 * `evidence.kind !== "none"`, never from LLM output.
 */
export function buildTrustMap(input: TrustInput): TrustMap {
  const filesOf = new Map(input.containers.map((c) => [c.id, new Set(c.importFiles.map(toRepoRelative))]));
  const importCount = (a: string, b: string): number => {
    const A = filesOf.get(a);
    const B = filesOf.get(b);
    if (!A || !B) return 0;
    let n = 0;
    for (const [s, t] of input.importPairs) if ((A.has(s) && B.has(t)) || (B.has(s) && A.has(t))) n++;
    return n;
  };
  const edges: TrustEdge[] = input.edges.map((e) => {
    let evidence: EdgeEvidence;
    const n = e.subsetWeight ?? importCount(e.source, e.target);
    if (n > 0) evidence = { kind: "import", count: n };
    else if (e.tier === "cited" && e.citation) {
      const file = toRepoRelative(e.citation.file);
      evidence =
        file !== OUTSIDE && input.citationExists(file, e.citation.line)
          ? { kind: "cited", file, line: e.citation.line }
          : { kind: "none", reason: "citation-stale" };
    } else evidence = { kind: "none", reason: "no-import-no-citation" };
    return { source: e.source, target: e.target, verb: e.verb, solid: evidence.kind !== "none", evidence };
  });
  const containers: TrustContainer[] = input.containers.map((c) => ({
    id: c.id,
    title: c.title,
    desc: c.desc,
    folders: c.folders.map((f) => ({ ...f, folder: toRepoRelative(f.folder) })),
    listedFiles: input.withListedFiles ? c.listedFiles.map(toRepoRelative) : [],
  }));
  let totals: TrustMap["totals"] = null;
  if (input.source === "generated") {
    const seen = new Map<string, number>();
    let listed = 0;
    for (const c of containers) {
      for (const f of c.folders) {
        listed += f.listed ?? 0;
        seen.set(f.folder, f.total);
      }
    }
    totals = { listed, total: [...seen.values()].reduce((a, b) => a + b, 0) };
  }
  return {
    schema: 1,
    source: input.source,
    stamp: input.stamp,
    containers,
    edges,
    totals,
    notShown: input.notShown.map(toRepoRelative),
  };
}

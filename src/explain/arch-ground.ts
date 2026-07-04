// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The architecture-view LLM-derive — the two-tier grounding pass.
 *
 * The model proposes + cites; this code falsifies. Every claim is tiered
 * "cited" | "inferred":
 *   - FACT (container titles/members, node→band pointers): the cite resolves to
 *     a real file:line (reuses `citationGrounded`, the same rule as explain).
 *   - JUDGMENT (band layer labels, edge verbs, ext systems, purposes): the cite
 *     must resolve AND a deterministic corroboration must hold — band ORDER vs
 *     the dependency gradient (`groundBands`), verb/ext vs a snippet token
 *     at the cited line. A failing judgment → "inferred" (never dropped, never
 *     promoted); a verb that can't be corroborated degrades to "uses".
 *
 * `tier` is set HERE, never by the LLM. The pass is immutable: it returns a new
 * doc, never mutates the input. `groundedPct` = cited / total over all claims.
 */
import type { KnownFile } from "./evidence-score";
import { citationGrounded } from "./evidence-score";
import type { RepoGraph } from "../repo-graph/types";
import type {
  ArchBandDoc,
  ArchEdgeDoc,
  ArchModelDoc,
  ArchNodeDoc,
  Evidence,
  Tier,
} from "./arch-model-schema";
import { groundBands, type SubdirEdge } from "./arch-ground-bands";
import { makeResolveSubdir, type SubdirsKeyspace } from "./subdir-resolve";

/** Reads the content of a cited file (repo-relative). null → unreadable. */
export type SourceProvider = (path: string) => Promise<string | null>;

/** Per-verb-category corroboration tokens; first whose `test` matches the verb
 * decides which tokens the cited line must contain. */
const VERB_TOKENS: Array<{ test: RegExp; tokens: string[] }> = [
  { test: /spawn|exec|subprocess|claude|child|shell/, tokens: ["spawn", "exec", "fork", "child_process", "execsync"] },
  { test: /read|load|parse/, tokens: ["read", "readfile", "parse", "load", "fs."] },
  { test: /write|persist|save|store|insert/, tokens: ["write", "writefile", "save", "insert", "persist", "upsert"] },
  { test: /http|fetch|\bapi\b|request/, tokens: ["fetch", "axios", "request", "http", "api"] },
  { test: /render|draw|display/, tokens: ["render", "jsx", "html", "draw", "element"] },
  { test: /rout|dispatch|gate/, tokens: ["route", "dispatch", "router", ".get(", ".post("] },
  { test: /stream|sse|event/, tokens: ["stream", "sse", "eventsource", "writer"] },
];
const STOPWORDS = new Set(["the", "a", "an", "to", "of", "in", "on", "and", "for", "via", "with", "from", "uses", "calls", "into"]);

function buildKnownFiles(graph: RepoGraph): Map<string, KnownFile> {
  const out = new Map<string, KnownFile>();
  for (const n of graph.nodes) {
    if (n.type === "file") out.set(n.path, { path: n.path, maxLine: n.lineRange[1] });
  }
  return out;
}

/** A claim's evidence all resolves to real file:lines (fact-tier check). */
function evidenceResolves(evidence: Evidence, known: Map<string, KnownFile>): boolean {
  return evidence.length > 0 && evidence.every((e) => citationGrounded(e.file, e.line, e.endLine ?? e.line, known));
}

/** Read the cited line's content (1-indexed). null if unreadable / out of range. */
async function citedLine(ev: Evidence[number], src: SourceProvider): Promise<string | null> {
  const content = await src(ev.file);
  if (content === null) return null;
  const lines = content.split(/\r?\n/);
  return lines[ev.line - 1] ?? null;
}

/** Does the cited line corroborate the verb (category token, else salient word)? */
async function verbCorroborated(verb: string, evidence: Evidence, src: SourceProvider): Promise<boolean> {
  if (evidence.length === 0) return false;
  const line = (await citedLine(evidence[0]!, src))?.toLowerCase();
  if (!line) return false;
  const v = verb.toLowerCase();
  const cat = VERB_TOKENS.find((c) => c.test.test(v));
  if (cat) return cat.tokens.some((t) => line.includes(t));
  // No category → require a salient word from the verb itself.
  const salient = v.split(/[^a-z]+/).filter((w) => w.length > 3 && !STOPWORDS.has(w));
  return salient.some((w) => line.includes(w));
}

function pct(cited: number, total: number): number {
  return total === 0 ? 0 : Math.round((cited / total) * 100);
}

export interface GroundResult {
  doc: ArchModelDoc;
  groundedPct: number;
  citedClaims: number;
  totalClaims: number;
  /** Count of `topology-blind` band labels (omnipresent-shaped domain cores
   * the import gradient can't adjudicate). Excluded from groundedPct; surfaced so
   * the chip can read "depended-upon cores · layer not import-confirmable". */
  topologyBlindClaims: number;
}

/**
 * Ground an ArchModelDoc. Returns a NEW doc with every claim's `tier` set +
 * `groundedPct`. `subdirEdges` is the real subdir-level import graph (from the
 * projection) used by the band predicate.
 *
 * NOTE: deriveInferredClaims (src/web/client/islands/repo-graph-popovers.ts)
 * mirrors this claim walk for the grounded popover's inferred list — its parity
 * with GroundResult counts is asserted at render time. Adding/removing a claim
 * surface here requires updating that mirror in the same change.
 */
export async function groundArchModel(
  doc: ArchModelDoc,
  graph: RepoGraph,
  subdirEdges: SubdirEdge[],
  subdirs: SubdirsKeyspace,
  src: SourceProvider,
): Promise<GroundResult> {
  const known = buildKnownFiles(graph);
  let cited = 0;
  let total = 0;
  let topologyBlind = 0;
  const tally = (tier: Tier): Tier => {
    // `topology-blind` is an honest abstention — excluded from BOTH the
    // numerator AND the denominator of groundedPct (it is neither a graded pass
    // nor a graded fail), counted separately so the chip stays honest.
    if (tier === "topology-blind") {
      topologyBlind++;
      return tier;
    }
    total++;
    if (tier === "cited") cited++;
    return tier;
  };

  // ── band layer labels: evidence must resolve AND order corroborate ──
  // resolveSubdir maps each band-member container id → its keyspace subdir id(s)
  // via the container's member file paths (the ONE shared bucketer), so composite /
  // comp: / file-as-bucket ids never orphan against the edge keyspace.
  const bandTierById = groundBands(doc.bands, subdirEdges, makeResolveSubdir(doc.nodes, subdirs));
  const bands: ArchBandDoc[] = doc.bands.map((b) => {
    const evidenceOk = evidenceResolves(b.label.evidence, known);
    const orderTier = bandTierById.get(b.id) ?? "inferred";
    // A `topology-blind` band passes through unswallowed — the honest
    // abstention is the dominant signal (import topology can't adjudicate this
    // layer), it must NOT collapse to `inferred` via the evidence fold.
    const tier: Tier =
      orderTier === "topology-blind"
        ? "topology-blind"
        : evidenceOk && orderTier === "cited"
          ? "cited"
          : "inferred";
    return { ...b, label: { ...b.label, tier: tally(tier) } };
  });

  // ── nodes: title (fact), band pointer (fact), desc (judgment), members ──────
  // ext titles get an extra hurdle: the cite must also corroborate a call/import
  // site via a snippet token (folded in here so each title is tallied exactly
  // once — no second pass, no decrement).
  const nodes: ArchNodeDoc[] = [];
  for (const n of doc.nodes) {
    let titleTier: Tier = evidenceResolves(n.title.evidence, known) ? "cited" : "inferred";
    if (n.kind === "ext" && titleTier === "cited" && !(await verbCorroborated(n.title.value, n.title.evidence, src))) {
      titleTier = "inferred";
    }
    const title = { ...n.title, tier: tally(titleTier) };
    const band = { ...n.band, tier: tally(evidenceResolves(n.band.evidence, known) ? "cited" : "inferred") };
    const members = n.members?.filter((m) => known.has(m));
    const desc = n.desc
      ? { ...n.desc, tier: tally(evidenceResolves(n.desc.evidence, known) ? "cited" : "inferred") }
      : undefined;
    nodes.push({ ...n, title, band, ...(desc ? { desc } : {}), ...(members ? { members } : {}) });
  }

  // ── edges: verb judgment (snippet-token; uncorroborated → "uses" inferred) ──
  const edges: ArchEdgeDoc[] = [];
  for (const e of doc.edges) {
    const resolves = evidenceResolves(e.verb.evidence, known);
    const corroborated = resolves && (await verbCorroborated(e.verb.value, e.verb.evidence, src));
    if (corroborated) {
      edges.push({ ...e, verb: { ...e.verb, tier: tally("cited") } });
    } else {
      // degrade the unsupported verb to the neutral "uses", marked inferred.
      edges.push({ ...e, verb: { value: "uses", evidence: e.verb.evidence, tier: tally("inferred") } });
    }
  }

  const groundedPct = pct(cited, total);
  return {
    doc: { ...doc, bands, nodes, edges, groundedPct },
    groundedPct,
    citedClaims: cited,
    totalClaims: total,
    topologyBlindClaims: topologyBlind,
  };
}

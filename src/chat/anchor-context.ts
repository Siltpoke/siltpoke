// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Resolve a repo-graph node id into Brain-ready "anchor context" for the
 * context-aware floating chat.
 *
 * This is the no-feed core: the client passes the node the user is viewing
 * (`S.selected`), the chat backend turns it into context the Brain can answer
 * from — WITHOUT the user pasting code. It reuses the explain assembly
 * (subgraph + source + prompt-assembly) but STOPS before the Brain call (pure
 * context assembly; the chat route makes the Brain call with its own transcript).
 *
 * Split into a pure core (`assembleAnchorContext`, in-memory, unit-testable)
 * and a thin disk shell (`resolveAnchorContext`, loads graph from storage),
 * mirroring the "pure + testable" discipline of the explain orchestrator.
 *
 * Scope (user-story 2026-06-22): answers "what is this node?" — source +
 * signature + neighbors. OUT: "who calls this / what breaks if I change it"
 * (caller-impact, deferred — the eval-questioned caller substrate).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFingerprints, readGraph, readMeta, readQueryIndex } from "../repo-graph/store";
import { buildSubgraph } from "../repo-graph/subgraph";
import { buildSymbolTable } from "../repo-graph/symbol-table";
import type { Fingerprints, QueryIndex, RepoGraph, SiltpokeGraphNode } from "../repo-graph/types";
import { assemblePrompt } from "../explain/prompt-assembly";
import type { SourceProvider } from "../explain/explain";

const DEFAULT_DEPTH: 1 | 2 = 1;

/**
 * Chat-flavored system prompt for the anchored "what is this node?" turn.
 * Distinct from explain's EXPLAIN_SYSTEM_PROMPT — conversational, and it pins
 * the OUT-of-scope boundary (no caller-impact) into the model instruction.
 */
export const CHAT_ANCHOR_SYSTEM_PROMPT = `You are siltpoke, a coding companion. The user is looking at one specific code node (a function or file) in their repository graph and is asking about it in a chat.

Answer their question about THIS node using ONLY the provided context (the node's source, signature, and its immediate neighbors). Be concise and plain-language. Cite \`file:line\` for any concrete claim. If the provided context does not contain the answer, say so plainly — never fabricate.

Do NOT answer "who calls this" or "what breaks if I change it" (change/caller-impact is out of scope for now); if asked, say that's not yet supported.`;

/** The assembled anchor context handed to the chat route (no Brain call here). */
export interface AnchorContext {
  /** The resolved graph node id (canonical `function:path:name` / `file:path:`). */
  nodeId: string;
  /** Human-readable node name (for the 📍 indicator / conversation label). */
  nodeName: string;
  /** Node type (function/file/class/module/symbol) — drives the type badge. */
  nodeType: string;
  /** Repo-relative file the node lives in (return-to-source + fingerprint key). */
  path: string;
  /** Assembled subgraph snippets (source + neighbors) — the Brain context body. */
  contextBundle: string;
  /** Chat-flavored system prompt to pair with the contextBundle. */
  systemPrompt: string;
  /**
   * FILE-level content hash at pin time (for stale detection). `null` when the
   * file isn't fingerprint-tracked. NOTE: file-granularity only — a change
   * to a sibling symbol in the same file also flips this; per-node fingerprint
   * is future work.
   */
  fingerprint: string | null;
  /** Source paths included in the context bundle. */
  includedSources: string[];
  /** True if the context bundle was truncated to fit the byte budget. */
  truncated: boolean;
}

export type ResolveAnchorResult =
  | { kind: "resolved"; context: AnchorContext }
  | { kind: "node_not_found"; target: AnchorTarget }
  | { kind: "no_graph"; message: string };

/**
 * What the client says it's viewing. EITHER a canonical graph node id (trace
 * view / entrypoints already carry one) OR a {name, path} descriptor (the
 * symbol-drill view's selection is a RENDER id `s:name`, not canonical — so it
 * sends what it has and the BACKEND resolves to the canonical node via the
 * actual graph data, never string-reconstructing the id). `node_type` (from
 * the rendered symbol's kind) disambiguates when a name+path is non-unique.
 */
export type AnchorTarget =
  | { node_id: string }
  | { name: string; path: string; node_type?: string };

/**
 * Resolve an AnchorTarget to a concrete graph node using real graph data (no
 * id string reconstruction → no coupling to the indexer's id format). For a
 * descriptor, match on name+path (+ node_type when given); a name+path that is
 * still non-unique prefers a non-`file` node (the symbol the user clicked).
 *
 * Exported for the cheap node-existence check in chat.ts (a perf fix):
 * the route reads graph.json + calls findTargetNode WITHOUT building subgraph /
 * loading sources / assembling the prompt — same identity logic, cheaper path.
 */
export function findTargetNode(target: AnchorTarget, graph: RepoGraph): SiltpokeGraphNode | undefined {
  if ("node_id" in target) {
    return graph.nodes.find((n) => n.id === target.node_id);
  }
  const matches = graph.nodes.filter(
    (n) =>
      n.name === target.name &&
      n.path === target.path &&
      (target.node_type === undefined || n.type === target.node_type),
  );
  if (matches.length <= 1) return matches[0];
  return matches.find((n) => n.type !== "file") ?? matches[0];
}

/**
 * Cheap node-existence check. Reads ONLY graph.json for the
 * given storage dir, then checks whether the target node exists using the
 * SAME `findTargetNode` identity logic the full resolver uses.
 *
 * Returns:
 *  "found"     — node is in the graph (do NOT block).
 *  "not_found" — node is definitively absent (block with node_gone).
 *  "no_graph"  — storage dir absent, unreadable, or wrong schema (fail-open).
 *
 * This avoids the full `resolveAnchorContext` pipeline (readQueryIndex +
 * buildSymbolTable + buildSubgraph + source-file reads + assemblePrompt) on
 * every chat turn for pinned sessions. The identity check is correct because
 * it reuses `findTargetNode` verbatim — no false positives or negatives vs.
 * what the full resolver would return for "does the node exist?".
 */
export async function cheapNodeExists(
  target: AnchorTarget,
  graphStorageDir: string,
): Promise<"found" | "not_found" | "no_graph"> {
  // meta.json guard: avoids readGraph on an uninitialized storage dir (mirrors
  // the resolveAnchorContext meta.json pre-check).
  if (!existsSync(join(graphStorageDir, "meta.json"))) {
    return "no_graph";
  }
  // graph.json guard: readGraph's readJsonOr returns emptyGraph() for a MISSING
  // file (schemaVersion:1 + [] arrays — passes validation). Without this check
  // we'd false-positive "not_found" on a project that was indexed but whose
  // graph.json hasn't been written yet.
  if (!existsSync(join(graphStorageDir, "graph.json"))) {
    return "no_graph";
  }
  try {
    const graph = await readGraph(graphStorageDir);
    // readGraph returns emptyGraph() on schema mismatch (corrupt/hand-edited
    // file). A valid empty graph (all nodes removed) shares the same shape, so
    // we cannot distinguish them from schemaVersion alone. We accept that: a
    // truly empty graph correctly produces "not_found" for any target, and that
    // is accurate (the node can't be found in an empty graph).
    const found = findTargetNode(target, graph);
    return found ? "found" : "not_found";
  } catch {
    return "no_graph";
  }
}

/**
 * Pure core — assemble anchor context from already-loaded graph data.
 * Resolves the AnchorTarget against the real graph (backend owns id
 * resolution). Unresolvable → `node_not_found` (dead-anchor).
 */
export async function assembleAnchorContext(input: {
  target: AnchorTarget;
  graph: RepoGraph;
  queryIndex: QueryIndex;
  fingerprints: Fingerprints;
  sourceProvider: SourceProvider;
  depth?: 1 | 2;
}): Promise<ResolveAnchorResult> {
  const { target, graph, queryIndex, fingerprints, sourceProvider } = input;
  const depth = input.depth ?? DEFAULT_DEPTH;

  const targetNode = findTargetNode(target, graph);
  if (!targetNode) {
    return { kind: "node_not_found", target };
  }
  const nodeId = targetNode.id;

  const symbolTable = buildSymbolTable(graph, queryIndex);
  const subgraph = buildSubgraph(nodeId, graph, depth);

  const paths = [...new Set(subgraph.nodes.map((n) => n.path).filter((p) => p && p.length > 0))];
  const sources = new Map<string, string>();
  for (const path of paths) {
    const content = await sourceProvider(path);
    if (content !== null) sources.set(path, content);
  }

  const prompt = assemblePrompt({ targetId: nodeId, subgraph, symbolTable, sources });
  const fingerprint = fingerprints.files[targetNode.path]?.content_sha256 ?? null;

  return {
    kind: "resolved",
    context: {
      nodeId,
      nodeName: targetNode.name,
      nodeType: targetNode.type,
      path: targetNode.path,
      contextBundle: prompt.contextBundle,
      systemPrompt: CHAT_ANCHOR_SYSTEM_PROMPT,
      fingerprint,
      includedSources: prompt.includedSources,
      truncated: prompt.truncated,
    },
  };
}

/**
 * Disk shell — load the project's repo-graph from storage, then assemble.
 * `no_graph` when the project hasn't been indexed (parallels explain's
 * pre-check; the chat route surfaces "run /siltpoke-index first").
 */
export async function resolveAnchorContext(input: {
  target: AnchorTarget;
  graphStorageDir: string;
  sourceProvider: SourceProvider;
  depth?: 1 | 2;
}): Promise<ResolveAnchorResult> {
  const { target, graphStorageDir, sourceProvider } = input;

  if (!existsSync(join(graphStorageDir, "meta.json"))) {
    return {
      kind: "no_graph",
      message: "No repo-graph found. Run `/siltpoke-index` first to build the structural index.",
    };
  }
  const meta = await readMeta(graphStorageDir);
  if (!meta || meta.schemaVersion !== 1) {
    return {
      kind: "no_graph",
      message: "Repo-graph meta.json missing or unsupported. Run `/siltpoke-index --force`.",
    };
  }

  const graph = await readGraph(graphStorageDir);
  const queryIndex = await readQueryIndex(graphStorageDir);
  const fingerprints = await readFingerprints(graphStorageDir);

  return assembleAnchorContext({
    target,
    graph,
    queryIndex,
    fingerprints,
    sourceProvider,
    depth: input.depth,
  });
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * tracePath: a depth-limited, function-level call path from an entrypoint,
 * shaped to mirror the trace.js data contract that the renderer consumes.
 *
 * Honesty rules:
 *   - Only resolved/inferred call edges form the route. We never draw a hop we
 *     can't statically confirm.
 *   - A named-but-unindexed callee (klass "unresolved") becomes a real-named
 *     unresolvable TAIL node ("there's a next step, but static can't link it").
 *   - A dynamic-dispatch callee (no static name) sets `warn` on its parent but
 *     produces NO node — we never fabricate a symbol name.
 *   - Purpose comes only from a captured doc-comment; otherwise src "none".
 *     This function NEVER invents purpose text.
 *
 * Spine selection is greedy + deterministic: at each step follow the
 * resolved/inferred child with the most onward reach (tie: weight, then id).
 * Forks (branchOf) are intentionally deferred to M5 — deriving alternative-
 * execution branches needs control-flow signal we don't have yet, and v1's
 * honesty bar forbids guessing them.
 */
import { makeNameBasedResolver, type CallKlass, type CallResolver } from "./call-resolver";
import type { QueryIndex, RepoGraph, SiltpokeGraphNode, SiltpokeNodeType } from "./types";

export interface TraceIO {
  input: string;
  output: string;
}

export interface TracePurpose {
  src: "jsdoc" | "none" | "unresolvable";
  text?: string;
}

export interface TraceNode {
  id: string;
  fn: string;
  module: string;
  file: string;
  path: string;
  line: number;
  signature: string;
  /**
   * Graph node type ("file" | "function" | "class" | "module" | "symbol").
   * Optional: the synthetic unresolved-tail node (`unres:*`) has no real
   * graph node behind it, so it correctly leaves this undefined.
   */
  type?: SiltpokeNodeType;
  role?: "entry";
  shared?: boolean;
  warn?: boolean;
  klass?: "unresolvable";
  /** Parent spine node id for a dimmed off-path sibling. */
  off?: string;
  /** Parent spine node id for an unresolvable continuation. */
  tailOf?: string;
  /**
   * Fan-in = global resolved in-degree (how many callers reach this node). Set
   * on off-path siblings so M2's renderer can rank + cap the dimmed left column
   * by relevance (most-called first). Absent on spine / tail nodes.
   */
  weight?: number;
  io: TraceIO;
  purpose: TracePurpose;
}

export type TraceEdgeKlass = CallKlass | "dim" | "fork";

export interface TraceEdge {
  from: string;
  to: string;
  klass: TraceEdgeKlass;
}

export interface TracePath {
  entry: string;
  depth: number;
  spine: string[];
  nodes: TraceNode[];
  edges: TraceEdge[];
}

export interface TracePathOptions {
  depth?: number;
  resolver?: CallResolver;
  /** Detected entrypoint node ids — used to flag `shared` (reachable from >1). */
  entrypointIds?: string[];
}

interface ResolvedChild {
  targetId: string;
  klass: CallKlass;
  weight: number;
}

interface GapCall {
  /** "" for dynamic dispatch; the real callee name for unresolved. */
  calleeName: string;
  klass: "unresolved" | "unresolvable";
}

function moduleOf(path: string): string {
  const segs = path.split("/").filter(Boolean);
  if (segs[0] === "src" && segs.length >= 2) return segs[1]!;
  return segs[0] ?? "";
}

function basenameOf(path: string): string {
  const segs = path.split("/").filter(Boolean);
  return segs.length ? segs[segs.length - 1]! : path;
}

function parseIO(signature: string | undefined): TraceIO {
  if (!signature) return { input: "", output: "" };
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  const input = open >= 0 && close > open ? signature.slice(open + 1, close).trim() : "";
  let output = close >= 0 ? signature.slice(close + 1).trim() : "";
  output = output.replace(/^=>\s*/, "").replace(/^:\s*/, "").replace(/^→\s*/, "").trim();
  return { input, output };
}

function purposeOf(node: SiltpokeGraphNode): TracePurpose {
  if (node.doc) return { src: "jsdoc", text: node.doc };
  return { src: "none" };
}

interface Adjacency {
  resolved: Map<string, ResolvedChild[]>;
  gaps: Map<string, GapCall[]>;
}

/** Resolve every `calls` edge once, grouped by caller into routable + gap calls. */
function buildAdjacency(
  graph: RepoGraph,
  resolver: CallResolver,
): Adjacency {
  const resolved = new Map<string, ResolvedChild[]>();
  const gaps = new Map<string, GapCall[]>();
  for (const edge of graph.edges) {
    if (edge.type !== "calls") continue;
    const r = resolver.resolve({ calleeName: edge.target, callKind: edge.call_kind ?? "dynamic" });
    if ((r.klass === "resolved" || r.klass === "inferred") && r.targetId) {
      const arr = resolved.get(edge.source) ?? [];
      arr.push({ targetId: r.targetId, klass: r.klass, weight: edge.weight });
      resolved.set(edge.source, arr);
    } else {
      const arr = gaps.get(edge.source) ?? [];
      arr.push({
        calleeName: edge.target,
        klass: r.klass === "unresolved" ? "unresolved" : "unresolvable",
      });
      gaps.set(edge.source, arr);
    }
  }
  return { resolved, gaps };
}

/** Global resolved in-degree (fan-in): how many callers reach each target. */
function computeInDegree(resolved: Map<string, ResolvedChild[]>): Map<string, number> {
  const inDegree = new Map<string, number>();
  for (const children of resolved.values()) {
    for (const child of children) {
      inDegree.set(child.targetId, (inDegree.get(child.targetId) ?? 0) + 1);
    }
  }
  return inDegree;
}

/** Node ids reachable from a root over resolved/inferred edges (incl. root). */
function reachableFrom(root: string, resolved: Map<string, ResolvedChild[]>): Set<string> {
  const seen = new Set<string>([root]);
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const child of resolved.get(cur) ?? []) {
      if (!seen.has(child.targetId)) {
        seen.add(child.targetId);
        stack.push(child.targetId);
      }
    }
  }
  return seen;
}

export function tracePath(
  graph: RepoGraph,
  queryIndex: QueryIndex,
  entryId: string,
  options: TracePathOptions = {},
): TracePath {
  const depth = options.depth ?? 6;
  const resolver = options.resolver ?? makeNameBasedResolver(graph, queryIndex);
  const { resolved, gaps } = buildAdjacency(graph, resolver);

  // Global resolved in-degree (fan-in): the off-path column is capped + ranked
  // by this so the most widely-called siblings stay visible (M2 decision).
  const inDegree = computeInDegree(resolved);

  const nodeById = new Map<string, SiltpokeGraphNode>();
  for (const n of graph.nodes) nodeById.set(n.id, n);

  // ── Spine: greedy main route, depth-limited, cycle-guarded ────────────────
  const spine: string[] = [];
  const visited = new Set<string>();
  const maxNodes = depth + 1;
  let cur: string | null = entryId;
  while (cur && spine.length < maxNodes && !visited.has(cur) && nodeById.has(cur)) {
    spine.push(cur);
    visited.add(cur);
    // Explicit annotation breaks a self-referential inference cycle (`cur` is
    // reassigned from `children` below, so its type would otherwise depend on
    // `children`'s, which depends on `cur`).
    const children: ResolvedChild[] = (resolved.get(cur) ?? []).filter(
      (c) => !visited.has(c.targetId),
    );
    if (children.length === 0) break;
    children.sort((a, b) => {
      const ra = (resolved.get(a.targetId) ?? []).length;
      const rb = (resolved.get(b.targetId) ?? []).length;
      if (ra !== rb) return rb - ra;
      if (a.weight !== b.weight) return b.weight - a.weight;
      return a.targetId < b.targetId ? -1 : 1;
    });
    cur = children[0]!.targetId;
  }
  const spineSet = new Set(spine);

  // ── shared: reachable from >1 detected entrypoint ─────────────────────────
  const entrypointIds = options.entrypointIds ?? [];
  const reachCount = new Map<string, number>();
  if (entrypointIds.length > 1) {
    for (const ep of entrypointIds) {
      if (!nodeById.has(ep)) continue;
      for (const id of reachableFrom(ep, resolved)) {
        reachCount.set(id, (reachCount.get(id) ?? 0) + 1);
      }
    }
  }
  const isShared = (id: string): boolean => (reachCount.get(id) ?? 0) > 1;

  // ── Assemble nodes + edges ────────────────────────────────────────────────
  const nodes: TraceNode[] = [];
  const edges: TraceEdge[] = [];
  const emitted = new Set<string>();

  function realNode(id: string, extra: Partial<TraceNode>): void {
    if (emitted.has(id)) return;
    const g = nodeById.get(id);
    if (!g) return;
    emitted.add(id);
    nodes.push({
      id,
      fn: g.name,
      module: moduleOf(g.path),
      file: basenameOf(g.path),
      path: g.path,
      line: g.lineRange[0],
      signature: g.signature ?? "",
      type: g.type,
      io: parseIO(g.signature),
      purpose: purposeOf(g),
      ...(isShared(id) ? { shared: true } : {}),
      ...extra,
    });
  }

  // Spine nodes (entry carries role; warn set later from gaps).
  spine.forEach((id, i) => {
    realNode(id, i === 0 ? { role: "entry" } : {});
  });

  // Spine edges with their real resolved/inferred klass.
  for (let i = 0; i < spine.length - 1; i++) {
    const from = spine[i]!;
    const to = spine[i + 1]!;
    const klass = (resolved.get(from) ?? []).find((c) => c.targetId === to)?.klass ?? "resolved";
    edges.push({ from, to, klass });
  }

  // Off-path siblings: every other resolved/inferred child of a spine node.
  for (let i = 0; i < spine.length; i++) {
    const parent = spine[i]!;
    const successor = spine[i + 1];
    for (const child of resolved.get(parent) ?? []) {
      if (child.targetId === successor) continue;
      if (spineSet.has(child.targetId)) continue;
      if (emitted.has(child.targetId)) continue;
      realNode(child.targetId, { off: parent, weight: inDegree.get(child.targetId) ?? 0 });
      edges.push({ from: parent, to: child.targetId, klass: "dim" });
    }
  }

  // Unresolvable tail: the deepest spine node with a NAMED unresolved call gets
  // one real-named tail. Dynamic-only gaps produce no node.
  let tailParentId: string | null = null;
  for (let i = spine.length - 1; i >= 0; i--) {
    const parent = spine[i]!;
    const named = (gaps.get(parent) ?? []).find((g) => g.calleeName !== "");
    if (!named) continue;
    const tailId = `unres:${parent}:${named.calleeName}`;
    nodes.push({
      id: tailId,
      fn: named.calleeName,
      module: "",
      file: "",
      path: "",
      line: 0,
      signature: "",
      klass: "unresolvable",
      tailOf: parent,
      io: { input: "", output: "" },
      purpose: { src: "unresolvable" },
    });
    edges.push({ from: parent, to: tailId, klass: named.klass });
    tailParentId = parent;
    break;
  }

  // warn flag (TIGHTENED): only the node that actually owns an unresolved/
  // unresolvable out-edge DRAWN on the traced path — i.e. the tail's parent, the
  // one place the path genuinely might continue past. NOT every node that merely
  // makes some dynamic call (that flagged almost everything → pure noise).
  if (tailParentId) {
    const wn = nodes.find((n) => n.id === tailParentId);
    if (wn) wn.warn = true;
  }

  return { entry: entryId, depth, spine, nodes, edges };
}

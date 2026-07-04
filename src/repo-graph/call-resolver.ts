// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Call-edge resolution seam.
 *
 * The trace layer's honesty model rests on FOUR confidence classes, and
 * those classes ARE the outcomes of name resolution against the repo-graph
 * index. We expose resolution behind a `CallResolver` interface so a more
 * precise engine (e.g. a tsserver pass) can slot in later
 * WITHOUT collapsing the inferred/unresolved buckets — that
 * distinction is the feature, not an implementation detail.
 *
 *   dynamic dispatch (computed/HOF/no static name) → unresolvable
 *   static name, 0 candidates                      → unresolved
 *   static name, exactly 1 candidate               → resolved
 *   static name, >1 candidates                     → inferred
 *
 * Name-based resolution is the first impl. Coverage only means something
 * measured on the real resolver, so we ship this, run it on real repos,
 * and let the actual % decide whether precision is ever worth the cost.
 */
import type { QueryIndex, RepoGraph } from "./types";

export type CallKlass = "resolved" | "inferred" | "unresolved" | "unresolvable";
export type CallKind = "static" | "dynamic";

export interface CallSite {
  /** The callee identifier (or member property name); "" when none statically available. */
  calleeName: string;
  callKind: CallKind;
}

export interface CallResolution {
  /** Resolved graph node id, or null when unresolved/unresolvable. */
  targetId: string | null;
  klass: CallKlass;
}

export interface CallResolver {
  resolve(site: CallSite): CallResolution;
}

/** Node types a call can resolve TO. Bare `symbol`/`file`/`module` are not callable. */
const CALLABLE_TYPES = new Set(["function", "class"]);

/**
 * Build a name-based resolver over a graph + its query index. Precomputes
 * `name → callable node ids` once so each `resolve()` is an O(1) lookup.
 */
export function makeNameBasedResolver(
  graph: RepoGraph,
  queryIndex: QueryIndex,
): CallResolver {
  const typeById = new Map<string, string>();
  for (const node of graph.nodes) typeById.set(node.id, node.type);

  const callableByName = new Map<string, string[]>();
  for (const name of Object.keys(queryIndex.name_to_node_ids)) {
    const ids = queryIndex.name_to_node_ids[name] ?? [];
    const callable = ids.filter((id) => CALLABLE_TYPES.has(typeById.get(id) ?? ""));
    if (callable.length > 0) callableByName.set(name, callable);
  }

  return {
    resolve(site: CallSite): CallResolution {
      if (site.callKind === "dynamic" || site.calleeName === "") {
        return { targetId: null, klass: "unresolvable" };
      }
      const candidates = callableByName.get(site.calleeName);
      if (!candidates || candidates.length === 0) {
        return { targetId: null, klass: "unresolved" };
      }
      if (candidates.length === 1) {
        return { targetId: candidates[0]!, klass: "resolved" };
      }
      return { targetId: candidates[0]!, klass: "inferred" };
    },
  };
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Trace-root tree picker — pure tree-data helpers. No DOM, no fetch.
 *
 * Renders the existing arch→file→symbol drill DATA as a compact pick-a-function
 * tree (subdir → file → function) ending at the same trace sink the search box
 * uses. Two cross-site invariants live here as ONE source each:
 *   - `FUNCTION_KIND` — the single notion of "function" (node.type / /symbols kind)
 *     that the `/files` `functions` badge counts; the leaf gate reuses it, so the
 *     "N fns" badge can never disagree with the expandable leaves.
 *   - `funcNodeId` — the single trace-root id builder; the island's search-side
 *     `fnNodeId` delegates here, so a function picked from the tree and the same
 *     function picked from search produce a char-identical `function:<path>:<name>`
 *     id → identical trace (same sink).
 */

/** The one node kind that is a pickable trace root (methods are function nodes too). */
export const FUNCTION_KIND = "function";

/** The single trace-root node-id builder. Shared by the tree leaf AND the search
 * box (`fnNodeId` delegates here) so both pick paths are byte-identical. */
export function funcNodeId(filePath: string, name: string): string {
  return `function:${filePath}:${name}`;
}

export interface TreeSubdir {
  id: string;
  label: string;
}
export interface TreeFile {
  name: string;
  path: string;
  /** Function-symbol count (the "N fns" badge) — the `/files` `functions` field. */
  functions: number;
}
export interface TreeFunctionLeaf {
  name: string;
  line: number;
  /** `function:<path>:<name>` — the trace-root id; feed straight to phTraceFromNode. */
  rawNodeId: string;
}

interface ProjSubdir {
  id: string;
  group?: string;
  purpose?: string;
}
/** Top level: the repo's subdirs (from the arch projection, already at SSR). */
export function treeSubdirs(subdirs: readonly ProjSubdir[]): TreeSubdir[] {
  return subdirs.map((s) => ({ id: s.id, label: s.id }));
}

interface FileEntry {
  name: string;
  path: string;
  functions: number;
}
/** File level: keep only what the tree row needs (name, path, badge count). */
export function treeFiles(files: readonly FileEntry[]): TreeFile[] {
  return files.map((f) => ({ name: f.name, path: f.path, functions: f.functions }));
}

interface SymEntry {
  name: string;
  kind: string;
  line: number;
}
/** Leaf level: functions ONLY (AC-3 hide non-functions), each with the shared id. */
export function treeFunctions(symbols: readonly SymEntry[], filePath: string): TreeFunctionLeaf[] {
  return symbols
    .filter((s) => s.kind === FUNCTION_KIND)
    .map((s) => ({ name: s.name, line: s.line, rawNodeId: funcNodeId(filePath, s.name) }));
}

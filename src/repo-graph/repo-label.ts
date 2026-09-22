// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The one name an indexed root goes by — the picker button (SSR) and the repo
 * menu (client, via GET /api/repo-graph/repos) both use it, so they cannot
 * disagree. A sub-folder index reads `kata / TypeScript`: the bare folder name
 * alone is ambiguous across repos (spec 2026-09-14 §4.4). String ops only — no
 * node:path — so it stays safe to import anywhere.
 */
const lastSegment = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

export function repoDisplayName(entry: {
  proj_hash: string;
  project_root: string | null;
  repo_root?: string | null;
}): string {
  const root = entry.project_root;
  if (!root) return entry.proj_hash;
  const repoRoot = entry.repo_root;
  if (!repoRoot || !root.startsWith(`${repoRoot}/`)) return lastSegment(root);
  return `${lastSegment(repoRoot)} / ${root.slice(repoRoot.length + 1)}`;
}

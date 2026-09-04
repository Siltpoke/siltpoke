// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { levenshtein } from "./query";

export type ModuleResolve = { kind: "found"; id: string } | { kind: "phantom" };

/** Last non-empty path segment of a module id ("src/daemon/" → "daemon"). */
function segment(id: string): string {
  const parts = id.split("/").filter(Boolean);
  return (parts[parts.length - 1] ?? id).toLowerCase();
}

export function resolveModuleName(name: string, moduleIds: string[]): ModuleResolve {
  const q = name.trim().toLowerCase();
  if (!q) return { kind: "phantom" };
  // Exact: full id or last segment.
  for (const id of moduleIds) {
    if (id.toLowerCase() === q || segment(id) === q) return { kind: "found", id };
  }
  // Fuzzy: Levenshtein ≤ 2 on the segment, UNIQUE nearest wins; ties → phantom (never guess).
  let best: { id: string; d: number } | null = null;
  let tie = false;
  for (const id of moduleIds) {
    const d = levenshtein(q, segment(id));
    if (d > 2) continue;
    if (!best || d < best.d) { best = { id, d }; tie = false; }
    else if (d === best.d) tie = true;
  }
  return best && !tie ? { kind: "found", id: best.id } : { kind: "phantom" };
}

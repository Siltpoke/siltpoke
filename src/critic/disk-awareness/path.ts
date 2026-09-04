// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Single shared canonical-path helper for the disk-awareness slice.
 *
 * Repo-relative, forward-slash, no leading "./" — the canonical form used by
 * `reverse-deps.ts` (fence text + evidence-guard tokens) and `classify.ts`
 * (`isSource`'s path normalization). `importers.ts` keeps its own local
 * `canon` (same logic, defined before this file existed) rather than being
 * changed here to avoid touching a module whose test suite pins exact
 * behavior — see disk-awareness/reverse-deps.ts's review note. Task 4 should
 * import `canonicalPath` from here instead of writing a fourth copy.
 */
export function canonicalPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

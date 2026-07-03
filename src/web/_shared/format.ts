// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Display formatters for UI primitives.
 *
 * Counts >= 1000 render as "5.4k" (lowercase, 1 decimal, no trailing .0).
 * Truncates to tenths (floor) rather than rounding to avoid 999.95 → "1000k"
 * style edge-case promotions across thresholds.
 */

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  const truncated = Math.floor(n / 100) / 10;
  const fixed = truncated.toFixed(1);
  const stripped = fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
  return `${stripped}k`;
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Cross-family-honesty detector (track #7 T7).
 *
 * agy's `--model` menu includes Claude-family models alongside Gemini ones
 * (Task 1 spike, `agy models`):
 *
 *   Gemini 3.5 Flash (Medium|High|Low)
 *   Gemini 3.1 Pro (Low|High)
 *   Claude Sonnet 4.6 (Thinking)
 *   Claude Opus 4.6 (Thinking)
 *   GPT-OSS 120B (Medium)
 *
 * `reviewer_provider=agy` exists to get a Claude-blind-spot-free reviewer —
 * a genuinely different model family judging Claude's own output. If the
 * user picks one of agy's Claude-family entries, that value is defeated:
 * agy would be running Claude reviewing Claude, same self-preference risk
 * as `reviewer_provider=claude`. the maintainer's call: **warn, allow** — this is
 * a config-honesty nudge, not a correctness gate. It must never block the
 * review (see brain-guarded.ts's warn-once wiring).
 */

/**
 * Matches agy's real Claude-family display strings ("Claude Sonnet 4.6
 * (Thinking)", "Claude Opus 4.6 (Thinking)" — Task 1 spike's `agy models`
 * output) via the `"Claude "` prefix, plus the `"claude-"` programmatic-id
 * prefix in case a future agy version (or a differently-configured menu)
 * surfaces raw model ids instead of display strings. Both are assumptions
 * beyond the spike's literal 2-entry Claude list, noted here rather than
 * hardcoding only the exact strings seen once.
 */
const CLAUDE_FAMILY_PREFIXES = ["Claude ", "claude-"] as const;

/**
 * True when `model` is one of agy's Claude-family menu entries (or a
 * `claude-`-prefixed model id). Pure — no I/O, no side effects.
 */
export function isClaudeFamilyModel(model: string): boolean {
  return CLAUDE_FAMILY_PREFIXES.some((prefix) => model.startsWith(prefix));
}

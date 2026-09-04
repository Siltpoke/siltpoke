// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Shared "fence untrusted content" primitive.
 *
 * Originally lived only in `src/chat/critique-context.ts` (the critique-chat path —
 * chat critique anchor). Extracted here (prompt-injection hardening track,
 * 2026-07-13) so `src/brain/prompt-assembly.ts` — the critic's own prompt
 * assembler, which previously interpolated 100% of attacker-influenceable
 * content (raw diff hunks, tsc/eslint/ripgrep output, learned rules, style
 * facts) into the system prompt with ZERO delimiting — can reuse the exact
 * same fencing discipline instead of duplicating it.
 *
 * A per-assembly NONCE (`crypto.randomUUID()`, NEVER `Math.random`) means
 * untrusted content can never forge or close a fence early: the nonce is
 * unknown to the content at the time it was written (a comment in a vendored
 * file, a poisoned learned_rule, etc.), so it cannot embed a matching
 * `TAG:nonce` closing sequence. This is a HARDER guarantee than stripping
 * `<<<`/`>>>` globally, which would also corrupt legitimate content living
 * INSIDE the fence (Python doctests `>>> foo()`, JS/Java `x >>> 2`, git
 * conflict markers `<<<<<<< HEAD`).
 */
export function fenceUntrusted(tag: string, content: string, nonce: string): string {
  return `<<<${tag}:${nonce}\n${content}\n${tag}:${nonce}>>>`;
}

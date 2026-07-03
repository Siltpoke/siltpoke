// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
// Render active user-facts into the chat
// system prompt so the pet's replies reflect what it knows about the user.
// Pure + synchronous: no I/O, fully unit-testable without a daemon.
import type { CoreMemory, Fact } from "./memory";

/**
 * The single active-fact predicate for the recall leg.
 *
 * Filters by `status === "active"` ONLY — never by `learned_from.stream`. The two
 * highest-value real facts (language preference + explanation level) carry
 * `learned_from: null`, so a stream filter would silently drop exactly the facts
 * that make the pet feel like it knows the user.
 */
export function readActiveFacts(memory: Pick<CoreMemory, "facts">): Fact[] {
  return memory.facts.filter((f) => f.status === "active");
}

// Anti-over-steer framing. Facts are framed as background KNOWLEDGE the model
// applies by judgment, not COMMANDS it executes unconditionally — a command
// ("always reply in Chinese") fires every turn and reads as robotic; background
// context can be overridden by conversational signal. The style-vs-profile logic
// is carried here by instruction, so no per-fact `kind` tag is needed at this scale.
const FRAMING = [
  "The above is background context about the user — things you have learned about them over time.",
  "Weave it into your replies naturally, only when genuinely relevant to what they are asking.",
  "Do not recite these facts back or force them into unrelated replies.",
  "Style preferences (language, explanation level, tone) shape your default replies;",
  "personal details are for natural warmth, never unprompted insertion.",
].join(" ");

/**
 * Render active user-facts into a `<user_context>` block for the chat system prompt.
 *
 * - Empty input → `""` (no scaffold, no broken prompt).
 * - Pinned facts first, then as-stored (stable sort preserves intra-group order).
 * - Self-contained `fact.text` bullets (facts are already written standalone, e.g.
 *   "the user prefers responses in Chinese").
 * - Anti-over-steer framing appended after the block.
 *
 * Returns the block alone (no leading separator); the caller composes spacing.
 */
export function buildUserContextBlock(facts: readonly Fact[]): string {
  if (facts.length === 0) return "";
  const ordered = [...facts].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const bullets = ordered.map((f) => `- ${f.text}`).join("\n");
  return `<user_context>\n${bullets}\n</user_context>\n\n${FRAMING}`;
}

// ── Communication-style vs personal-profile classification ──
//
// The Brain/critic recall injects ONLY communication-style facts (how the user
// wants to be talked to: language, explanation level, tone). Personal-profile
// facts (boyfriend, favourite colour, pets) are noise for a code review and stay
// chat-only. The `kind` field carries the split; `classifyFactKind` only SEEDS
// it once (the injection path reads the persisted field, never the classifier).

// Lowercase substrings that signal a communication-style fact. Chosen to hit the
// real style facts ("prefers responses in Chinese", "prefers beginner-friendly
// explanations") without matching profile facts (Daniel / pink / cats / creamer).
const STYLE_SIGNALS = [
  "chinese",
  "中文",
  "english",
  "language",
  "respond",
  "response",
  "reply",
  "explain",
  "explanation",
  "beginner",
  "jargon",
  "expertise",
  "concise",
  "verbose",
  "tone",
  "communication style",
  "technical level",
];

/**
 * Deterministic seed classifier — communication-style vs personal-profile.
 * Used ONLY to seed `fact.kind` once (e.g. backfilling legacy facts); never on
 * the Brain injection path, which reads the persisted `kind` field.
 */
export function classifyFactKind(text: string): "style" | "profile" {
  const t = text.toLowerCase();
  return STYLE_SIGNALS.some((s) => t.includes(s)) ? "style" : "profile";
}

/**
 * Seed `kind` on every fact that doesn't have one yet (legacy / untagged), using
 * `classifyFactKind`. Idempotent — already-tagged facts are returned unchanged.
 * Pure: returns a new memory object, never mutates.
 */
export function backfillFactKind<T extends Pick<CoreMemory, "facts">>(memory: T): T {
  return {
    ...memory,
    facts: memory.facts.map((f) =>
      f.kind === "style" || f.kind === "profile"
        ? f // already tagged — leave it (idempotent)
        : { ...f, kind: classifyFactKind(f.text) },
    ),
  };
}

/**
 * The Brain/critic recall filter: active facts tagged `kind:"style"` only.
 * Reads the persisted field — never the classifier. `null` (untagged) and
 * `profile` facts are excluded, so profile trivia can never leak into a critique.
 */
export function readActiveStyleFacts(memory: Pick<CoreMemory, "facts">): Fact[] {
  return memory.facts.filter((f) => f.status === "active" && f.kind === "style");
}

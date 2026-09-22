// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Pure detection of explicit "remember this" intent in a chat message.
 *
 * 🟢 Deterministic, no I/O, no LLM — the capture routing decision is made from
 * code (security rule: routing booleans never come from an LLM). The caller
 * (POST /api/chat) persists the payload via captureChatFactCore.
 *
 * Returns { hit, payload }:
 *   - hit:false               → not a remember-intent (no marker, or a recall question)
 *   - hit:true,  payload:""   → trigger-only ("记住") — caller asks what to remember
 *   - hit:true,  payload:"…"  → fact text (marker + separator stripped, trailing
 *                               sentence punctuation removed)
 */

// Start-anchored markers, case-insensitive. Sorted longest-first so a shorter
// marker never shadows a longer one that the message actually starts with.
const MARKERS: readonly string[] = [
  "note that",
  "remember",
  "记一下",
  "帮我记",
  "别忘了",
  "记住",
  "记下",
].sort((a, b) => b.length - a.length);

// Question particles that flip a marker-prefixed message into a recall question
// ("remember when we…?" / "记住这个吗") — false-negative is the safe direction.
const QUESTION_PARTICLE = /[吗嗎?？]$/;

// Separator allowed immediately after the marker: one of ：:，, or whitespace.
const LEADING_SEPARATOR = /^[：:，,\s]+/;

// Sentence-final punctuation stripped from the END of the stored text only.
const TRAILING_PUNCTUATION = /[。.!！]+$/;

export function detectRememberIntent(message: string): {
  hit: boolean;
  payload: string;
} {
  const miss = { hit: false, payload: "" } as const;
  const trimmed = message.trim();
  if (trimmed.length === 0) return miss;

  // Recall-disambiguation: a marker-prefixed message that ends with a question
  // particle is a recall question, not a save (Contingency 1).
  if (QUESTION_PARTICLE.test(trimmed)) return miss;

  const lower = trimmed.toLowerCase();
  const marker = MARKERS.find((m) => lower.startsWith(m.toLowerCase()));
  if (!marker) return miss;

  // Slice the marker off the original-case string (preserve payload casing),
  // drop one optional separator + surrounding whitespace, strip trailing
  // sentence punctuation, then trim.
  const rest = trimmed
    .slice(marker.length)
    .replace(LEADING_SEPARATOR, "")
    .replace(TRAILING_PUNCTUATION, "")
    .trim();

  return { hit: true, payload: rest };
}

// ---------------------------------------------------------------------------
// looksLikeFactStatement — cheap deterministic pre-filter for auto-capture.
//
// Decides if a plain chat message *looks like* it states a durable personal
// fact, so the caller only pays for a Haiku extraction on fact-like turns
// (security rule: gate the paid call from code). False-negative-safe — a miss
// just means the user falls back to explicit "记住 X". Pure, no I/O.
// ---------------------------------------------------------------------------

// Floor: too-short messages ("ok" / "嗯") can't carry a durable fact.
// Tradeoff (intentional): a 3-char fact like "我爱猫" is rejected here too —
// false-negative-safe, the user can fall back to explicit "记住 我爱猫".
const MIN_FACT_LEN = 4;

// A trailing question particle flips the message into a recall question
// ("你记得我什么吗?" / "do you like me?") — never a statement of fact.
const FACT_QUESTION_PARTICLE = /[?？吗嗎]$/;

// First-person durable markers (zh) — substring match is fine for CJK.
const ZH_FACT_MARKERS: readonly string[] = [
  "我喜欢",
  "我爱",
  "我讨厌",
  "我不喜欢",
  "我是",
  "我叫",
  "我的",
  "我在用",
  "我用",
  "我不用",
  "我在做",
  "我住",
  "我会",
  "我习惯",
  "我通常",
  "记得我",
];

// Correction-shaped markers (zh) — a correction can carry the durable fact
// WITHOUT any first-person marker ("不是猫派，是狗派"). These ONLY open the
// gate (recall-oriented design); they never
// classify — the extractor + the runner's layer-2 re-derivation decide what,
// if anything, gets written. Over-admission (e.g. "不对，13×7=91") is
// acceptable at this layer: the extractor's durable-first-person contract
// rejects it downstream. Substring match is fine for CJK.
const ZH_CORRECTION_MARKERS: readonly string[] = [
  "不对",
  "其实",
  "搞错了",
  "记错了",
  // Temporal-update phrasing ("我现在是狗派了") — a temporal adverb between 我
  // and the verb defeats the contiguous first-person markers ("我现在是" ∌
  // "我是"). "我现在" is the first-person-anchored form; the verb-anchored
  // form lives in ZH_TEMPORAL_UPDATE below. A BARE "现在" was rejected in
  // review: it's everywhere in ordinary dev-chat ("现在这段代码
  // 还有 bug") and each gate admission is a paid extraction — the anchor keeps
  // this class without opening the gate on every "now" sentence.
  "我现在",
];

// Verb-anchored temporal update ("现在用 pnpm 不用 bun 了", "现在改用 X"):
// 现在 followed within 2 chars by a durable-state verb. Same gate-only role.
const ZH_TEMPORAL_UPDATE = /现在.{0,2}(是|用|做|养|住|喝|不)/;

// "不是…是" negation-plus-restatement shape ("我不是猫派，是狗派").
const ZH_NEGATE_RESTATE = /不是[\s\S]+是/;

// Correction-shaped markers (en) — same gate-only role as the zh set.
// "no," counts only when LEADING: embedded "no," is plain chatter.
// ("i'm not" needs no entry — /\bi'm\b/ in EN_FACT_MARKERS already admits it.)
const EN_CORRECTION_MARKERS: readonly RegExp[] = [
  /\bactually\b/,
  /^no[,，]/,
  /that's wrong/,
];

// First-person durable markers (en) — word-boundary anchored + case-insensitive
// so "myth"/"army" never trip "my " and "iliad" never trips "I like".
const EN_FACT_MARKERS: readonly RegExp[] = [
  /\bi like\b/,
  /\bi love\b/,
  /\bi hate\b/,
  /\bi prefer\b/,
  /\bi'm\b/,
  /\bi am\b/,
  /\bmy\b/,
  /\bi use\b/,
  /\bi don't use\b/,
  /\bi work on\b/,
  /\bi live\b/,
  /\bi usually\b/,
  /\bremember i\b/,
];

/** True if the trimmed message is a command (leading `/`) or dominated by code
 *  (a fenced ``` block / inline backticks leaving little prose). */
function isCommandOrCode(trimmed: string): boolean {
  if (trimmed.startsWith("/")) return true;
  if (!trimmed.includes("`")) return false;
  // Strip fenced blocks (closed + unclosed) and inline code, then see how much
  // prose is left. Almost nothing → the message is essentially code.
  const prose = trimmed
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/```[\s\S]*$/g, " ")
    .replace(/`[^`]*`/g, " ")
    .trim();
  return prose.length < MIN_FACT_LEN;
}

// Flat scan groups — marker SEMANTICS stay documented on their source arrays
// above; the gate itself is one substring pass + one regex pass. Correction
// markers sit AFTER the cheap rejects by construction: a correction-phrased
// question ("不对吗？") or command/code turn is rejected before any scan, while
// a plain "不对，…" correction hits no reject (length/question/code checks
// don't key on it). ZH_NEGATE_RESTATE rides the lowercased pass — CJK is
// case-invariant, so testing it against `lower` is equivalent.
const SUBSTRING_MARKERS: readonly string[] = [...ZH_FACT_MARKERS, ...ZH_CORRECTION_MARKERS];
const REGEX_MARKERS: readonly RegExp[] = [
  ZH_NEGATE_RESTATE,
  ZH_TEMPORAL_UPDATE,
  ...EN_FACT_MARKERS,
  ...EN_CORRECTION_MARKERS,
];

export function looksLikeFactStatement(message: string): boolean {
  const trimmed = message.trim();
  // Cheap rejects FIRST (short / question / command-or-code), before any scan.
  if (trimmed.length < MIN_FACT_LEN) return false;
  if (FACT_QUESTION_PARTICLE.test(trimmed)) return false;
  if (isCommandOrCode(trimmed)) return false;

  if (SUBSTRING_MARKERS.some((m) => trimmed.includes(m))) return true;
  const lower = trimmed.toLowerCase();
  return REGEX_MARKERS.some((re) => re.test(lower));
}

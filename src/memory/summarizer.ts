// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Summarizer Brain call + candidate Zod schema.
 *
 * PQ3 — extraction schema (candidate object)
 * PQ8 — reflexion integration (cross-dismiss pattern input)
 */

import { z } from "zod";
import { BrainError } from "../brain/brain";
import type { CallBrainOptions, BrainCallRawResult } from "../brain/brain";
import type { CommitSignal, CriticEventSummary } from "./coding-signal";

// ---------------------------------------------------------------------------
// Schemas + types
// ---------------------------------------------------------------------------

// Bug#4-B: claim cap raised 200→280. A fact claim should still be a single
// atomic sentence; 280 (tweet-length) is a safety margin for legitimately
// slightly-long facts, NOT licence to dump prose. Brevity is enforced by the
// prompt (structure > rules) — the cap is the backstop.
const CLAIM_MAX_CHARS = 280;

// Max candidates accepted per consolidation run. Excess valid candidates are
// truncated (Bug#4-A: truncate, never reject the whole batch).
const MAX_CANDIDATES = 20;

export const candidateSchema = z.object({
  // Memory Book (Change A) — the summarizer states WHY this is worth saving
  // BEFORE the action verdict (reasoning-before-verdict; structure > rules).
  // Optional so pre-change output stays valid. ≤280 chars (PII-filtered + capped
  // at apply time). The save DECISION must not key off this prose.
  why_worth_saving: z.string().optional(),
  action: z.enum(["add", "update", "retire", "skip"]),
  candidate_claim: z.string().max(CLAIM_MAX_CHARS),
  evidence_quote: z.string().max(240).nullable(),
  suggested_confidence: z.number().min(0).max(1),
  supersedes_id: z.string().nullable(),
  // Optional so existing summarizer output (emits neither yet)
  // stays valid; a later prompt change starts populating `stability`.
  // `stability` mirrors the factSchema enum; code floor defaults invalid→durable.
  stability: z.enum(["permanent", "durable", "time-bound"]).optional(),
  // The prompt resolves a temporal expression to an ISO timestamp
  // for `time-bound` candidates; apply-candidates carries it onto the fact.
  // Expiry BEHAVIOR (acting on this) is separate — this only threads the field through.
  expires_at: z.string().nullable().optional(),
  // `source` mirrors factSchema.learned_from — the write path copies it through
  // so provenance is no longer null-dropped at apply time.
  source: z
    .object({
      stream: z.enum(["chat", "critique", "dismissal", "remember", "commit"]),
      session_id: z.string().nullable(),
    })
    .nullable()
    .optional(),
});

export type Candidate = z.infer<typeof candidateSchema>;

// Type anchor for SummarizerOutput. NOT the runtime validator on the hot path:
// callSummarizerBrain validates the outer shape + each candidate individually
// (Bug#4-A) so one bad candidate can't reject the batch. This whole-array schema
// would reject a 25-element array outright; the runtime path truncates instead.
// Per-item schema for session_summaries entries (used in callSummarizerBrain
// per-item validation loop — mirrors Bug#4-A candidate pattern).
const sessionSummaryItemSchema = z.object({
  session_id: z.string(),
  summary: z.string().max(200),
});

export const summarizerOutputSchema = z.object({
  candidates: z.array(candidateSchema).max(MAX_CANDIDATES),
  // Optional so existing summarizer calls that don't emit this field stay
  // valid. These get written to chat_sessions.
  session_summaries: z
    .array(sessionSummaryItemSchema)
    .optional(),
});

export type SummarizerOutput = z.infer<typeof summarizerOutputSchema>;

export type SummarizerContext = {
  activeFacts: Array<{ id: string; claim: string; confidence: number }>;
  recentCritiques: string[];
  recentChat: string[];
  recentDismissals: Array<{
    rule_category: string;
    reason: string;
    date: string;
  }>;
  // Sessions whose summary field is still null. This gets populated from the
  // JSONL store; buildSummarizerContext defaults it to [] so the type
  // compiles cleanly before that wiring is in place.
  sessionsNeedingSummary: Array<{
    id: string;
    started_at: string;
    message_count: number;
    excerpt: string;
  }>;
  // Coding-activity signal (commits + rubric-category counts)
  // distilled from git log + critic-event archive since last consolidation.
  // Optional so older test fixtures stay valid; buildSummarizerContext
  // always populates it (defaults to empty commits / zero criticSummary).
  codingActivity?: {
    commits: CommitSignal[];
    criticSummary: CriticEventSummary;
  };
};

// ---------------------------------------------------------------------------
// BrainFn type — mirrors callBrainRaw signature for dependency injection.
// Uses the raw variant so that the summarizer's own schema validation applies
// instead of the critic-shaped brainOutputSchema checked inside callBrain.
// ---------------------------------------------------------------------------

export type BrainFn = (opts: CallBrainOptions) => Promise<BrainCallRawResult>;

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const FACTS_CAP = 200;
const CRITIQUES_CAP = 50;
const DISMISSALS_CAP = 50;

export function assembleSummarizerPrompt(context: SummarizerContext): string {
  const parts: string[] = [
    "EXISTING ACTIVE FACTS:",
  ];

  const facts = context.activeFacts.slice(0, FACTS_CAP);
  if (facts.length === 0) {
    parts.push("(none)");
  } else {
    for (const f of facts) {
      parts.push(`- [${f.id}] ${f.claim} (confidence: ${f.confidence.toFixed(2)})`);
    }
  }

  parts.push("", "RECENT CRITIQUES (signal about user state):");
  const critiques = context.recentCritiques.slice(0, CRITIQUES_CAP);
  if (critiques.length === 0) {
    parts.push("(none)");
  } else {
    for (const c of critiques) {
      parts.push(`- ${c}`);
    }
  }

  parts.push("", "RECENT DISMISSED CRITIQUES (negative signal):");
  const dismissals = context.recentDismissals.slice(0, DISMISSALS_CAP);
  if (dismissals.length === 0) {
    parts.push("(none)");
  } else {
    for (const d of dismissals) {
      parts.push(`- [${d.date}] category=${d.rule_category} reason=${d.reason}`);
    }
  }

  parts.push("", "RECENT CHAT (what the user said — primary durable-preference signal):");
  const chat = context.recentChat.slice(0, 30); // matches CHAT_CAP in chat-signal.ts
  if (chat.length === 0) {
    parts.push("(none)");
  } else {
    for (const c of chat) {
      parts.push(`- ${c}`);
    }
  }

  // Coding-activity signal (commits + rubric-category counts).
  // Defensive access: codingActivity is optional on SummarizerContext so older
  // fixtures remain valid; buildSummarizerContext always populates it.
  parts.push("", "RECENT CODING ACTIVITY (commits + critic patterns since last summary — durable working-style / project-context signal):");
  const ca = context.codingActivity ?? { commits: [], criticSummary: { byCategory: {}, total: 0 } };
  if (ca.commits.length === 0 && ca.criticSummary.total === 0) {
    parts.push("(none)");
  } else {
    for (const c of ca.commits) {
      parts.push(`- commit ${c.subject} (${c.files.length} files, +${c.additions}/-${c.deletions})`);
    }
    const cats = Object.entries(ca.criticSummary.byCategory)
      .map(([k, n]) => `${k} ×${n}`)
      .join(", ");
    if (cats) parts.push(`- critic patterns: ${cats}`);
    parts.push(
      "Interpretation: a critic pattern recurring across these commits (e.g. the same rubric category flagged 3+ times) is a DURABLE working-style tendency ABOUT THE DEVELOPER — it passes the durability test (generalizable + recurrent + stable + about-user), so emit it as a fact (stream=\"commit\") when decision-relevant. A theme sustained across multiple commits is durable project-context. Still skip a single one-off commit with no pattern.",
    );
  }

  // Sessions needing a one-line summary. Capped at 20 to stay well within
  // the context window.
  parts.push("", "SESSIONS NEEDING A ONE-LINE SUMMARY:");
  const needing = context.sessionsNeedingSummary.slice(0, 20);
  if (needing.length === 0) {
    parts.push("(none)");
  } else {
    for (const s of needing) {
      parts.push(`- [${s.id}] (${s.message_count} msgs)`);
      parts.push(`  excerpt: ${s.excerpt.replace(/\s+/g, " ").slice(0, 400)}`);
    }
    parts.push(
      "For EACH session id above, emit one entry in `session_summaries`: a single",
      "factual line (≤140 chars, no first person) summarizing what that chat was about.",
    );
  }

  // When sessions need summaries, tell the model the full emit shape so it knows
  // to populate session_summaries alongside candidates. Keep it candidates-only
  // when there are no sessions — don't confuse the model on normal runs.
  const emitShape = needing.length > 0
    ? 'Emit JSON: { "candidates": [...], "session_summaries": [{"session_id": "...", "summary": "..."}] }'
    : 'Emit JSON: { "candidates": [...] }';

  parts.push(
    "",
    emitShape,
    "Each candidate:",
    "- why_worth_saving: FIRST, write one sentence on why this fact is durable + decision-relevant to remember about the developer (or why it is noise). ≤280 chars. No file paths or email addresses. This field is for human display and provenance only — your action verdict must still be based on the DECISION-RELEVANCE GATE and DURABILITY TEST below, not on this prose.",
    "- action: \"add\" | \"update\" | \"retire\" | \"skip\"",
    "- candidate_claim: ≤280 chars — ONE atomic fact about the user, distilled. Not a paste of the input.",
    "- evidence_quote: a verbatim snippet from inputs supporting the claim, or null",
    "- suggested_confidence: 0.0–1.0",
    "- supersedes_id: existing fact id when action='update' or 'retire'; null for 'add'/'skip'",
    "- stability: \"permanent\" | \"durable\" | \"time-bound\" — how long this fact stays true (see STABILITY AXIS below)",
    "- expires_at: ISO-8601 timestamp ONLY for stability=\"time-bound\" (resolve the temporal expression to an absolute time); null otherwise",
    "- source: { stream, session_id } — which input signal this fact was primarily distilled from; stream must be one of \"chat\"|\"critique\"|\"dismissal\"|\"remember\"|\"commit\"; session_id is the chat session id or null; for facts distilled from the RECENT CODING ACTIVITY section use stream=\"commit\" and session_id=null",
    "",
    "STABILITY AXIS (sibling to the durability test — classify every emitted candidate):",
    "- permanent: identity / confirmed long-standing preferences / hard constraints (e.g. \"user's name is X\", \"never uses framework Y\").",
    "- durable: working-style, general preferences, project context that holds across sessions but could evolve (this is the DEFAULT when unsure).",
    "- time-bound: anything carrying a temporal expression (\"until Friday\", \"this sprint\", \"for the next two weeks\"). Resolve that expression to an absolute ISO-8601 `expires_at`.",
    "",
    "Rules:",
    "- Maximum 20 candidates per call",
    "- 'skip' means \"this existing fact is still relevant, bump last_seen_at\" — supersedes_id required",
    "- 'retire' means \"this fact is now wrong or stale\" — supersedes_id required",
    "- 'update' means \"claim has changed since last summary\" — supersedes_id required, candidate_claim replaces",
    "- 'add' means new fact discovered — supersedes_id null",
    "- DECISION-RELEVANCE GATE (is this decision-relevant?): only emit a candidate if you can name the future use it serves — will it change a future code critique, prevent re-asking the user, or give cross-session coherence? If not, use 'skip'.",
    "- DURABILITY TEST (abstain unless 3+ hold): is the fact (a) generalizable beyond this one task, (b) recurrent / reinforced, (c) stable across sessions, (d) about the USER (their prefs/goals/constraints/working-style)? A one-off transient Q&A fails this — do not store it.",
  );

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SUMMARIZER_SYSTEM_PROMPT =
  "You are Siltpoke's memory summarizer. Review the inputs and decide which facts to add, update, retire, or skip.";

const DEFAULT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Brain call
// ---------------------------------------------------------------------------

export async function callSummarizerBrain(
  context: SummarizerContext,
  opts?: { brainFn?: BrainFn },
): Promise<SummarizerOutput> {
  const { callBrainRaw } = await import("../brain/brain");
  // Use callBrainRaw (not callBrain) so the critic-shaped brainOutputSchema
  // validation inside callBrain does not reject the summarizer's {candidates}
  // response. The summarizer validates its own output via summarizerOutputSchema.
  // Last-resort fallback ONLY (single-brain S2, task 8): consolidate.ts, the
  // sole production caller, always injects a role-routed `brainFn`
  // (`makeRoleRawBrain(homeBase, "extract")`) — this default only fires for a
  // direct caller (e.g. a test or future consumer) that supplies no homeBase.
  const brainFn = opts?.brainFn ?? callBrainRaw;

  const contextBundle = assembleSummarizerPrompt(context);

  // No `model` field: a role-routed brainFn (the production seam) forces its
  // own resolved model internally; the fallback callBrainRaw applies ITS OWN
  // default (the undated alias, ../brain/brain.ts DEFAULT_MODEL) when `model`
  // is omitted — NOT the dated pinned snapshot this fn used to hardcode
  // (that pin now lives only in the role-brain/registry resolution path). A
  // hypothetical direct caller that supplies no `brainFn` gets that unpinned
  // default, not byte-identical pre-migration behavior.
  const raw = await brainFn({
    systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
    contextBundle,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  // raw.output is already parsed JSON (callBrain does JSON.parse internally).
  //
  // Bug#4-A: validate the OUTER shape only ({ candidates: [...] }). A genuinely
  // malformed response (wrong shape, e.g. a critic-shaped payload) still throws.
  // But the candidate ARRAY is validated per-element: invalid candidates are
  // dropped, valid ones kept. Previously one over-long claim failed the whole
  // batch via summarizerOutputSchema → every good fact lost → 0 facts written.
  const outer = z
    .object({
      candidates: z.array(z.unknown()),
      // Pass session_summaries through as unknowns for per-item validation below.
      session_summaries: z.array(z.unknown()).optional(),
    })
    .safeParse(raw.output);
  if (!outer.success) {
    throw new BrainError(
      "Summarizer response failed schema validation",
      outer.error,
      undefined,
      undefined,
      raw.output,
    );
  }

  const valid: Candidate[] = [];
  let dropped = 0;
  for (const item of outer.data.candidates) {
    const parsed = candidateSchema.safeParse(item);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      dropped++;
    }
  }

  if (dropped > 0) {
    console.error(
      `[siltpoke memory] summarizer dropped ${dropped} invalid candidate(s); kept ${valid.length}`,
    );
  }

  // Per-item validation for session_summaries — mirrors the Bug#4-A candidate
  // pattern above: one malformed entry is skipped, not fatal. Field absent →
  // undefined (valid; summarizerOutputSchema marks it optional).
  let validSessionSummaries: Array<{ session_id: string; summary: string }> | undefined;
  if (outer.data.session_summaries !== undefined) {
    validSessionSummaries = [];
    let droppedSessions = 0;
    for (const item of outer.data.session_summaries) {
      const parsedItem = sessionSummaryItemSchema.safeParse(item);
      if (parsedItem.success) {
        validSessionSummaries.push(parsedItem.data);
      } else {
        droppedSessions++;
      }
    }
    if (droppedSessions > 0) {
      console.error(
        `[siltpoke memory] summarizer dropped ${droppedSessions} invalid session_summary item(s); kept ${validSessionSummaries.length}`,
      );
    }
  }

  // Truncate excess valid candidates rather than rejecting the batch.
  if (valid.length > MAX_CANDIDATES) {
    console.error(
      `[siltpoke memory] summarizer truncated ${valid.length} candidates to ${MAX_CANDIDATES}`,
    );
    return { candidates: valid.slice(0, MAX_CANDIDATES), session_summaries: validSessionSummaries };
  }

  return { candidates: valid, session_summaries: validSessionSummaries };
}

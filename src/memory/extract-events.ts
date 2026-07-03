// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Episodic-event extractor — isolated LLM component.
 *
 * The EPISODIC sibling of `summarizer.ts`. Where the summarizer distills durable
 * PROFILE facts (who the user is), this extractor pulls EVENTS (what happened:
 * shipped X, struggled with Y, discussed Z) from the SAME `SummarizerContext`.
 * The two are deliberately split (one job per LLM component): a candidate that is
 * a durable preference belongs to the summarizer, an occurrence belongs here.
 *
 * Mirrors `callSummarizerBrain`'s Bug#4-A per-item validation loop (outer shape
 * checked, each item `.safeParse`d, bad items dropped not fatal, excess truncated)
 * with ONE deliberate difference: this NEVER throws. Both a malformed OUTER shape
 * AND a thrown brain error (spawn failure / timeout / non-JSON stdout from
 * `callBrainRaw`) degrade to `[]`. Event capture is best-effort substrate (matches
 * the `extractDurableFacts` never-throw contract) — a bad episodic batch, or a
 * transient brain failure, must never break the consolidation run this wires into.
 *
 * GROUNDING CAVEAT: commit sources are real (the `%H` sha is rendered in the
 * prompt), but `recentCritiques` / `recentChat` reach here as `string[]` with
 * NO ids in the rendered prompt. So for `stream:"critique"|"chat"` the model
 * can only FABRICATE a `sources[].ref`, and `eventSourceSchema` validates
 * shape, not existence. Per the project's "LLM output as untrusted input"
 * rule, future work MUST (a) thread real critique/session ids into the
 * context AND (b) validate each `sources[].ref` against those known-id sets in
 * code (dropping unverifiable refs) before these fragments are trusted as
 * grounded. Do not assume this caveat is resolved by this module alone.
 */
import { z } from "zod";
import type { BrainCallRawResult, CallBrainOptions } from "../brain/brain";
import { eventSourceSchema, type EventFragmentDraft } from "./event-fragment";
import type { SummarizerContext } from "./summarizer";

// ---------------------------------------------------------------------------
// Schema + constants
// ---------------------------------------------------------------------------

const EVENT_TEXT_MAX = 280;

/** Max event candidates accepted per run. Excess valid candidates are truncated. */
export const EVENT_EXTRACT_MAX = 20;

/**
 * `entities` + `confidence` are optional here (unlike `eventFragmentSchema`,
 * which defaults them) — the extractor maps them to the draft with the same
 * defaults (`[]` / 0.7) so the emitted draft is complete.
 */
/**
 * LLM-untrusted entity ref. The real model emits free-form entity `type` values
 * ("module", "ui-surface", "system", …) OUTSIDE the strict `EntityType` enum.
 * Rejecting on a bad `type` would fail the WHOLE candidate — live smoke caught
 * real Haiku output dropping 100% of candidates on exactly this mismatch (unit
 * tests passed because their stub entities used in-enum types). Coerce an
 * out-of-enum `type` to null via `.catch(null)` — the `name` is what matters
 * (entityKey groups by name; `type` is reserved/unconsumed). Structure > rules:
 * fix the parse, don't rely on the prompt to constrain the enum.
 */
const lenientEntityRefSchema = z.object({
  name: z.string(),
  type: z
    .enum(["person", "place", "hobby", "project", "thing", "other"])
    .nullable()
    .optional()
    .catch(null),
});

export const eventCandidateSchema = z.object({
  text: z.string().max(EVENT_TEXT_MAX),
  occurred_at: z.string(),
  // `eventSourceSchema.kind` also permits "session", but no prompt section feeds a
  // session id here yet — it is reserved until a later change threads real session ids in.
  // GROUNDING: critique/chat `ref`s are model-fabricated and NOT verifiable in this
  // module (validate-against-known-ids is future work — see module header caveat).
  sources: z.array(eventSourceSchema).min(1),
  entities: z.array(lenientEntityRefSchema).optional(),
  confidence: z.number().min(0).max(1).optional(),
  stream: z.enum(["commit", "critique", "chat"]),
});

export type EventCandidate = z.infer<typeof eventCandidateSchema>;

// BrainFn is re-exported from summarizer's raw-call contract (same signature) so
// callers can stub the same way they do for the summarizer.
type BrainFn = (opts: CallBrainOptions) => Promise<BrainCallRawResult>;

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const CRITIQUES_CAP = 50;
const CHAT_CAP = 30;

export function assembleEventPrompt(context: SummarizerContext): string {
  const parts: string[] = [];

  // Coding activity — the primary event source (commits carry a real sha to cite).
  parts.push("RECENT CODING ACTIVITY (commits + critic patterns since last run):");
  const ca = context.codingActivity ?? {
    commits: [],
    criticSummary: { byCategory: {}, total: 0 },
  };
  if (ca.commits.length === 0 && ca.criticSummary.total === 0) {
    parts.push("(none)");
  } else {
    for (const c of ca.commits) {
      parts.push(
        `- commit ${c.sha} @ ${c.date}: ${c.subject} (${c.files.length} files, +${c.additions}/-${c.deletions})`,
      );
    }
    const cats = Object.entries(ca.criticSummary.byCategory)
      .map(([k, n]) => `${k} ×${n}`)
      .join(", ");
    if (cats) {
      parts.push(`- critic patterns: ${cats}`);
    }
  }

  parts.push("", "RECENT CRITIQUES (what was flagged):");
  const critiques = context.recentCritiques.slice(0, CRITIQUES_CAP);
  parts.push(critiques.length === 0 ? "(none)" : critiques.map((c) => `- ${c}`).join("\n"));

  parts.push("", "RECENT CHAT (what the user said / discussed):");
  const chat = context.recentChat.slice(0, CHAT_CAP);
  parts.push(chat.length === 0 ? "(none)" : chat.map((c) => `- ${c}`).join("\n"));

  parts.push(
    "",
    'Emit JSON: { "events": [...] }',
    "Extract EVENTS — things that HAPPENED over this window: a feature shipped, a",
    "bug fought for days, a topic discussed, a recurring struggle. Do NOT restate",
    "profile / preference facts about who the user is — that is the summarizer's job;",
    "this layer records occurrences, not identity.",
    "Each event:",
    `- text: ≤${EVENT_TEXT_MAX} chars, THIRD-PERSON narrative of what happened (e.g. "Developer shipped X", "Struggled with Y for two days").`,
    "- occurred_at: ISO-8601 — resolve from the source signal's timestamp (the commit date, the chat/critique time).",
    '- sources: ≥1 grounding ref — { kind, ref } where kind is "commit"|"critique"|"session"|"chat"; ref is the commit sha / critique id / chat session id. Cite the sha from RECENT CODING ACTIVITY when the event is a commit.',
    "- entities: optional [{ name, type }] — people / projects / things the event touches.",
    "- confidence: optional 0.0–1.0.",
    '- stream: "commit" | "critique" | "chat" — which signal this event was drawn from.',
    "",
    "SEGMENTATION (Event Segmentation Theory): a topic/entity shift OR a time gap",
    "marks a distinct event — split those, don't merge unrelated happenings into one.",
    `Maximum ${EVENT_EXTRACT_MAX} events per call.`,
  );

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// System prompt + model
// ---------------------------------------------------------------------------

const EVENT_SYSTEM_PROMPT =
  "You are Siltpoke's episodic-event extractor. From the inputs, extract discrete events that happened — what the developer shipped, struggled with, or discussed — as short third-person narratives. You do NOT record durable profile facts (that is the summarizer's job).";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Brain call
// ---------------------------------------------------------------------------

/** Map a validated candidate → the pre-apply draft shape (id/timestamps assigned on apply). */
function toDraft(c: EventCandidate): EventFragmentDraft {
  return {
    text: c.text,
    occurred_at: c.occurred_at,
    sources: c.sources,
    entities: c.entities ?? [],
    confidence: c.confidence ?? 0.7,
    learned_from_stream: c.stream,
  };
}

export async function extractEventFragments(
  context: SummarizerContext,
  opts?: { brainFn?: BrainFn; modelOverride?: string },
): Promise<EventFragmentDraft[]> {
  const { callBrainRaw } = await import("../brain/brain");
  const brainFn = opts?.brainFn ?? callBrainRaw;
  const model = opts?.modelOverride ?? DEFAULT_MODEL;

  const contextBundle = assembleEventPrompt(context);

  // The brain call is guarded: callBrainRaw throws BrainError on spawn failure /
  // timeout / non-JSON stdout — the most common real failure class. Because this
  // wires into consolidate, a thrown error must NOT propagate and crash the
  // run; degrade to [] exactly like the malformed-shape path below (never-throw
  // contract, per the module header).
  let raw: BrainCallRawResult;
  try {
    raw = await brainFn({
      systemPrompt: EVENT_SYSTEM_PROMPT,
      contextBundle,
      model,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  } catch (err) {
    console.error(
      `[siltpoke memory] event extractor brain call failed; degrading to 0 events: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }

  // Best-effort degrade (differs from summarizer, which throws): a malformed
  // OUTER shape returns [] — episodic capture must never break consolidation.
  const outer = z.object({ events: z.array(z.unknown()) }).safeParse(raw.output);
  if (!outer.success) {
    return [];
  }

  const drafts: EventFragmentDraft[] = [];
  let dropped = 0;
  for (const item of outer.data.events) {
    const parsed = eventCandidateSchema.safeParse(item);
    if (parsed.success) {
      drafts.push(toDraft(parsed.data));
    } else {
      dropped++;
    }
  }

  if (dropped > 0) {
    console.error(
      `[siltpoke memory] event extractor dropped ${dropped} invalid event(s); kept ${drafts.length}`,
    );
  }

  if (drafts.length > EVENT_EXTRACT_MAX) {
    console.error(
      `[siltpoke memory] event extractor truncated ${drafts.length} events to ${EVENT_EXTRACT_MAX}`,
    );
    return drafts.slice(0, EVENT_EXTRACT_MAX);
  }

  return drafts;
}

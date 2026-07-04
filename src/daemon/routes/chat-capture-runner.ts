// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Real-time chat capture orchestration (Memory campaign).
 *
 * Lifted out of `src/daemon/routes/chat.ts` so the route stays under the 800-LOC
 * cap and the explicit ("记住 X") + conversational (plain fact statement) capture
 * paths share ONE persistence structure (readMemory → captureChatFactsCore →
 * writeMemory → truthful signal). Sharing the batch core is also what fixes the
 * truthfulness bug where the auto path emitted [SAVED] for a pure dedupe — both
 * paths now derive the signal from the same per-claim `deduped` flags.
 *
 * Chat-memory correction: the auto path additionally builds a
 * provenance-fenced candidate list from the SAME memory read, re-derives every
 * extractor verdict in code, and applies via `applyChatClaimsCore`.
 *
 * Best-effort: capture must NEVER block or fail the chat reply.
 * Any read/extract/core/write failure degrades to `{ signal: null }` (no marker)
 * and the reply still streams.
 */

import {
  applyChatClaimsCore,
  type ClaimOutcome,
  type ClassifiedClaim,
} from "../../memory/chat-claim-apply";
import type { CandidateFact, ExtractedFact } from "../../memory/extract-facts";
import type { CoreMemory } from "../../memory/memory";
import { detectRememberIntent, looksLikeFactStatement } from "../../memory/chat-capture";
import { numericallyEquivalent } from "../../memory/numeric-equivalence";
import { captureChatFactsCore } from "../../memory/transitions";

// Contradict-ladder thresholds. Routing reads ONLY these
// numbers against the extractor's NUMERIC confidence — never an LLM boolean
// (house security rule).
// Values stay 0.9/0.7. The paid calibration found Haiku's
// confidence curve is FLAT (it emits extremes, ~0.88-1.0), so every sweep row
// scored identically and the ladder is only a WEAK secondary guard: it cannot
// separate right from wrong verdicts by confidence alone. The load-bearing
// guards are the code-level ones in this file — target-in-candidate-list +
// numeric-equivalence downgrade (deriveClassifiedClaims) and the provenance
// fence (buildChatCandidates).
const T_HIGH = 0.9;
const T_MID = 0.7;

/**
 * Provenance fence: only facts the USER put in through a
 * conversational surface are nameable as correction targets. Commit / critique /
 * dismissal facts are filtered out BEFORE the LLM sees the list — unnameable by
 * construction. Legacy facts with `learned_from: null` are also EXCLUDED
 * (conservative: their stream is unverifiable, so they cannot be corrected from
 * chat; the /memory page remains the surface for those).
 */
const CANDIDATE_STREAMS: ReadonlySet<string> = new Set(["chat", "remember", "user"]);

/**
 * Story contingency: cap injected candidates when the fenced active set grows
 * beyond ~30 — top-K by recency (`last_seen_at`) this slice; similarity ranking
 * is a later track. Under the cap the store order is preserved untouched.
 */
const CANDIDATE_CAP = 30;

export type CaptureSignal = "saved" | "already_known" | "incomplete" | "corrected" | null;

/**
 * Provenance written onto a chat-captured fact's `save_reason` — surfaced as the
 * /memory "Why" line. Without it the row falls back to "no source recorded (early
 * memory)", which mislabels brand-new chat facts as legacy sourceless memories.
 * Explicit ("记住 X") vs conversational (auto-extract) get distinct wording.
 */
export const SAVE_REASON_EXPLICIT = "you asked me to remember this in chat";
export const SAVE_REASON_AUTO = "noticed while chatting";

export interface ChatCaptureResult {
  /** The capture outcome to steer a truthful ack; null → no marker this turn. */
  signal: CaptureSignal;
  /** Saved/known fact text(s), pre-joined for the marker template. */
  text: string;
}

export interface RunChatCaptureDeps {
  readMemory: (homeBase: string) => Promise<CoreMemory | null>;
  writeMemory: (homeBase: string, memory: CoreMemory) => Promise<void>;
  /**
   * Ledgered Haiku extraction (or an injected stub in tests). `candidates` is
   * the provenance-fenced active-fact list the extractor may classify against
   * (correction track); the real `extractDurableFacts` takes it as its third
   * parameter, and callers wired with a narrower 2-param function (chat.ts's
   * dep type) remain assignable — they simply never see candidates.
   */
  extractFacts: (
    message: string,
    deps: { homeBase: string; sessionId: string },
    candidates?: CandidateFact[],
  ) => Promise<ExtractedFact[]>;
  homeBase: string;
  sessionId: string;
  nowIso: () => string;
  /**
   * Correction rollback seam (default ON). `false` → candidates are
   * never built or passed, so the extractor degrades to add-only output and the
   * auto path behaves exactly as before this track (adds with dedupe only).
   */
  correctionEnabled?: boolean;
}

/**
 * Decide + persist a chat capture for one user turn, returning the marker signal.
 *
 * Routing (deterministic, from code — security rule, never an LLM boolean):
 *   (a) explicit "记住" trigger-only (no payload) → incomplete (no write).
 *   (b) explicit "记住 X" with payload           → save X via the batch core.
 *   (c) no marker BUT looksLikeFactStatement     → ONE ledgered Haiku extraction,
 *       then save the returned claims via the batch core.
 *   else                                         → no capture.
 *
 * The signal for a multi-claim batch is "saved" if ANY claim was a fresh save,
 * else "already_known" (every claim merely reaffirmed a known fact).
 */
export async function runChatCapture(
  message: string,
  deps: RunChatCaptureDeps,
): Promise<ChatCaptureResult> {
  const none: ChatCaptureResult = { signal: null, text: "" };
  const intent = detectRememberIntent(message);

  // (a) trigger-only "记住" with no content — ask what to remember, write nothing.
  if (intent.hit && intent.payload === "") {
    return { signal: "incomplete", text: "" };
  }

  // (b) explicit "记住 X" — deterministic, no paid call.
  if (intent.hit && intent.payload) {
    try {
      const mem = await deps.readMemory(deps.homeBase);
      if (!mem) return none;
      const { memory, saved } = captureChatFactsCore(
        mem,
        [{ text: intent.payload }],
        deps.nowIso,
        SAVE_REASON_EXPLICIT,
      );
      if (!saved.length) return none;
      await deps.writeMemory(deps.homeBase, memory);
      return {
        signal: saved[0]!.deduped ? "already_known" : "saved",
        text: saved[0]!.text,
      };
    } catch {
      // Best-effort: a read/core/write failure must never block the reply or emit
      // a false ack. Degrade to no marker.
      return none;
    }
  }

  // (c) conversational auto-capture — pay for ONE ledgered Haiku extraction only
  // after the cheap code pre-filter passes (gate the paid call from code).
  // Correction track: the SAME single call also classifies against the fenced
  // candidates; every verdict is re-derived in code before anything applies.
  if (!intent.hit && looksLikeFactStatement(message)) {
    return runAutoCapture(message, deps);
  }

  return none;
}

/**
 * Branch (c) body — the conversational auto-capture + correction pipeline
 * (extracted helper; `runChatCapture` stays the single routing entrypoint).
 * Best-effort like every capture path: any failure degrades to no marker.
 */
async function runAutoCapture(
  message: string,
  deps: RunChatCaptureDeps,
): Promise<ChatCaptureResult> {
  try {
    // Memory is read BEFORE the paid call (the candidate list needs it) —
    // still exactly ONE read + ONE write per turn. Hoisting also means a
    // null store now skips the paid extraction entirely (strictly cheaper
    // than the old extract-then-read order).
    const mem = await deps.readMemory(deps.homeBase);
    if (!mem) return { signal: null, text: "" };
    const correctionEnabled = deps.correctionEnabled !== false;
    const candidates = correctionEnabled ? buildChatCandidates(mem) : undefined;
    const extracted = await deps.extractFacts(
      message,
      { homeBase: deps.homeBase, sessionId: deps.sessionId },
      candidates,
    );
    if (!extracted.length) return { signal: null, text: "" };
    const claims = deriveClassifiedClaims(extracted, candidates ?? [], message);
    const { memory, results } = applyChatClaimsCore(mem, claims, deps.nowIso(), SAVE_REASON_AUTO);
    // Reference-equal memory = nothing changed (all claims dropped/blank) →
    // skip the write (a sub-floor contradict leaves the store untouched).
    // Atomicity: every non-dropped claim of the turn rides this ONE write.
    if (memory !== mem) await deps.writeMemory(deps.homeBase, memory);
    return signalFromOutcomes(results);
  } catch {
    // Best-effort: extraction is never allowed to block or break the reply.
    return { signal: null, text: "" };
  }
}

/**
 * Candidate build from the turn's already-loaded memory: ACTIVE
 * facts whose provenance passes the conversational fence (see CANDIDATE_STREAMS
 * — legacy `learned_from: null` excluded, conservative), capped at
 * CANDIDATE_CAP by `last_seen_at` recency when over. NOTE: hitting the cap is
 * currently silent — the runner has no logger/telemetry seam; wiring
 * "log the cap" lands with a future eval/telemetry pass.
 */
function buildChatCandidates(memory: CoreMemory): CandidateFact[] {
  const fenced = memory.facts.filter(
    (f) =>
      f.status === "active" &&
      f.learned_from !== null &&
      CANDIDATE_STREAMS.has(f.learned_from.stream),
  );
  const capped =
    fenced.length > CANDIDATE_CAP
      ? [...fenced]
          .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
          .slice(0, CANDIDATE_CAP)
      : fenced;
  return capped.map((f) => ({ id: f.id, text: f.text }));
}

/**
 * Contradict ladder — derived in code from the NUMERIC confidence
 * against the module-top constants, never from an LLM boolean. `undefined`
 * (model gave no number) → "pending": the conservative default, matching
 * `applyChatClaimsCore`'s missing-tier belt — never auto-retire without an
 * explicit high score, never silently drop a named contradiction. Below T_MID
 * → "drop" (a design ruling: below the floor discards).
 */
function contradictTier(confidence: number | undefined): "auto" | "pending" | "drop" {
  if (confidence === undefined) return "pending";
  if (confidence >= T_HIGH) return "auto";
  if (confidence >= T_MID) return "pending";
  return "drop";
}

/**
 * Layer-2 re-derivation (nl-edit.ts's target-validation
 * pattern ported in spirit): a restate/contradict verdict must name a target
 * from the candidate list (all active by construction) or it downgrades to a
 * plain add — never phantom-supersede. Contradict tier comes from
 * `contradictTier` alone. When candidates were never passed (rollback OFF or
 * empty fence) every claim is an add by this same rule.
 *
 * Guard-ordering note (deliberate asymmetry vs the apply core): target
 * validation runs BEFORE the tier here, so a sub-floor contradict naming a
 * NON-candidate target becomes a plain add (story contingency: absent/
 * phantom/outside-list → add, no confidence qualifier), while a sub-floor
 * contradict naming a VALID candidate is dropped inside the core (below
 * floor discards). Different failure classes, different rulings — the
 * contingency governs bad targets, the ladder governs weak verdicts.
 */
function deriveClassifiedClaims(
  extracted: ExtractedFact[],
  candidates: CandidateFact[],
  message: string,
): ClassifiedClaim[] {
  const candidateTextById = new Map(candidates.map((c) => [c.id, c.text]));
  return extracted.map((f): ClassifiedClaim => {
    const classification = f.classification ?? "add";
    const targetId = f.target_fact_id ?? null;
    const targetText = targetId === null ? undefined : candidateTextById.get(targetId);
    if (classification === "add" || targetId === null || targetText === undefined) {
      return { text: f.text, entities: f.entities, classification: "add", targetId: null };
    }
    // Numeric-specifics guard, promoted from prompt to CODE: the eval
    // calibration showed Haiku labels numeric-difference pairs ("我有 3 只猫" vs stored
    // "用户养了 2 只猫") contradict at 0.95-1.0 despite the prompt guard, and
    // its flat confidence curve means the ladder can't catch them. A numeric
    // difference is NOT a contradiction → downgrade to a coexisting add
    // (visible, no data loss — the conservative direction). The raw MESSAGE is
    // tested too: the extractor sometimes rephrases/translates the claim (eval
    // nt-en-01 answered an English message with a Chinese fact), and the
    // message preserves the surface the claim was derived from.
    //
    // Guards BOTH restate and contradict: a
    // numeric update mislabeled "restate" would otherwise reaffirm the STALE
    // number in place and ack [ALREADY KNOWN] — a false confirmation, worse
    // than the visible coexisting add.
    if (numericallyEquivalent(f.text, targetText) || numericallyEquivalent(message, targetText)) {
      return { text: f.text, entities: f.entities, classification: "add", targetId: null };
    }
    if (classification === "restate") {
      return { text: f.text, entities: f.entities, classification, targetId };
    }
    return {
      text: f.text,
      entities: f.entities,
      classification,
      targetId,
      tier: contradictTier(f.confidence),
    };
  });
}

/**
 * Map a turn's claim outcomes to the capture signal chat.ts renders.
 *
 * - Any replaced/proposed outcome → signal "corrected": `text` carries the
 *   PRE-RENDERED marker block from `buildClaimMarkers` (a correction turn can
 *   mix [SAVED]/[REPLACED]/[PROPOSED-REPLACE], which the single-signal legacy
 *   shape cannot carry through chat.ts's fixed buildCaptureMarker call).
 * - Otherwise → the legacy add-family shape, byte-identical to pre-track
 *   behavior (regression contract): SAVED if any claim was a fresh save,
 *   else ALREADY KNOWN; texts joined so many render as `[SAVED: "a"; "b"]`.
 * - All dropped (or nothing) → null signal, no marker.
 */
function signalFromOutcomes(results: ClaimOutcome[]): ChatCaptureResult {
  const acked = results.filter((r) => r.outcome !== "dropped");
  if (!acked.length) return { signal: null, text: "" };
  if (acked.some((r) => r.outcome === "replaced" || r.outcome === "proposed")) {
    return { signal: "corrected", text: buildClaimMarkers(acked) };
  }
  const texts: string[] = [];
  for (const r of acked) {
    if (r.outcome === "saved" || r.outcome === "reaffirmed") texts.push(r.text);
  }
  return {
    signal: acked.some((r) => r.outcome === "saved") ? "saved" : "already_known",
    text: texts.join('"; "'),
  };
}

/**
 * Always-on capture-honesty framing — injected whenever capture is wired,
 * even on a no-capture turn, so the model never hallucinates a save. The marker's
 * PRESENCE/ABSENCE is the signal; this framing forbids claiming a save without one.
 * Wording is load-bearing — original chat.ts literal, extended verbatim-in-voice
 * for the correction markers: the pet must never claim it replaced a memory
 * without a [REPLACED] marker. Marker names here stay COLON-FREE — the real
 * injected markers carry a colon ("[SAVED:"), which is how tests (and readers)
 * tell a live marker from this framing.
 */
export const CAPTURE_HONESTY =
  "You cannot save anything to long-term memory on your own. A separate capture system persists explicit remember-requests and signals you with a [SAVED]/[ALREADY KNOWN] marker; when it replaces an outdated memory it signals a [REPLACED] marker naming both the old and new text, and a replacement still awaiting the user's confirmation signals a [PROPOSED-REPLACE] marker. NEVER claim you saved or will remember something unless such a marker is present in this turn, and NEVER claim you replaced or updated a memory unless a [REPLACED] marker is present.";

/**
 * Build the capture marker for the turn — present only when capture fired,
 * steering a truthful ack from the same request that saved. Returns "" for a
 * null signal (no marker injected). Legacy wording kept byte-identical to the
 * original chat.ts literals; "corrected" passes through the pre-rendered block
 * (see `buildClaimMarkers` / `signalFromOutcomes`).
 */
export function buildCaptureMarker(signal: CaptureSignal, text: string): string {
  if (signal === "saved") {
    return `[SAVED: "${text}"] — You just persisted this fact to the user's long-term memory. Acknowledge naturally that you saved it.`;
  }
  if (signal === "already_known") {
    return `[ALREADY KNOWN: "${text}"] — You already remembered this; reassure the user it's kept. Do not claim a brand-new save.`;
  }
  if (signal === "incomplete") {
    return `[CAPTURE INCOMPLETE] — The user asked you to remember something but gave no content. Ask what they want you to remember. Do not claim you saved anything.`;
  }
  if (signal === "corrected") {
    // Pre-rendered per-outcome marker block — a correction turn can mix marker
    // kinds, which the single (signal, text) legacy shape cannot express.
    return text;
  }
  return "";
}

/** One marker line per claim outcome (dropped → none). See `buildClaimMarkers`. */
function markerForOutcome(o: ClaimOutcome): string {
  switch (o.outcome) {
    case "saved":
      return buildCaptureMarker("saved", o.text);
    case "reaffirmed":
      return buildCaptureMarker("already_known", o.text);
    case "replaced":
      return `[REPLACED: "${o.oldText}" → "${o.newText}"] — You just replaced an outdated memory with the user's correction. Acknowledge both sides naturally: what you used to remember and what you remember now.`;
    case "proposed":
      return `[PROPOSED-REPLACE: "${o.newText}" (pending the user's confirmation on the /memory page)] — The user's correction was saved as a PENDING replacement; the old memory stays in place until they confirm. Do NOT claim you replaced or updated anything yet.`;
    case "dropped":
      return ""; // A sub-floor contradict leaves no trace and gets no marker.
  }
}

/**
 * Correction-turn marker block (sibling of `buildCaptureMarker`): one
 * marker per non-dropped claim outcome, in outcome order, newline-joined.
 * Used only on turns with at least one replaced/proposed outcome — pure
 * add-family turns keep the legacy aggregate `[SAVED: "a"; "b"]` shape
 * (regression contract, see `signalFromOutcomes`).
 */
function buildClaimMarkers(results: ClaimOutcome[]): string {
  return results.map(markerForOutcome).filter(Boolean).join("\n");
}

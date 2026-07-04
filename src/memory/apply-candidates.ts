// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Apply summarizer candidates to memory via confidence tier routing.
 *
 * Confidence routes discard (<0.7); add path always born `pending`
 * (pending-first global); update path still tiers for the new-fact status.
 *
 * Pure function — no IO, no Date.now(). Pass `now` for testability.
 * Never mutates input memory; always returns a new CoreMemory object.
 */

import type { CoreMemory, Fact } from "./memory";
import { newId } from "./memory";
import type { Candidate } from "./summarizer";
import { containsSecret } from "./chat-signal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApplyResult = {
  added: number;
  updated: number;
  retired: number;
  skipped: number;
  discarded: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function confidenceToStatus(
  confidence: number,
): "active" | "pending" | "discard" {
  if (confidence >= 0.9) return "active";
  if (confidence >= 0.7) return "pending";
  return "discard";
}

// Provenance comes from the candidate's `source` tag, not a
// hardcoded null. `learned_from` is authoritative; the legacy `source_session_id`
// is backfilled from the same source for back-compat (kept, not removed).
function provenanceFrom(candidate: Candidate): {
  learned_from: Fact["learned_from"];
  source_session_id: Fact["source_session_id"];
} {
  const src = candidate.source ?? null;
  return {
    learned_from: src,
    source_session_id: src?.session_id ?? null,
  };
}

// Derive the persisted reason from the candidate's why_worth_saving —
// PII-guarded + length-capped. null when absent (legacy / pre-change output)
// or when the text contains PII (detect-and-DROP — over-drop is the safe
// failure mode). Never influences the save decision; only carried onto the
// stored Fact for transparency.
function saveReasonFrom(candidate: Candidate): string | null {
  if (!candidate.why_worth_saving) return null;
  if (containsSecret(candidate.why_worth_saving)) return null;
  return candidate.why_worth_saving.slice(0, 280);
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export function applyCandidates(
  memory: CoreMemory,
  candidates: Candidate[],
  now: Date,
): { memory: CoreMemory; result: ApplyResult } {
  const nowIso = now.toISOString();
  const result: ApplyResult = {
    added: 0,
    updated: 0,
    retired: 0,
    skipped: 0,
    discarded: 0,
  };

  // Work on a mutable copy of the facts array; we never mutate the originals.
  let facts: Fact[] = memory.facts.map((f) => ({ ...f }));

  for (const candidate of candidates) {
    switch (candidate.action) {
      case "skip": {
        const idx = facts.findIndex((f) => f.id === candidate.supersedes_id);
        if (idx === -1) {
          console.error(
            `[siltpoke memory] applyCandidates: skip — unknown id ${candidate.supersedes_id}, discarding`,
          );
          result.discarded++;
          break;
        }
        // A `skip` means "this fact is STILL RELEVANT". If the
        // deterministic decay sweep had queued it `retire_proposed`, the
        // summarizer's judgment overrides that proposal → restore to `active`.
        // Any other status (active / pending) is left unchanged — never
        // auto-activate a `pending` fact (that would violate pending-first).
        const skipped = facts[idx]!;
        facts[idx] = {
          ...skipped,
          status: skipped.status === "retire_proposed" ? "active" : skipped.status,
          last_seen_at: nowIso,
        };
        result.skipped++;
        break;
      }

      case "retire": {
        const idx = facts.findIndex((f) => f.id === candidate.supersedes_id);
        if (idx === -1) {
          console.error(
            `[siltpoke memory] applyCandidates: retire — unknown id ${candidate.supersedes_id}, discarding`,
          );
          result.discarded++;
          break;
        }
        facts[idx] = {
          ...facts[idx]!,
          status: "retired",
          retired_reason: "superseded",
        };
        result.retired++;
        break;
      }

      case "update": {
        const idx = facts.findIndex((f) => f.id === candidate.supersedes_id);
        if (idx === -1) {
          console.error(
            `[siltpoke memory] applyCandidates: update — unknown id ${candidate.supersedes_id}, discarding`,
          );
          result.discarded++;
          break;
        }
        const tier = confidenceToStatus(candidate.suggested_confidence);
        if (tier === "discard") {
          // Low-confidence update: do NOT retire the existing fact — a
          // hallucinated low-conf suggestion must not silently evict a
          // high-conf active fact (data-loss risk).
          console.error(
            "[siltpoke memory] dropping low-conf update for fact %s",
            candidate.supersedes_id,
          );
          result.discarded++;
          break;
        }
        const newFactId = newId("f");
        // Capture prior save_reason before mutating the existing fact entry.
        const priorSaveReason = facts[idx]!.save_reason;
        // Mark old fact as retired (superseded chain)
        facts[idx] = {
          ...facts[idx]!,
          status: "retired",
          retired_reason: "superseded",
          superseded_by: newFactId,
        };
        // Append new fact with supersedes pointer
        const prov = provenanceFrom(candidate);
        const newFact: Fact = {
          id: newFactId,
          text: candidate.candidate_claim,
          source_session_id: prov.source_session_id,
          confidence: candidate.suggested_confidence,
          status: tier,
          created_at: nowIso,
          last_seen_at: nowIso,
          supersedes: candidate.supersedes_id,
          superseded_by: null,
          pinned: false,
          recall_count: 0,
          retired_reason: null,
          // Code floor: missing/invalid stability → durable. By apply time
          // Zod has already stripped any invalid enum value to undefined, so
          // `?? "durable"` is the floor. permanent is stored but NOT decay-exempt
          // (only `pinned` is sacred — see decay.ts). expires_at is threaded
          // through here; acting on it (expiry) is separate.
          stability: candidate.stability ?? "durable",
          learned_from: prov.learned_from,
          kind: null,
          last_confirmed_at: null,
          expires_at: candidate.expires_at ?? null,
          // Change A: gate on whether a fresh why was actually provided.
          // - no fresh why → keep prior reason (no new signal, inherit)
          // - fresh clean why → sliced reason (new signal, adopt)
          // - fresh PII why → null (intentional drop; must NOT resurrect prior)
          // Using ?? would conflate case 2 and 3: saveReasonFrom returns null
          // for both "omitted" and "PII-dropped", but only omitted should fall
          // back. Gating on candidate.why_worth_saving presence distinguishes them.
          save_reason: candidate.why_worth_saving
            ? saveReasonFrom(candidate)   // fresh why present → sliced, or null if PII (drop)
            : priorSaveReason,            // no fresh why → keep the prior reason
          invalid_at: null,
          events: [],
          };
        facts = [...facts, newFact];
        result.updated++;
        break;
      }

      case "add": {
        // Pending-first, global. Confidence still routes the
        // discard threshold (<0.7), but any candidate that clears it is born
        // `pending` regardless of confidence — `active` is reached only via
        // /siltpoke-approve or user-pin / /remember, never auto-activation.
        const tier = confidenceToStatus(candidate.suggested_confidence);
        if (tier === "discard") {
          result.discarded++;
          break;
        }
        const prov = provenanceFrom(candidate);
        const newFact: Fact = {
          id: newId("f"),
          text: candidate.candidate_claim,
          source_session_id: prov.source_session_id,
          confidence: candidate.suggested_confidence,
          status: "pending",
          created_at: nowIso,
          last_seen_at: nowIso,
          supersedes: null,
          superseded_by: null,
          pinned: false,
          recall_count: 0,
          retired_reason: null,
          // Code floor: missing/invalid stability → durable (Zod strips an
          // invalid enum to undefined before apply, so `?? "durable"` is the
          // floor). permanent is stored but NOT decay-exempt (only `pinned` is
          // sacred — see decay.ts). expires_at threaded through; expiry is separate.
          stability: candidate.stability ?? "durable",
          learned_from: prov.learned_from,
          kind: null,
          last_confirmed_at: null,
          expires_at: candidate.expires_at ?? null,
          // Change A: carry why_worth_saving as save_reason (PII-guarded + capped).
          save_reason: saveReasonFrom(candidate),
          invalid_at: null,
          events: [],
          };
        facts = [...facts, newFact];
        result.added++;
        break;
      }
    }
  }

  return {
    memory: { ...memory, facts },
    result,
  };
}

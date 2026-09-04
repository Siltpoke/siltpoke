// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import type { ModuleResolve } from "../repo-graph/module-resolve";

/** First build: the only relation class the module graph captures. Direction is A → B. */
export type RelType = "depends_on";

export type StructuralVerdict = "confirm" | "contradict" | "abstain";

export type AbstainCode =
  | "unresolved_entity" // resolver couldn't map a named thing above the floor
  | "out_of_class"      // both entities resolve, no static edge either way (may couple at runtime)
  | "thin_scope"        // scope has ~no edges to quiz on
  | "stale_scope"       // graph stale / scope no longer exists in current graph
  | "ambiguous";        // genuinely ambiguous input the ladder couldn't narrow

/** The tuple the fact-checker checks. Built deterministically — NEVER authored by an LLM. */
export interface RelationClaim {
  entityA: string; // resolved module id (source of the asserted dependency)
  entityB: string; // resolved module id (target)
  relType: RelType;
}

export interface StructuralVerdictObject {
  kind: "structural_verdict";
  /** null only when verdict === "abstain" and no tuple could be built. */
  claim: RelationClaim | null;
  verdict: StructuralVerdict;
  /** node/module ids that back THIS relation (claim-relevant). Empty on unresolved abstain. */
  evidence_ids: string[];
  /** 0..1 — min of the two entity-resolution confidences (1 for exact, lower for fuzzy). */
  confidence: number;
  /** present iff verdict === "abstain". */
  abstain_reason?: AbstainCode;
}

/** A user-chosen quiz scope: a module subtree, or the whole repo. */
export interface Scope {
  /** module id the quiz is bounded to, or null for whole-repo. */
  moduleId: string | null;
}

/** Coverage overlay — updated ONLY from verdict objects. No numeric field, by design (R4/R5). */
export interface Overlay {
  /** edge keys "a->b" the USER correctly originated (confirm). */
  supported: Set<string>;
  /** edge keys the user asserted with the direction reversed (contradict). */
  contradicted: Set<string>;
  /** edge keys touched but left in an abstain state (unverified). */
  unverified: Set<string>;
  /** module ids the user themselves named (not parroted from a hint). */
  userEntities: Set<string>;
  /** module ids introduced by an assistant hint — do NOT count as user-originated. */
  hintEntities: Set<string>;
}

export type QuizTarget =
  | { kind: "dependency_edge"; a: string; b: string }
  | { kind: "component_role"; moduleId: string } // structural-summary tier
  | { kind: "exhausted" };

export type { ModuleResolve };

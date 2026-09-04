// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import type { StructuralVerdict } from "./types";

const CAVING = ["you're right", "you are right", "you're correct", "basically right", "good way to think", "both are true", "i agree"];
const CAUSAL = ["so that", "because", "designed to", "intended to"];

export interface ValidationResult {
  ok: boolean;
  violations: string[];
}

export function validateVerbalization(prose: string, verdict: StructuralVerdict): ValidationResult {
  const p = prose.toLowerCase();
  const violations: string[] = [];

  if (verdict === "contradict" || verdict === "abstain") {
    for (const phrase of CAVING) if (p.includes(phrase)) violations.push(`caving_phrase:${phrase}`);
  }
  for (const c of CAUSAL) if (p.includes(c)) violations.push(`causal_connective:${c}`);

  return { ok: violations.length === 0, violations };
}

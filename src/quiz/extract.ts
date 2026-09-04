// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { resolveModuleName, type ModuleResolve } from "../repo-graph/module-resolve";

export interface AssertedRelation {
  aName: string;
  bName: string;
}

export interface ExtractedAnswer {
  entities: Array<{ name: string; resolve: ModuleResolve }>;
  relations: AssertedRelation[];
}

const DEP_VERB = /\b(depends on|relies on|uses|imports|calls|needs)\b/gi;

/** Split a multi-part answer on ' and ' / ', ' / ';' so each clause carries one relation. */
function clauses(text: string): string[] {
  return text.split(/\band\b|[;,]/i).map((c) => c.trim()).filter(Boolean);
}

/** Pull the token nearest each side of a verb/arrow as the entity name (last word before, first word after). */
function relationFromClause(clause: string): AssertedRelation | null {
  const arrow = clause.split(/->|→/);
  if (arrow.length === 2) {
    const a = lastWord(arrow[0]);
    const b = firstWord(arrow[1]);
    return a && b ? { aName: a, bName: b } : null;
  }
  DEP_VERB.lastIndex = 0;
  const m = DEP_VERB.exec(clause);
  if (!m) return null;
  const a = lastWord(clause.slice(0, m.index));
  const b = firstWord(clause.slice(m.index + m[0].length));
  return a && b ? { aName: a, bName: b } : null;
}

const REL_PRONOUN = new Set(["that", "which", "who", "whom"]);

function lastWord(s: string): string {
  const w = s.trim().split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  let i = w.length - 1;
  while (i > 0 && REL_PRONOUN.has(w[i])) i--; // cleft: "…web that" → "web"
  return (w[i] ?? "").replace(/^the\s+/i, "");
}
function firstWord(s: string): string {
  const w = s.trim().replace(/^the\s+/i, "").split(/\s+/).filter(Boolean);
  return (w[0] ?? "").toLowerCase();
}

export function extractAnswer(text: string, moduleIds: string[]): ExtractedAnswer {
  const relations: AssertedRelation[] = [];
  for (const clause of clauses(text)) {
    const rel = relationFromClause(clause);
    if (rel) relations.push(rel);
  }
  const names = [...new Set(relations.flatMap((r) => [r.aName, r.bName]))];
  const entities = names.map((name) => ({ name, resolve: resolveModuleName(name, moduleIds) }));
  return { entities, relations };
}

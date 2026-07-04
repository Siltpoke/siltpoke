// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Citation grounding scorer.
 *
 * ≥90% citations grounded = file exists in graph + line within
 * file's known range. Below 90% the explanation is still emitted (soft
 * warn) but tagged `low_confidence: true` in the meta sidecar.
 *
 * "No citations at all" is treated as score 0 — not as vacuously grounded.
 * Surfacing an explanation with zero cites means the Brain didn't ground
 * anything; the user gets the low_confidence banner.
 *
 * Snippet substring matching (against actual file content) is intentionally
 * NOT in v1 — line-existence check is the cheap, deterministic primary.
 * If in-house use shows hallucinated cites with valid file:line that still
 * misquote the content, add snippet check as a follow-up.
 */

export interface Citation {
  file: string;
  startLine: number;
  endLine: number;
}

export interface KnownFile {
  path: string;
  maxLine: number;
}

export interface EvidenceScoreResult {
  score: number;
  grounded: Citation[];
  ungrounded: Citation[];
  total: number;
}

const CITATION_RE = /\[((?:[\w.\-+/]+\.[A-Za-z]+):(\d+)(?:-(\d+))?)\]/g;

export function extractCitations(markdown: string): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const match of markdown.matchAll(CITATION_RE)) {
    const file = match[0]
      .slice(1, -1)
      .split(":")[0];
    const startLine = Number.parseInt(match[2], 10);
    const endLine = match[3] !== undefined ? Number.parseInt(match[3], 10) : startLine;
    const key = `${file}:${startLine}-${endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, startLine, endLine });
  }
  return out;
}

/**
 * The single grounding rule for one citation: the file is known + the line
 * range is sane and within the file. Shared by `scoreCitations` (markdown) and
 * the architecture-view grounding pass (structured evidence) so both apply the
 * identical fact-tier check. `endLine` defaults to `startLine`.
 */
export function citationGrounded(
  file: string,
  startLine: number,
  endLine: number,
  knownFiles: Map<string, KnownFile>,
): boolean {
  const known = knownFiles.get(file);
  if (!known) return false;
  if (startLine < 1 || endLine < startLine) return false;
  if (endLine > known.maxLine) return false;
  return true;
}

export function scoreCitations(
  markdown: string,
  knownFiles: Map<string, KnownFile>,
): EvidenceScoreResult {
  const citations = extractCitations(markdown);
  const grounded: Citation[] = [];
  const ungrounded: Citation[] = [];

  for (const cite of citations) {
    if (citationGrounded(cite.file, cite.startLine, cite.endLine, knownFiles)) {
      grounded.push(cite);
    } else {
      ungrounded.push(cite);
    }
  }

  const total = citations.length;
  const score = total === 0 ? 0 : grounded.length / total;

  return { score, grounded, ungrounded, total };
}

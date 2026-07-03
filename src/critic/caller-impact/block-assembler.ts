// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import type { CallerSet } from "./caller-resolver.ts";
import type { ChangeKind } from "./changed-functions.ts";

// Assemble the bounded 1-hop structural block the critic injects into the
// Brain prompt. It is the place all the honesty rules converge:
//   - bounded — cap the caller list, never silently truncate (+N more).
//   - ambiguous name → a downgraded label, NOT a confident caller list.
//   - removed/renamed-away function still referenced → orphan warning.
//   - "has callers" alone never ships — modified needs a signature-delta.
//   - callers serialized as discrete `caller: <file>:<line>` tokens so the
//     evidence-guard can match a Brain citation verbatim.

const DEFAULT_CAP_LINES = 20;
const DEFAULT_TOKEN_BUDGET = 2500;

export interface CallerBlockInput {
  functionName: string;
  /** added / removed / modified. */
  kind: ChangeKind;
  /** Did param-count / arity change? (only consulted for `modified`). */
  signatureChanged: boolean;
  callers: CallerSet;
  /** Max caller lines before a `+N more` marker. */
  capLines?: number;
  /** Approx token ceiling for the whole block. */
  tokenBudget?: number;
}

export interface CallerBlock {
  /** The block text to inject into the Brain prompt. */
  text: string;
  /** Discrete quotable strings to append to the evidence corpus. */
  tokens: string[];
  /** True when the caller list was capped by line-count or token budget. */
  truncated: boolean;
}

/** Cheap, dependency-free token estimate (≈4 chars/token). */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * One quotable caller token. Fresh index ⇒ `caller: src/a.ts:10`. Stale index
 * ⇒ file-level `caller: src/a.ts` — the stale graph's line numbers
 * can't be trusted, so we drop the `:line` and keep the token file-level so the
 * evidence-guard still has a verbatim string to match.
 */
function callerToken(file: string, line: number, stale: boolean): string {
  return stale ? `caller: ${file}` : `caller: ${file}:${line}`;
}

/** One-line freshness stamp appended when the graph index is stale. */
const STALE_STAMP =
  "(graph index is stale — line numbers omitted; re-run /siltpoke-index)";

/**
 * Decide whether a block is warranted. `modified` requires a
 * signature-delta; `removed` warrants an orphan warning when refs remain;
 * `added` never fabricates callers.
 */
function shouldEmit(input: CallerBlockInput): boolean {
  const { kind, signatureChanged, callers } = input;
  if (callers.unavailable) return false;
  if (kind === "added") return false;
  if (kind === "modified") {
    return signatureChanged && callers.callsiteCount > 0;
  }
  // removed: warn only if something still references the old name.
  return callers.callsiteCount > 0;
}

/** Ambiguous name: a single downgraded label, no caller list. */
function ambiguousBlock(input: CallerBlockInput): CallerBlock {
  const line = `⚠ \`${input.functionName}\`: ${input.callers.callsiteCount} callsite(s) with this name — ambiguous (may include other definitions); not listing callers.`;
  return { text: line, tokens: [line], truncated: false };
}

function header(input: CallerBlockInput): string {
  if (input.kind === "removed") {
    return `⚠ you removed \`${input.functionName}\` but these still reference it:`;
  }
  return `⚠ \`${input.functionName}\` signature changed — callers that may break (1-hop):`;
}

/**
 * Pick the caller lines that fit under BOTH the line cap and the token budget,
 * returning the kept tokens + how many were dropped.
 */
function fitCallers(
  input: CallerBlockInput,
  headerLine: string,
): { kept: string[]; dropped: number } {
  const capLines = input.capLines ?? DEFAULT_CAP_LINES;
  const budget = input.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const stale = input.callers.stale === true;
  // Stale ⇒ file-level tokens can repeat (two callers in one file collapse to
  // the same `caller: <file>`), so dedup after dropping the `:line`.
  const rawTokens = input.callers.callers.map((c) =>
    callerToken(c.file, c.line, stale),
  );
  const all = stale ? [...new Set(rawTokens)] : rawTokens;
  const kept: string[] = [];
  let used = estimateTokens(headerLine);
  for (const tok of all) {
    if (kept.length >= capLines) break;
    // Reserve room for a possible `+N more` line (~6 tokens).
    const next = used + estimateTokens(tok) + 6;
    if (next > budget && kept.length > 0) break;
    kept.push(tok);
    used += estimateTokens(tok);
  }
  return { kept, dropped: all.length - kept.length };
}

/**
 * Assemble the structural caller-impact block, or `null` when no block is
 * warranted (gate failed / no callers / resolver unavailable).
 */
export function assembleCallerBlock(input: CallerBlockInput): CallerBlock | null {
  if (!shouldEmit(input)) return null;
  if (input.callers.ambiguous) return ambiguousBlock(input);

  const headerLine = header(input);
  const { kept, dropped } = fitCallers(input, headerLine);
  if (kept.length === 0) return null;

  const lines = [headerLine, ...kept];
  if (dropped > 0) lines.push(`+${dropped} more`);
  // A stale index loses line-number trust → stamp the block so the Brain
  // (and the user) know the callers are file-level only.
  if (input.callers.stale === true) lines.push(STALE_STAMP);

  return {
    text: lines.join("\n"),
    tokens: kept, // the discrete caller facts are the quotable evidence
    truncated: dropped > 0,
  };
}

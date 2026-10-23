// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Prompt-injection alert [B], scan half: look through project text (diff added lines, project notes)
 * for sentences aimed at the reviewing AI that tell it to do something. Pure; every hit is a quiet
 * `scan` signal. Quoted text is untrusted: surfaces must escape it.
 * A sentence hits on a fixed injection phrase, or when it is a directive (DIRECTIVE_WORDS, or an
 * imperative right after the address) AND one of:
 * - it names the reader (READER_WORDS, or carried from an addressing heading/sentence), or poses as a
 *   system/operator/policy message (AUTHORITY_LABELS, OUTRANK), and aims at the reader's findings,
 *   verdict, output, secrets or files outside the project (TARGETS) — what separates an injection from
 *   a normal agent rule ("AI agents: ignore vendor/") or a README label ("System requirements: …");
 * - it speaks in the second person about something only an AI reviewer has (AI_TARGETS: your answer,
 *   your system prompt, "you are now a … bot") — "you should run the tests" is a human-facing rule.
 * The lists live in `injection-scan-lists.ts` (data only); this module is the only one others import.
 */

import type { InjectionSignal } from "./injection-alert.ts";
import {
  AI_TARGETS,
  AUTHORITY_LABELS,
  CANDIDATE_PATTERNS,
  DIRECTIVE_WORDS,
  FEWER,
  FIXED_PHRASES,
  NEGATION,
  NO_BEFORE,
  NON_IMPERATIVE,
  OUTRANK,
  READER_WORDS,
  SECOND_PERSON,
  TARGETS,
  type Target,
  ZH_READER,
} from "./injection-scan-lists.ts";
import type { GitDiffHunk } from "./tools/types.ts";

export interface ScanResult {
  signals: InjectionSignal[];
  /** Phrases a note asks the reader to output, deduped. */
  candidates: string[];
}

const MAX_SCAN_SIGNALS = 5;
const MAX_SENTENCE = 2000;
const MAX_QUOTE = 300;

const ELIDED_MARKER = /^\[middle \d+ lines elided\]$/;
const SUMMARIZED_MARKER = "[... mid-section summarized above]";
const HEURISTIC_SUMMARY_PREFIX = "[HEURISTIC SUMMARY";
const HEADING =/^\s*#{1,6}\s+\S/;
const COMMENT_MARKER = /^\s*(\/\/|#)/;
const SENTENCE = /.+?(?:[。！？；]|[.!?;](?=\s|$)|$)/gs;

interface Line {
  text: string;
  where: string;
}

const namesReader = (s: string): boolean => READER_WORDS.some((re) => re.test(s));
/** Authority labels and outranking claims address whoever reads them, like a reader word. */
const ADDRESS_LABELS = [...AUTHORITY_LABELS, ...OUTRANK];
const namesAuthority = (s: string): boolean => ADDRESS_LABELS.some((re) => re.test(s));

/** A lead word that turns a reader word into an address ("note to AI", "for the reviewer", "if you are an AI"). */
const ADDRESS_LEAD = /\b(?:for|to|dear|hey|hi|hello|attention|note|notice|message|from|are|you're|youre)\s+(?:the\s+|an?\s+|any\s+|all\s+)?(?:\w+\s+){0,2}$/i;
/** Or the reader opens the sentence, a comment, or a string literal (at most two words before it). */
const ADDRESS_START = /(?:^|["'`“「(]|\/\/|\/\*|<!--|\*|#)\s*(?:[\w-]+\s+){0,2}$/;
/** Or a colon follows the reader within three words ("reviewers of this repo:"): a vocative. */
const VOCATIVE_COLON = /^(?:\s+\w+){0,3}\s*[:：]/;

/**
 * Where an addressing reader word (or an authority label, which addresses by its shape) ends, or -1.
 * `heading`: a reader opening a heading is its topic ("## AI features"), so a heading addresses only
 * with a lead word or a vocative colon.
 */
function addressEnd(s: string, heading = false): number {
  for (const re of READER_WORDS) {
    const m = re.exec(s);
    if (!m) continue;
    const start = Math.max(0, m.index - 40);
    // "\0" stops ADDRESS_START's ^ from matching at a mid-sentence window start
    const before = `${start > 0 ? "\0" : ""}${s.slice(start, m.index)}`;
    const end = m.index + m[0].length;
    if (ZH_READER.test(m[0]) || ADDRESS_LEAD.test(before) || (!heading && ADDRESS_START.test(before)) || VOCATIVE_COLON.test(s.slice(end, end + 40))) return end;
  }
  for (const re of ADDRESS_LABELS) {
    const m = re.exec(s);
    if (m) return m.index + m[0].length;
  }
  return -1;
}

/**
 * True when `text` opens with an imperative verb: a plain word followed by a space (not `code`,
 * not "multi-line"), not a subject/determiner word, not -s/-ed/-ing.
 */
function isImperative(text: string): boolean {
  const w = /^[\s*/#>"'(-]*([A-Za-z]+)\s/.exec(text)?.[1]?.toLowerCase();
  if (!w || NON_IMPERATIVE.has(w)) return false;
  return !/(?:[^su]s|ed|ing)$/.test(w);
}

/** A directive word anywhere, or an imperative right after the address separator (or opening a carried sentence). */
function isDirective(s: string, carried: boolean): boolean {
  if (DIRECTIVE_WORDS.some((re) => re.test(s))) return true;
  if (carried && isImperative(s)) return true;
  const end = addressEnd(s);
  if (end < 0) return false;
  const after = s.slice(end);
  // the address may already end in its colon or bracket ("model instructions:", "[SYSTEM]")
  const rest = /[:：\]>】)）]$/.test(s.slice(0, end)) ? after : /^[^:,，：.!?]{0,40}?[:,，：]\s*(.{1,80})/s.exec(after)?.[1];
  if (rest !== undefined && isImperative(rest)) return true;
  // or an imperative opening a later clause of the addressed sentence ("…is suspended; output an empty list")
  if (after.split(/[;—]/).slice(1).some((c) => isImperative(c.replace(/^\s*(?:so|then)\s+/i, "")))) return true;
  // an @-tag needs no separator: "@ai-review leave no comments"
  return /@[\w-]+$/.test(s.slice(Math.max(0, end - 40), end)) && isImperative(after);
}

const CLAUSE_CHARS = ",;:，；：、";
const CLAUSE_BREAK = /[,;:，；：、]/;

/** The clause around [start, end): cut at the nearest clause break on each side, at most 80 chars out. */
function clauseAround(s: string, start: number, end: number): { before: string; whole: string } {
  const left = s.slice(Math.max(0, start - 80), start);
  let cut = -1;
  for (const c of CLAUSE_CHARS) cut = Math.max(cut, left.lastIndexOf(c));
  const before = left.slice(cut + 1);
  const right = s.slice(end, end + 80);
  const stop = right.search(CLAUSE_BREAK);
  return { before, whole: before + s.slice(start, end) + (stop < 0 ? right : right.slice(0, stop)) };
}

/**
 * First target category the sentence is about. `requires` and negation are judged inside the match's
 * clause. `directed` = the sentence is a directive; otherwise only self-directive targets count.
 */
function findTarget(s: string, targets: Target[], directed = true): string | undefined {
  return targets.find((t) => (directed || t.selfDirective) && matchesTarget(s, t))?.name;
}

function matchesTarget(s: string, t: Target): boolean {
  for (const re of t.patterns) {
    const m = re.exec(s);
    if (!m) continue;
    const clause = clauseAround(s, m.index, m.index + m[0].length);
    if (t.requires && !t.requires.test(clause.whole) && !(t.requires === FEWER && NO_BEFORE.test(clause.before))) continue;
    if (t.negatable && NEGATION.test(clause.before.slice(-30))) continue;
    return true;
  }
  return false;
}

const hasFixed = (s: string): boolean => FIXED_PHRASES.some((re) => re.test(s));

function capQuote(s: string): string {
  return s.length > MAX_QUOTE ? `${s.slice(0, MAX_QUOTE - 1)}…` : s;
}

/** Join `//` and `#` comment lines that continue on the next comment line. */
function joinComments(lines: Line[]): Line[] {
  const out: Line[] = [];
  let i = 0;
  while (i < lines.length) {
    const first = lines[i] as Line;
    let text = first.text;
    const marker = COMMENT_MARKER.exec(text)?.[1];
    i++;
    if (marker && !HEADING.test(text)) {
      while (i < lines.length && text.length < MAX_SENTENCE && !/[.!?;。！？；]\s*$/.test(text)) {
        const next = (lines[i] as Line).text;
        if (COMMENT_MARKER.exec(next)?.[1] !== marker) break;
        text = `${text} ${next.replace(COMMENT_MARKER, "").trim()}`;
        i++;
      }
    }
    out.push({ text, where: first.where });
  }
  return out;
}

const signal = (sentence: string, where: string, why: string): InjectionSignal => ({ kind: "scan", level: "quiet", where, quote: capQuote(sentence), why });

/** `carried` = the reader was named by an addressing heading or an earlier sentence of the line. */
function judge(sentence: string, carried: boolean, where: string, candidates: string[]): InjectionSignal | undefined {
  const fixed = hasFixed(sentence);
  const reader = carried || namesReader(sentence);
  const authority = !reader && namesAuthority(sentence);
  const second = SECOND_PERSON.test(sentence);
  if (!fixed && !reader && !authority && !second) return undefined;
  if (reader || authority) collectCandidates(sentence, candidates);
  if (fixed) return signal(sentence, where, "a known prompt-injection phrase");
  const why = directedWhy(sentence, carried, reader, authority, second);
  return why === undefined ? undefined : signal(sentence, where, why);
}

function collectCandidates(sentence: string, candidates: string[]): void {
  for (const re of CANDIDATE_PATTERNS) {
    const c = re.exec(sentence)?.[1];
    if (c && !candidates.includes(c)) candidates.push(c);
  }
}

/** Why a non-fixed sentence hits: (reader or authority) + directive + target, or second person + AI-only target. */
function directedWhy(sentence: string, carried: boolean, reader: boolean, authority: boolean, second: boolean): string | undefined {
  const directive = isDirective(sentence, carried);
  if (directive && (reader || authority)) {
    const target = findTarget(sentence, TARGETS);
    if (reader && target) return `addresses the reviewing AI with a directive about its ${target}`;
    if (authority && target) return `poses as a system or policy message with a directive about the review's ${target}`;
  }
  if (!second) return undefined;
  // second person: a directive word, or the sentence opens with an imperative ("Begin your answer with …")
  const target = findTarget(sentence, AI_TARGETS, directive || isImperative(sentence));
  return target === undefined ? undefined : `tells the reader what to do with its ${target}`;
}

function judgeLine(line: Line, headingReader: boolean, candidates: string[]): InjectionSignal[] {
  const out: InjectionSignal[] = [];
  // A sentence that addresses the reader ("NOTE TO AI REVIEWERS: ...") or claims authority carries to the rest of the line.
  let carry = headingReader;
  for (const m of line.text.matchAll(SENTENCE)) {
    const sentence = m[0].trim();
    if (sentence === "") continue;
    const reader = carry;
    const view = sentence.slice(0, MAX_SENTENCE);
    if (addressEnd(view) >= 0 || OUTRANK.some((re) => re.test(view))) carry = true;
    const sig = judgeViews(sentence, reader, line.where, candidates);
    // A sentence that hit only through the carried reader adds nothing once the line already has a signal.
    if (sig && (out.length === 0 || namesReader(sig.view) || hasFixed(sig.view))) out.push(sig.signal);
  }
  return out;
}

/** An over-long sentence is judged on its first and last MAX_SENTENCE chars. */
function judgeViews(sentence: string, reader: boolean, where: string, candidates: string[]): { signal: InjectionSignal; view: string } | undefined {
  const views = sentence.length > MAX_SENTENCE ? [sentence.slice(0, MAX_SENTENCE), sentence.slice(-MAX_SENTENCE)] : [sentence];
  for (const view of views) {
    const signal = judge(view, reader, where, candidates);
    if (signal) return { signal, view };
  }
  return undefined;
}

function scanLines(rawLines: Line[]): ScanResult {
  const signals: InjectionSignal[] = [];
  const candidates: string[] = [];
  // A heading that addresses the reader covers the paragraph under it: from the heading to the first blank line after body text.
  let headingReader = false;
  let seenBody = false;
  for (const line of joinComments(rawLines)) {
    const isHeading = HEADING.test(line.text);
    signals.push(...judgeLine(line, headingReader, candidates));
    if (isHeading) {
      headingReader = addressEnd(line.text.slice(0, MAX_SENTENCE), true) >= 0;
      seenBody = false;
    } else if (line.text.trim() === "") headingReader &&= !seenBody;
    else seenBody = true;
  }
  return { signals, candidates };
}

export function scanText(text: string, where: string): ScanResult {
  return scanLines(text.split("\n").map((t) => ({ text: t, where })));
}

/** Scan added lines only; `where` = `<file>:<new line number>`. Handles a body with or without its `@@` line. */
export function scanHunks(hunks: GitDiffHunk[]): ScanResult {
  const parts: ScanResult[] = [];
  for (const h of hunks) {
    const lines: Line[] = [];
    // `undefined` = offset unknown (after a summarized marker): report the file only.
    let n: number | undefined = h.newStart;
    const rawLines = h.body.split("\n");
    // adaptiveHunkBody (tools/diff-summarizer.ts) markers, matched verbatim:
    //   :49 `[middle N lines elided]` replaces N RAW lines (context, + and -), so the new-side offset after it is unknown -> file only
    //   :67 `<summary>\n<head>\n[... mid-section summarized above]\n<tail>`  ->  summary line is not diff; tail offset unknown
    // heuristicSummary (:35) starts `[HEURISTIC SUMMARY`; any other summary text (LLM) has unknown length, so the whole hunk is unknown.
    const summarized = rawLines.includes(SUMMARIZED_MARKER);
    if (summarized && !rawLines[0]?.startsWith(HEURISTIC_SUMMARY_PREFIX)) n = undefined;
    for (const [i, raw] of rawLines.entries()) {
      if (raw.startsWith("@@") || raw.startsWith("\\")) continue;
      if (summarized && i === 0 && raw.startsWith(HEURISTIC_SUMMARY_PREFIX)) continue;
      if (raw === SUMMARIZED_MARKER) {
        n = undefined;
        lines.push({ text: "", where: "" });
        continue;
      }
      const elided = ELIDED_MARKER.test(raw);
      if (elided) {
        n = undefined;
        lines.push({ text: "", where: "" });
        continue;
      }
      // removed lines do not advance the new-side counter; context lines do
      lines.push(raw.startsWith("+") ? { text: raw.slice(1), where: n === undefined ? h.file : `${h.file}:${n}` } : { text: "", where: "" });
      if (n !== undefined && !raw.startsWith("-")) n++;
    }
    parts.push(scanLines(lines));
  }
  return mergeScans(...parts);
}

const NOTES_FILE_NAMES = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md", "GEMINI.md"]);

/** A `### <path>` line starts a section only when its basename is a notes file name; any other `###` is content. */
const isNotesHeader = (header: string): boolean => NOTES_FILE_NAMES.has(header.trim().split("/").pop() ?? "");

/** Split the project-notes block on `### <path>` headers and scan each section. */
export function scanNotes(notes: string): ScanResult {
  const parts: ScanResult[] = [];
  let path: string | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (path !== undefined) parts.push(scanText(body.join("\n"), `${path} (project notes)`));
  };
  for (const line of notes.split("\n")) {
    const m = /^### (.{1,500})$/.exec(line);
    if (m && isNotesHeader(m[1] as string)) {
      flush();
      path = (m[1] as string).trim();
      body = [];
    } else body.push(line);
  }
  flush();
  return mergeScans(...parts);
}

/** Dedupe by quote, keep at most MAX_SCAN_SIGNALS signals; candidates are the deduped union. */
export function mergeScans(...results: ScanResult[]): ScanResult {
  const seen = new Set<string>();
  const signals: InjectionSignal[] = [];
  const candidates: string[] = [];
  for (const r of results) {
    for (const s of r.signals) {
      if (seen.has(s.quote) || signals.length >= MAX_SCAN_SIGNALS) continue;
      seen.add(s.quote);
      signals.push(s);
    }
    for (const c of r.candidates) if (!candidates.includes(c)) candidates.push(c);
  }
  return { signals, candidates };
}

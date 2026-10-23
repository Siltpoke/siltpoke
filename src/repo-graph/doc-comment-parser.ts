// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Parse the first JSDoc-style block at the top of a TS/JS source and return
 * its first descriptive SENTENCE.
 *
 * Used by the repo-graph file-level scene to show each file's
 * purpose as a one-liner, and by the extractor for a symbol's `doc`. Returns
 * "" when the source does not begin with a doc-comment (after optional blank
 * lines + license `// ...` line comments).
 *
 * "First descriptive sentence" = the comment's first paragraph (lines up to a
 * blank line, a JSDoc `@tag`, or the end), joined with spaces, cut at the
 * first sentence end (see `dotEndsSentence` for what a dot has to look like).
 * It used to be the first physical LINE; doc comments are
 * wrapped at ~80 columns, so that usually stopped mid-sentence (defect [45]:
 * "Drop changed-file paths that do not resolve inside `cwd` — see").
 */

/** Longer than this and the sentence is cut at a word, with an ellipsis. */
const MAX_PURPOSE_CHARS = 240;

/**
 * What comes right before a dot that is NOT a sentence end, whatever follows:
 * a list number (`1.`), a dotted initialism (`e.g.`, `i.e.`, `U.S.`, `a.m.`),
 * or `vs.` / `cf.`, which are always followed by their object.
 */
const NEVER_ENDS_BEFORE_DOT = /(?:^|[\s(])(?:\d+|(?:[A-Za-z]\.)+[A-Za-z]|vs|cf)$/i;

/** Does the dot at `i` end a sentence? (`text[i] === "."`, followed by space or the end.) */
function dotEndsSentence(text: string, i: number): boolean {
  if (NEVER_ENDS_BEFORE_DOT.test(text.slice(0, i))) return false;
  // A lowercase word next means the sentence goes on: `etc. and more`,
  // `Waits... then continues`, `approx. three`.
  const rest = text.slice(i + 1).trimStart();
  return !/^[a-z]/.test(rest);
}

/**
 * Index just past the first sentence end in `text`, or -1. A sentence ends at
 * `.`, `!` or `?` followed by whitespace or the end — so the dots in
 * `src/a.ts`, `v1.2` and `a.b` do not end one — or at a full-width `。！？`.
 * With `skipCode`, nothing between backticks ends one.
 */
function sentenceEnd(text: string, skipCode: boolean): { end: number; unclosedCode: boolean } {
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (skipCode && ch === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (ch === "。" || ch === "！" || ch === "？") return { end: i + 1, unclosedCode: false };
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const next = text[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    if (ch === "." && !dotEndsSentence(text, i)) continue;
    return { end: i + 1, unclosedCode: false };
  }
  return { end: -1, unclosedCode: inCode };
}

function firstSentence(text: string): string {
  let found = sentenceEnd(text, true);
  // One stray backtick would otherwise put the whole rest of the paragraph
  // "inside code" and return all of it. Read it as plain text instead.
  if (found.unclosedCode) found = sentenceEnd(text, false);
  return found.end < 0 ? text : text.slice(0, found.end);
}

function capLength(sentence: string): string {
  if (sentence.length <= MAX_PURPOSE_CHARS) return sentence;
  const head = sentence.slice(0, MAX_PURPOSE_CHARS);
  const lastSpace = head.lastIndexOf(" ");
  return `${(lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd()}…`;
}

/** A line that starts a list item or a code fence — never prose to join onto. */
const LIST_OR_FENCE = /^(?:[-*+]\s|\d+[.)]\s|```)/;

/**
 * The body lines of the comment's first paragraph, `* ` prefixes stripped. A
 * list item or code fence ends the prose before it; when the comment OPENS
 * with one, that line alone is returned (a fence gives nothing).
 */
function descriptionLines(lines: string[], start: number): string[] {
  const paragraph: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("*/")) break;
    // Strip the leading `* ` (or `*`) prefix, and a closing `*/` on the line.
    const body = trimmed.replace(/^\*\s?/, "").replace(/\s*\*\/\s*$/, "").trim();
    if (body === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    // A tag ends the description; a tag before any description means none.
    if (body.startsWith("@")) break;
    if (LIST_OR_FENCE.test(body)) {
      if (paragraph.length === 0 && !body.startsWith("```")) paragraph.push(body);
      break;
    }
    paragraph.push(body);
    if (trimmed.endsWith("*/")) break;
  }
  return paragraph;
}

export function parseFirstDocComment(source: string): string {
  const lines = source.split(/\r?\n/);

  // Skip leading whitespace + line comments. If we hit anything else
  // before a `/**`, this file does not lead with a doc-comment.
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "" || trimmed.startsWith("//")) {
      i += 1;
      continue;
    }
    break;
  }

  if (i >= lines.length) return "";
  const firstNonBlank = lines[i]!.trim();
  if (!firstNonBlank.startsWith("/**")) return "";

  // Single-line form: `/** foo */`
  const singleLineMatch = /^\/\*\*\s*(.+?)\s*\*\/\s*$/.exec(firstNonBlank);
  if (singleLineMatch) {
    const body = singleLineMatch[1]!.trim();
    // `/** @jsxImportSource hono/jsx */` is a pragma, not a description.
    return body.startsWith("@") ? "" : capLength(firstSentence(body));
  }

  // Multi-line form: text may also follow `/**` on the opening line.
  const opening = firstNonBlank.replace(/^\/\*\*\s?/, "").trim();
  const paragraph = descriptionLines(lines, i + 1);
  if (opening.startsWith("@")) return "";
  const joined = opening === "" ? paragraph : [opening, ...paragraph];
  return capLength(firstSentence(joined.join(" ")));
}

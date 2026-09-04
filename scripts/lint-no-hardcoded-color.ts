#!/usr/bin/env bun
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Hardcoded-color guard.
//
// Colors in src/web must come from a token. This scans CSS-VALUE positions for
// color literals and fails the build on anything not in .lint-colors-allowlist.json.
//
// Ratchet: the allowlist starts holding every literal that existed when the
// dark-mode track opened, and burns down as they migrate. Adding an entry
// requires a written reason and reviewer sign-off.
//
// Scoping matters: a whole-file scan for named colors flags ordinary English
// ("the white paper", "a gray area") and the guard becomes noise, then gets
// disabled. Only value positions (quoted strings, with comments masked out
// first) are scanned.

import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { collectStringSpans, type StringSpan } from "./lint-colors-spans";

// A list, not a single root: `src/daemon/routes` was added 2026-08-01
// (dashboard dark-mode Task 10, decided item 1) — `src/daemon/routes/explain.tsx`
// is an SSR surface mounted by the SAME daemon as the dashboard, so its color
// literals were invisible to this guard even though the page renders on the
// same origin. The scanner already walks a directory glob; this makes it walk
// N of them instead of inventing a second mechanism.
//
// `src/repo-graph` added 2026-08-03 (final dark-mode branch review, Important
// 3): `src/repo-graph/project-architecture.ts` mints `ProjectionGroup.accent`
// — 6 hardcoded hex literals, 4 byte-identical to LIGHT-mode brand tokens —
// which reach the page as `accent` inside the JSON serialized to
// `data-initial` (RepoGraph.tsx) and get painted directly by the client
// island (repo-graph.ts's `cssAlpha`/`style="background:${accent}"` sites).
// Neither existing net saw it: it's outside `src/web`/`src/daemon/routes`,
// AND (independently) the rendered-output test's `COLOR_IN_ATTR` only
// matches `style|stroke|fill|stop-color|flood-color|lighting-color` — a
// `data-initial` JSON blob is a different attribute name entirely, so that
// net would have missed this shape even had the source-scan net covered the
// file. Widening ROOTS is the source-side half of closing that gap.
const ROOTS = ["src/web", "src/daemon/routes", "src/repo-graph"];
// `src/web/tokens/categorical.ts` added 2026-08-02 (Task 10b batch 2, review
// round 1, directed item B): `graphPalette`/`kindPalette` moved out of
// palette.ts to keep it under the file-LOC cap, into a sibling module that
// holds the SAME kind of content (a raw color literal) under a different
// name — this widens the guard's exemption to cover a second legitimate
// literal-holding module, the same shape as the `ROOTS` widening above, not
// a loosening of what's allowed.
const EXEMPT = new Set([
  "src/web/tokens/palette.ts",
  "src/web/tokens/categorical.ts",
  "src/web/tokens/tokens.css",
  "src/web/tokens/tailwind.css",
]);
const ALLOWLIST_FILE = ".lint-colors-allowlist.json";

// The full CSS Color Module extended-keyword set (148 names — the same list
// the `color-name` npm package ships, spot-checked against it; NOT imported
// from that package because it's present in node_modules only as a
// TRANSITIVE dependency of `color-convert`, and this file's own docstring
// two lines below already explains why an undeclared transitive import is
// the wrong move here — same reasoning as `ts-morph` vs bare `typescript`).
// Widened from the original 41-word subset (Important 2, final-branch
// review): the property-value scanner (then `CSS_COLOR_PROPS`, now
// `CSS_COLOR_PROP_DECL` below) used to only ever test the FIRST word after a
// property's colon against this set, so the exact vocabulary gap barely
// mattered — but the widened property-value tokenizer below can now surface
// a named color ANYWHERE in a declaration value (`border: 1px solid
// darkred`, `box-shadow: 0 0 2px black`), and most of those idiomatic
// "pin a color against the theme" phrasings reach for an extended keyword
// (`darkred`, `firebrick`, `steelblue`) rather than one of the 16 CSS
// Level-1 basics. Checked before widening: none of the 108 newly-added words
// collide with an existing whole-string literal anywhere under `src/web` or
// `src/daemon/routes` (the two places `isColorValue`'s whole-span check —
// a separate, pre-existing, documented false-positive source, see the
// TamagotchiToy.tsx "lavender" allowlist entry — could turn a widened
// vocabulary into a NEW false positive); zero hits.
// `transparent` and `currentColor` are deliberately absent, same as before:
// both are keywords that inherit/resolve, not literals with an RGB value.
const NAMED = new Set([
  "white", "black", "red", "green", "blue", "gray", "grey", "silver", "maroon",
  "yellow", "olive", "lime", "aqua", "teal", "navy", "fuchsia", "purple", "orange",
  "pink", "brown", "cyan", "magenta", "indigo", "violet", "gold", "crimson", "coral",
  "salmon", "khaki", "lavender", "turquoise", "beige", "ivory", "tan", "chocolate",
  "orchid", "plum", "azure", "chartreuse", "sienna",
  "aliceblue", "antiquewhite", "aquamarine", "bisque", "blanchedalmond", "blueviolet",
  "burlywood", "cadetblue", "cornflowerblue", "cornsilk", "darkblue", "darkcyan",
  "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki", "darkmagenta",
  "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet",
  "deeppink", "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick",
  "floralwhite", "forestgreen", "gainsboro", "ghostwhite", "goldenrod", "greenyellow",
  "honeydew", "hotpink", "indianred", "lavenderblush", "lawngreen", "lemonchiffon",
  "lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray",
  "lightgreen", "lightgrey", "lightpink", "lightsalmon", "lightseagreen",
  "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue", "lightyellow",
  "limegreen", "linen", "mediumaquamarine", "mediumblue", "mediumorchid",
  "mediumpurple", "mediumseagreen", "mediumslateblue", "mediumspringgreen",
  "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream", "mistyrose",
  "moccasin", "navajowhite", "oldlace", "olivedrab", "orangered", "palegoldenrod",
  "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff", "peru",
  "powderblue", "rebeccapurple", "rosybrown", "royalblue", "saddlebrown",
  "sandybrown", "seagreen", "seashell", "skyblue", "slateblue", "slategray",
  "slategrey", "snow", "springgreen", "steelblue", "thistle", "tomato", "wheat",
  "whitesmoke", "yellowgreen",
]);

export interface Violation {
  path: string;
  literal: string;
  line: number;
  kind: string;
}

export interface AllowEntry {
  path: string;
  literal: string;
  category: string;
  reason: string;
}

const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
// Note: `color` is included as a bare function name (CSS Color 4 `color(srgb …)`).
// It cannot false-match `color-mix(…)` — the char after "color" must be "(",
// and color-mix has "-" there — so var(--color-ink)-style tokens stay clear.
// `/i`: CSS function names are case-insensitive (`RGB(...)` is valid CSS).
const FUNC_NAME = /\b(rgba?|hsla?|oklch|oklab|hwb|lab|lch|color)\(/gi;
const ESCAPED_HEX = /%23[0-9a-fA-F]{3,8}\b/g;
// `${token}NN` — a template-literal interpolation immediately followed by
// exactly 2 hex digits at a word boundary. This is a call-site relic from
// when `tokens.color.*` held hex STRINGS: `` `${tokens.color.terra}18` ``
// used to produce a valid 8-digit hex (`#d96b6b18`) by string concatenation.
// The hex→`var(--color-x)` token flip (this branch) broke that silently —
// `var(--color-terra)18` is not valid CSS at all: for a `background` it drops
// the whole declaration at computed-value time (renders untinted), and for an
// SVG `fill` presentation attribute it is not a valid `<paint>`, so `fill`
// falls back to its initial value, opaque BLACK. There is no valid CSS shape
// this could ever legitimately produce — 2 trailing hex digits directly after
// a `${…}` close-brace is ALWAYS this defect, never a coincidence, so it can
// be a hard violation with no allowlist escape.
//
// NOT a whole-span regex like every other pattern in this file: `${` and `}`
// are stripped from `StringSpan.text` before it ever reaches here (see
// `StringSpan.precededByInterpolation`'s docstring in lint-colors-spans.ts),
// so a global match for `\$\{[^}]*\}NN` can never fire — the literal
// characters `${` and `}` are simply not present in any span's cooked text
// to match against. What IS knowable is which spans are a `TemplateMiddle`/
// `TemplateTail` — i.e. START right where an interpolation just closed — so
// the check this constant backs is anchored at `^`, tested only against
// spans the parser already marked `precededByInterpolation`.
//
// The trailing `\b` is what keeps `` `--scatter-rot:${rot}deg` `` (a real,
// unrelated interpolation in action-result.ts:141) unflagged: that tail
// span's text is "deg" — "de" are both hex digits, but "d","e","g" are three
// word characters in a row, so there is no `\b` boundary between the matched
// "e" and the following "g", and the match fails. A boundary only exists
// when the 2 hex digits are followed by a non-word character (end of the
// span, `;`, `"`, a backtick, whitespace, `)` …) — exactly the shape every
// real `${token}NN` alpha-tint site has.
const TEMPLATE_ALPHA_SUFFIX = /^[0-9A-Fa-f]{2}\b/;
// Same function-name set as FUNC_NAME, reused inside Tailwind arbitrary-value
// brackets (`bg-[oklch(0.5_0.1_30)]` etc.) alongside bare hex. The bare
// `[a-z]+` alternative catches `bg-[white]`-shaped named-color arbitrary
// values — filtered against NAMED in the caller (not every bracketed word is
// a color: `bg-[inherit]`, `bg-[currentColor]` must stay unflagged).
const TW_ARBITRARY =
  /\b(?:bg|text|border|fill|stroke|from|to|via|ring|outline|decoration|caret|accent|shadow)-\[(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab|hwb|lab|lch|color)\([^\]]*\)|[a-z]+)\]/gi;
// Tailwind KEYWORD utilities: `bg-white`, `text-black`, `border-white`, …
// These are structurally invisible to every pattern above — there is no hex,
// no color function, and no `[...]` arbitrary value to match — so the guard
// reported "clean" over four live `bg-white` sites in FloatingChat.tsx, two of
// which pair it with `text-ink` (in dark: #e8e8e8 on #ffffff, contrast 1.06,
// i.e. invisible text). Found by the Task 7 review. The keyword set is
// deliberately just white/black: those are the two Tailwind ships that are
// theme-INVARIANT and therefore cannot follow a theme, which is the whole
// defect. Other Tailwind color utilities (`bg-red-500`) do not exist in this
// codebase's config — no Tailwind color palette is imported.
const TW_KEYWORD =
  /\b(?:bg|text|border|fill|stroke|ring|outline|decoration|caret|accent|from|to|via|divide|placeholder)-(white|black)\b/g;
// A named color only counts as a violation when it sits in the VALUE of one
// of these known color-bearing CSS properties — not merely "any word before
// a colon somewhere before a semicolon" (that pattern flags ordinary prose:
// "Note: white text on dark background"). Scoped to real property names, so
// it's safe to run against both raw `.css` text and JS/TS string content.
//
// Captures the WHOLE rest of the declaration (up to `;`/`}`/end-of-span), not
// just the one word immediately after the colon (Important 2, final-branch
// review). The narrower, original form only ever tested the token in that
// one position, so it was structurally blind to a named color anywhere else
// in a multi-token value: `color:color-mix(in srgb, var(--color-amber) 12%,
// black)` — the word right after `color:` is `color-mix`, which is not a
// NAMED word, so the scan stopped there and `black` (further into the same
// declaration) was never even looked at. Same blindness for
// `background:linear-gradient(90deg, red, blue)`, `border: 1px solid
// darkred`, and `box-shadow: 0 0 2px black` — the two most idiomatic ways to
// pin a color against the theme instead of a token.
//
// The capture stops at `{` too (final-cleanup Item 2), not only `;`/`}`: a
// selector segment shaped like one of these property names followed by `{`
// (`.color:hover{background:snow}`) used to have its capture group run
// straight through the brace into the NEXT declaration's value as one
// undelimited token (`hover{background:snow`), so a later named color inside
// it never came free as its own VALUE_TOKEN and was silently missed — see
// `tests/scripts/lint-no-hardcoded-color.test.ts` "stops at a selector's `{`".
const CSS_COLOR_PROP_DECL =
  /\b(?:color|background|background-color|border|border-color|border-top-color|border-right-color|border-bottom-color|border-left-color|outline|outline-color|fill|stroke|box-shadow|text-decoration-color|caret-color|accent-color)\s*:\s*([^;{}]*)/gi;
// Tokenizes a declaration's captured value (the group CSS_COLOR_PROP_DECL
// above produces) into words, splitting on whitespace, commas, parens, and
// `/` (the CSS4 alpha-slash separator, `rgb(0 0 0 / .5)`) — everything that
// can separate one color/keyword/number from the next inside a value, none
// of which can appear WITHIN a bare named-color keyword itself. Matched as a
// positive "run of non-delimiter characters" rather than split() specifically
// so each token's offset inside the value is available directly from the
// match, with no separate index bookkeeping.
const VALUE_TOKEN = /[^\s,()/]+/g;

/**
 * Extracts a balanced `(...)` call starting at `openIdx` (the index of the
 * opening paren). Needed because a color function can legitimately nest
 * parens — `color-mix(in srgb, var(--color-ink) 32%, transparent)` is a
 * NEGATIVE case, but `rgb(from var(--x) r g b)` (CSS relative-color syntax)
 * is a positive one that a naive "up to the first `)`" match would truncate.
 * Returns null if the call is never closed within the span (malformed / cut
 * off — do not guess).
 */
function extractBalanced(text: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return null;
}

// `collectStringSpans` — every string-literal / template-literal text span in
// a TS/TSX source — lives in ./lint-colors-spans.ts and is produced by
// TypeScript's own parser (via the declared `ts-morph` devDependency). It
// replaced a ~225-line hand-rolled character walk after five consecutive
// independent review rounds found five distinct defect classes in it; see that
// file's docstring for the full list and for why a parser kills all five by
// construction rather than by care.

/**
 * Value positions we scan:
 *   - string/template literal content, via `collectStringSpans` above.
 *   - for a `.css` file specifically: the WHOLE file body (after stripping
 *     `/* … *\/`-style block comments only — CSS has no `//` line-comment
 *     syntax at all, so running a JS line-comment rule against a `.css` file
 *     is pure damage with no upside; it must not run here). Unlike JS/TS —
 *     where most text is prose/identifiers and only quoted strings are CSS
 *     values — a `.css` file's raw, unquoted text (e.g. `color: #1f1b16;`)
 *     IS CSS-value territory throughout.
 */
function valueSpans(source: string, path: string): StringSpan[] {
  if (path.endsWith(".css")) {
    const blockComment = /\/\*[\s\S]*?\*\//g;
    // The mask replaces each non-newline with a space rather than dropping the
    // comment, so the body stays byte-aligned with the source and its span
    // starts at line 1 — no cooking happens on this path at all.
    const masked = source.replace(blockComment, (m) => m.replace(/[^\n]/g, " "));
    // A raw `.css` file has no template-literal interpolations at all (CSS
    // has no `${…}` syntax), so this whole-file span is never preceded by
    // one.
    return [{ text: masked, line: 1, precededByInterpolation: false }];
  }
  return collectStringSpans(source, path);
}

function isColorValue(span: string): boolean {
  // A named color only counts when the whole span IS that word (e.g. the
  // value side of `color: "white"`), never when it merely CONTAINS the word
  // — that's how "white noise" and `whiteListed` stay unflagged while
  // `"white"` and `"currentColor"`-shaped single-token values still get
  // caught. `currentColor` itself is deliberately absent from NAMED: it is
  // a keyword that inherits, not a literal, and is one of the brief's
  // required negative cases.
  const trimmed = span.trim().toLowerCase();
  return NAMED.has(trimmed);
}

export function scanForColorLiterals(source: string, path: string): Violation[] {
  if (EXEMPT.has(path)) return [];
  const out: Violation[] = [];

  // Line resolution stays inside ONE coordinate system: the span's own start
  // line (resolved by the parser from the raw node position) plus the newlines
  // that appear in the span's cooked text before the match. The earlier form —
  // counting newlines in `source.slice(0, rawOffset + matchIndex)` — mixed a
  // raw offset with a cooked index, so any escape that collapses characters
  // shifted the reported line: a literal after four CRLF pairs inside a
  // template reported line 3 instead of 5. `path:line` is the only actionable
  // thing this guard prints, so it has to be right.
  let currentSpan: StringSpan = { text: "", line: 1, precededByInterpolation: false };
  const push = (literal: string, indexInSpan: number, kind: string) => {
    const precedingNewlines = currentSpan.text.slice(0, indexInSpan).split("\n").length - 1;
    out.push({ path, literal, line: currentSpan.line + precedingNewlines, kind });
  };

  for (const span of valueSpans(source, path)) {
    currentSpan = span;
    for (const m of span.text.matchAll(HEX)) push(m[0], m.index ?? 0, "hex");

    for (const m of span.text.matchAll(FUNC_NAME)) {
      const nameStart = m.index ?? 0;
      const openParenIdx = nameStart + m[0].length - 1;
      const call = extractBalanced(span.text, openParenIdx);
      if (call === null) continue;
      const literal = `${m[1]}${call}`;
      // A template-literal expression (`rgba(${r},${g},${b},${a})`) is
      // computed, not a hardcoded color — flagging it would be noise nobody
      // can fix by swapping in a token, and it would sit in the allowlist
      // forever. Skip it; it is not the defect this guard exists to catch.
      if (literal.includes("${")) continue;
      push(literal, nameStart, "color-function");
    }

    for (const m of span.text.matchAll(ESCAPED_HEX)) push(m[0], m.index ?? 0, "escaped-hex");

    // Anchored at the START of the span, and only for a span that itself
    // starts right after an interpolation closed — see TEMPLATE_ALPHA_SUFFIX
    // above for why this can't be a matchAll() over span.text like every
    // other pattern here.
    if (span.precededByInterpolation) {
      const m = TEMPLATE_ALPHA_SUFFIX.exec(span.text);
      if (m) push(`\${…}${m[0]}`, 0, "template-alpha-suffix");
    }

    for (const m of span.text.matchAll(TW_KEYWORD)) {
      push(m[0], m.index ?? 0, "tailwind-keyword");
    }

    for (const m of span.text.matchAll(TW_ARBITRARY)) {
      const val = m[1] ?? m[0];
      // The bracket alternation also matches ANY bare word (`[a-z]+`), so a
      // non-color arbitrary value (`bg-[inherit]`, `text-[center]`) must be
      // filtered against NAMED here, the same rule isColorValue uses below —
      // not every bracketed identifier is a color.
      if (/^[a-z]+$/i.test(val) && !NAMED.has(val.toLowerCase())) continue;
      push(val, m.index ?? 0, "tailwind-arbitrary");
    }

    if (isColorValue(span.text)) push(span.text.trim(), 0, "named-color");

    // `color: white;`-shaped declarations, scoped to a known list of
    // color-bearing CSS properties (not "any word before a colon") so it
    // stays safe against prose ("Note: white text…") while still catching
    // real declarations in `.css` file bodies and raw style-attribute
    // strings — and, since the Important 2 widening, a named color ANYWHERE
    // in the declaration's value, not only the token immediately after the
    // colon (`color:color-mix(in srgb, var(--color-amber) 12%, black)` finds
    // `black`; `border: 1px solid darkred` finds `darkred`).
    for (const m of span.text.matchAll(CSS_COLOR_PROP_DECL)) {
      const value = m[1] ?? "";
      const valueStart = (m.index ?? 0) + m[0].length - value.length;
      for (const tok of value.matchAll(VALUE_TOKEN)) {
        const word = (tok[0] ?? "").toLowerCase();
        if (!NAMED.has(word)) continue;
        push(word, valueStart + (tok.index ?? 0), "named-color-css");
      }
    }
  }

  // The same substring can legitimately be caught by more than one pattern
  // (e.g. `bg-[rgba(0,0,0,.5)]` matches both FUNC_NAME and TW_ARBITRARY).
  // De-dupe by position so the report doesn't repeat one literal twice.
  const seen = new Set<string>();
  return out.filter((v) => {
    const key = `${v.line}::${v.literal}::${v.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function allowKey(v: { path: string; literal: string }): string {
  // NUL, not "::" - the repo's established composite-key separator (see
  // src/repo-graph/extractor.ts and src/daemon/routes/repo-graph.tsx, and the
  // plan's own Step 3). A path cannot contain NUL and neither can a color
  // literal, so two different (path, literal) pairs can never collide into one
  // key. Purely in-memory: the allowlist file stores `path` and `literal` as
  // separate fields, so the separator is never persisted and changing it is
  // not a file-format change.
  return `${v.path}\u0000${v.literal}`;
}

/**
 * `path` + `literal` alone let an entry silence a violation with no record of
 * WHY it's allowed. This is itself a guard against a weaker allowlist — an
 * entry missing either field is rejected, not silently accepted.
 */
export function findInvalidAllowEntries(entries: AllowEntry[]): AllowEntry[] {
  return entries.filter((e) => !e.category?.trim() || !e.reason?.trim());
}

export type AllowlistLoadResult =
  | { kind: "ok"; entries: AllowEntry[] }
  | { kind: "missing" }
  | { kind: "invalid-json"; error: string }
  | { kind: "missing-entries-field" }
  | { kind: "entries-not-array" };

/**
 * Loads and shape-validates the allowlist file WITHOUT throwing. A missing
 * file, invalid JSON, a missing `entries` field, and an `entries` field that
 * isn't an array are four DIFFERENT failure states that each deserve their
 * own diagnostic — collapsing them into one `catch { allow = [] }` (as an
 * earlier version of this file did) makes a corrupt or absent allowlist
 * silently report as "1 hardcoded color literal(s)" instead of "your
 * allowlist file is broken," and `{"entries": {…}}` (an object, not an
 * array) crashed `main()` with an uncaught TypeError stack trace rather than
 * a clean exit — a guard that crashes ungracefully teaches people to distrust
 * it, same failure family as a guard that silently doesn't fire.
 */
export async function loadAllowlist(path: string): Promise<AllowlistLoadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: "invalid-json", error: (err as Error).message };
  }
  if (typeof parsed !== "object" || parsed === null || !("entries" in parsed)) {
    return { kind: "missing-entries-field" };
  }
  const entries = (parsed as { entries: unknown }).entries;
  if (!Array.isArray(entries)) {
    return { kind: "entries-not-array" };
  }
  return { kind: "ok", entries: entries as AllowEntry[] };
}

/**
 * Turns an `AllowlistLoadResult` into either the entries to proceed with, or
 * `null` after already printing a diagnostic and (for the three genuinely
 * corrupt shapes) exiting. Split out of `main()` so each malformed-state
 * branch's diagnostic lives in one small, single-purpose function instead of
 * inline `if`/`else if` arms — kept `main()`'s own branching count low.
 */
function reportAllowlistLoadFailure(loaded: AllowlistLoadResult): AllowEntry[] | null {
  switch (loaded.kind) {
    case "ok":
      return loaded.entries;
    case "missing":
      // Fails CLOSED, not silently: every real color literal in src/web will
      // surface as an individual violation below (empty allowlist = nothing
      // is pre-approved) — but say so up front rather than let the violation
      // list alone imply "these are all new," when the real cause is "there
      // is no allowlist to check against."
      process.stderr.write(
        `[lint:colors] ${ALLOWLIST_FILE} not found — treating as empty (every color literal in ${ROOTS.join(", ")} will report as a violation).\n`,
      );
      return [];
    case "invalid-json":
      process.stderr.write(`[lint:colors] ${ALLOWLIST_FILE} is not valid JSON: ${loaded.error}\n`);
      break;
    case "missing-entries-field":
      process.stderr.write(`[lint:colors] ${ALLOWLIST_FILE} is missing its "entries" array.\n`);
      break;
    case "entries-not-array":
      process.stderr.write(`[lint:colors] ${ALLOWLIST_FILE}'s "entries" field must be an array.\n`);
      break;
  }
  process.exit(1);
  return null; // unreachable — process.exit(1) never returns; keeps TS happy.
}

/**
 * Walks every `${root}/**\/*.{ts,tsx,css}` file under each of `roots`,
 * scans it, and returns the violations NOT covered by `allowed` — except
 * `template-alpha-suffix`, which ignores `allowed` entirely (see the comment
 * inline below). Split out of `main()` (Important 2, final-branch review):
 * this was the one piece of `main()` doing actual scanning work rather than
 * argument-shape plumbing (load/validate the allowlist, print a report,
 * pick an exit code), and it was flagged for cognitive-complexity — pulling
 * the walk-and-filter loop into its own function is the direct fix, not a
 * broader rewrite.
 */
export async function collectViolations(
  roots: readonly string[],
  allowed: ReadonlySet<string>,
): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const root of roots) {
    for await (const file of new Glob(`${root}/**/*.{ts,tsx,css}`).scan(".")) {
      const source = await readFile(file, "utf8");
      for (const v of scanForColorLiterals(source, file)) {
        // `template-alpha-suffix` has no allowlist escape, by design: unlike
        // every other kind here, there is no CSS shape where `${x}NN` is
        // ever valid — it is always the hex-string-concatenation relic
        // described above TEMPLATE_ALPHA_SUFFIX, never a legitimate literal
        // that a reviewer could sign off with a reason. Letting it through
        // the same `allowed` check as everything else would let one
        // allowlist entry quietly re-open the exact bug this rule exists to
        // make unreturnable.
        if (v.kind === "template-alpha-suffix") {
          violations.push(v);
          continue;
        }
        if (!allowed.has(allowKey(v))) violations.push(v);
      }
    }
  }
  return violations;
}

async function main(): Promise<void> {
  const loaded = await loadAllowlist(ALLOWLIST_FILE);
  const allow = reportAllowlistLoadFailure(loaded);
  if (allow === null) return;

  const bad = findInvalidAllowEntries(allow);
  if (bad.length > 0) {
    process.stderr.write(
      `[lint:colors] ${bad.length} allowlist entr${bad.length === 1 ? "y" : "ies"} missing category or reason:\n` +
        bad.map((e) => `  ${e.path} ${e.literal}`).join("\n") +
        "\n",
    );
    process.exit(1);
  }
  const allowed = new Set(allow.map(allowKey));

  const violations = await collectViolations(ROOTS, allowed);

  if (violations.length === 0) {
    process.stdout.write(`[lint:colors] clean — ${allowed.size} allowlisted site(s) remaining\n`);
    return;
  }
  process.stderr.write(`[lint:colors] ${violations.length} hardcoded color literal(s):\n`);
  for (const v of violations) {
    process.stderr.write(`  ${v.path}:${v.line}  ${v.literal}  (${v.kind})\n`);
  }
  process.stderr.write(
    "\nUse a token from src/web/tokens/palette.ts, or add an entry to " +
      `${ALLOWLIST_FILE} with a category and a written reason.\n`,
  );
  if (violations.some((v) => v.kind === "template-alpha-suffix")) {
    process.stderr.write(
      "\n`${token}NN` is never valid CSS (2 trailing hex digits right after a " +
        "template expression) — it's a hex-string-concatenation relic from before " +
        "tokens.color.* held var(--color-x) strings. There is no allowlist escape " +
        "for this shape; fix it in place with color-mix: " +
        "`color-mix(in srgb, ${token} N%, transparent)`, where N = round(0xNN / 255 * 100).\n",
    );
  }
  process.exit(1);
}

if (import.meta.main) await main();

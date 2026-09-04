// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Value-span extraction for scripts/lint-no-hardcoded-color.ts, using
// TypeScript's own parser.
//
// WHY A PARSER, NOT A CHARACTER WALK (this file replaces
// scripts/lint-colors-tokenizer.ts, a ~225-line hand-rolled state machine).
// Five consecutive independent review passes found five distinct defect
// classes in that walk, and each fix was locally correct for the
// counterexample it was shown while opening a new global failure mode:
//
//   1. multi-line backtick templates were never scanned;
//   2. `.css` unquoted declarations were never scanned;
//   3. CRITICAL — a `//` inside any string (i.e. every URL) blanked the rest
//      of the line, hiding a real literal at
//      `src/web/screens/TimelineScreen.tsx:99`, where
//      `xmlns='http://www.w3.org/2000/svg'` sits immediately before
//      `stroke='%235a4f3f'`;
//   4. the fix for #3 regressed into flagging ordinary English
//      (`<p>Don't use #c0ffee here</p>` — an apostrophe read as a quote);
//   5. CRITICAL — the fix for #4 (rewind-and-re-dispatch on an unterminated
//      delimiter) made the walk re-examine every swallowed range, so nested
//      unterminated templates cost 2^D — on a `blocking: true` CI gate. The
//      constant depends on the fixture but the exponent does not: the
//      originally-reported bomb ran depth 20 = 78 ms / depth 24 = 1.2 s /
//      depth 28 = 18.9 s, and the slightly different fixture now pinned in
//      tests/scripts/lint-colors-spans.test.ts runs depth 20 = 58 ms /
//      depth 22 = 195 ms / depth 24 = 787 ms. Both are a clean x4 per +2.
//
// That is the signature of a character walk without a grammar. Disambiguating
// string vs. template vs. comment vs. JSX text vs. regex-literal-vs-division
// IS the parser's job, and it already does it correctly. So all five classes
// die by construction here rather than by care:
//
//   - comments are not nodes at all, so they are excluded for free (#3's
//     inverse is impossible too: a `//` inside a string is inside a
//     StringLiteral node, and the parser never mistakes it for a comment);
//   - `JsxText` nodes ARE visited but never matched, so prose — apostrophes,
//     stray quotes, stray backticks, markdown-ish inline code — is immune (#4);
//   - a template literal is a `TemplateExpression` whose head/middle/tail
//     tokens carry their own text regardless of how many lines or `${…}`
//     levels it spans (#1);
//   - there is no rewind loop, so there is nothing to blow up (#5). The
//     parser handles an unterminated construct in one linear pass, and this
//     module then refuses to report on it at all (see the parseDiagnostics
//     check below): depth 40 is dispatched in single-digit ms, and depth 40
//     of the same nesting WELL-FORMED scans clean in the same time.
//
// `.css` files never reach this module — they take a deliberately tiny
// separate path in lint-no-hardcoded-color.ts (CSS has only `/* */` comments
// and quoted strings: no `//`, no templates, no JSX). Its simplicity is why
// it is safe; do not generalise it into a second scanner.
//
// The `ts` namespace is imported from `ts-morph` rather than from
// `typescript` directly, deliberately: `typescript` is present in
// node_modules only as a TRANSITIVE dependency (it is in neither
// `dependencies` nor `devDependencies`), so importing it by name would be an
// undeclared dependency — which `bun run audit:dead:knip` flags, and which
// would break the day a lockfile resolution dropped it. `ts-morph` is a
// declared devDependency already used by the sibling guard
// scripts/lint-func-length.ts, and re-exports the complete, unmodified
// TypeScript compiler API. Same parser, declared supply chain.
import { ts } from "ts-morph";

export interface StringSpan {
  /** The literal's cooked text — quotes/backticks and `${`/`}` excluded. */
  text: string;
  /**
   * True for a `TemplateMiddle`/`TemplateTail` span — one whose text starts
   * immediately after a `${…}` interpolation closes, i.e. right after the
   * `}` this module's own docstring says is excluded from `text`. False for
   * a `StringLiteral`, a `NoSubstitutionTemplateLiteral` (no interpolation
   * at all), and a `TemplateHead` (nothing precedes it — it opens the
   * template). Exists so a caller can detect a defect that lives at the
   * BOUNDARY between an interpolation and the literal text that follows it
   * — e.g. `lint-no-hardcoded-color.ts`'s `template-alpha-suffix` rule,
   * which flags exactly 2 hex digits sitting right after `${…}`
   * (`` `${tokens.color.terra}18` ``). That shape is invisible to any regex
   * run over `text` alone, because `${…}` never appears IN `text` — the
   * placeholder markers and the expression inside them are stripped before
   * this field is even populated (see the field above). The only way to
   * know "this text started right after an interpolation" is to ask the
   * node kind while it's still in hand, which is exactly what this field
   * freezes for the caller.
   */
  precededByInterpolation: boolean;
  /**
   * 1-based line of `text[0]` in the original source, resolved from the node's
   * own position by the parser.
   *
   * There is deliberately NO raw-offset field beside this one. `text` is
   * COOKED (escapes decoded, `\r\n` normalised to `\n`) while a source offset
   * is RAW, so adding an index-into-`text` to a raw offset and resolving that
   * against the raw source silently shifts the answer by one line per escape
   * that collapses characters. Measured on the version that did exactly that:
   * `` const s = `a\r\nb\r\nc\r\nd\r\n#c0ffee`; `` reported line 3 for a
   * literal on line 5. Exposing only `line` makes that arithmetic
   * unexpressible: a caller resolves a match as
   * `line + <newlines in text before the match index>`, which never leaves the
   * cooked coordinate system.
   */
  line: number;
}

/**
 * Parses `source` and returns every string-literal / template-literal text
 * span in it, in source order.
 *
 * `path` selects the dialect: a `.tsx` file must be parsed as TSX so that
 * `<p>…</p>` is JSX (whose text is prose, never scanned) rather than a type
 * assertion. Everything else is parsed as TS.
 *
 * Only these five node kinds are matched, and that list is the whole security
 * argument of this module — anything NOT in it (identifiers, JSX text, regex
 * literals, numeric literals, and comments, which are not nodes) is walked
 * over and never scanned for color literals:
 *
 *   - `StringLiteral`                    — `"…"`, `'…'`, and JSX attribute values
 *   - `NoSubstitutionTemplateLiteral`    — `` `…` `` with no `${}`
 *   - `TemplateHead` / `Middle` / `Tail` — the literal chunks of `` `a${x}b` ``
 *
 * The reported line is resolved at `node.getStart(sf) + 1`: every one of these
 * five tokens opens with exactly one delimiter character (`"`, `'`, `` ` ``,
 * or the `}` that closes the preceding interpolation), so the text begins one
 * character in. See `StringSpan.line` for why that is the only positional
 * field this module hands out.
 */
export function collectStringSpans(source: string, path: string): StringSpan[] {
  const sf = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  // A file that did not parse must FAIL LOUD, never report a clean result.
  // This is the sixth defect of the same "syntactic position never reached"
  // family as the five above, found by the review of this very rebuild:
  //
  //     const a = <div>
  //     const c = "#c0ffee";
  //
  // An unclosed tag makes everything to EOF a single `JsxText` node — and
  // JsxText being unmatchable is exactly what makes prose immune (defect 4).
  // So the mechanism that kills one defect swallows this one: the scanner
  // returns no spans, the guard prints "clean", and a real literal ships.
  // Every one of the 190 files under src/web parses with zero diagnostics
  // today, and `typecheck` is a `blocking: true` step that runs BEFORE
  // `lint:colors` in both scripts/ci-local.ts and .github/workflows/ci.yml,
  // so nothing unparseable can reach main through CI — but a guard whose
  // green means "I could not read the file" is the false-green shape this
  // repo keeps getting bitten by, and the check is free.
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    throw new Error(
      `[lint:colors] ${path} did not parse (${diagnostics.length} syntax error(s)); ` +
        "refusing to report a scan result for it. Fix the syntax error — a clean " +
        "result from an unparseable file would be a false green.",
    );
  }

  const spans: StringSpan[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const start = node.getStart(sf) + 1;
      spans.push({
        text: node.text,
        line: sf.getLineAndCharacterOfPosition(start).line + 1,
        precededByInterpolation: ts.isTemplateMiddle(node) || ts.isTemplateTail(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return spans;
}

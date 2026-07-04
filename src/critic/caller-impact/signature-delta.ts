// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { Node, Tree } from "web-tree-sitter";
import { parseSource, type SupportedLang } from "../rubric/tier2/ast-loader.ts";

// signature-delta is the gate for the caller-impact block:
// a block ships only when a changed function's *signature* changed. Scope is
// param-count + required/optional arity (return-type deferred to later work).
// Renames and body-only edits are deliberately NOT a delta — positional
// callers don't break on those.

/** Function node kinds whose parameters we profile. */
const FN_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "generator_function",
  "generator_function_declaration",
]);

// Caller-invisible params — a change to these never breaks a call site, so they
// must not count toward the signature delta. Same exclusion set as the sibling
// long-param-list rubric (`this` is a TS type-only annotation; py self/cls/ctx).
const EXCLUDED_PARAMS = new Set(["this", "self", "cls", "ctx"]);

/** Param-count + required/optional arity of one function. `count === required + optional`. */
export interface ParamProfile {
  count: number;
  required: number;
  optional: number;
}

/** Result of comparing a function's before/after signature. */
export interface SignatureDelta {
  /** True when param-count or required/optional arity differs. */
  changed: boolean;
  /** True when either image could not be parsed to a function — emit no block (Contingency). */
  skipped: boolean;
}

/** The leading identifier name of a param node (or `this`/`self`/...), else null. */
function paramName(param: Node): string | null {
  if (param.type === "identifier") return param.text;
  const first = param.namedChildren[0];
  if (!first) return null;
  // For typed / optional / rest params the first named child is the identifier,
  // or a `this` keyword node for an explicit TS this-parameter.
  if (first.type === "identifier" || first.type === "this") return first.text;
  return null; // destructured pattern — counted, no simple name
}

/** Optional iff `a?`, a defaulted `a = v`, or a rest `...a` (all caller-skippable). */
function isOptionalParam(param: Node): boolean {
  // Verified against tree-sitter-typescript grammar:
  //  - `a?: T`       → node type `optional_parameter`
  //  - `a = default` → `required_parameter` with a `value` field
  //  - `...rest`     → `required_parameter` whose text starts with `...`
  if (param.type === "optional_parameter") return true;
  if (param.childForFieldName("value")) return true;
  if (param.text.startsWith("...")) return true;
  return false;
}

/** The first function-like node in source order (DFS). */
function findFirstFunction(tree: Tree): Node | null {
  const stack: Node[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (FN_TYPES.has(node.type)) return node;
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  return null;
}

/** The param nodes of a function — handles both `(a, b)` and the bare-arrow `x => x` form. */
function paramNodesOf(fn: Node): Node[] {
  const formal = fn.childForFieldName("parameters");
  if (formal && formal.type === "formal_parameters") return formal.namedChildren;
  // Single-param arrow without parens (`x => x`) exposes a `parameter` field.
  const single = fn.childForFieldName("parameter");
  if (single) return [single];
  return [];
}

/**
 * Parse a function's source (declaration / expression / arrow / method) and
 * return its param profile, or `null` when the source can't be parsed to a
 * function (parse failure / non-function / empty). `this`/`self`/`cls`/`ctx`
 * are excluded — they're invisible to callers.
 */
export async function extractParamProfile(
  source: string,
  lang: SupportedLang,
): Promise<ParamProfile | null> {
  if (!source.trim()) return null;
  const tree = await parseSource(source, lang);
  if (!tree) return null;
  const fn = findFirstFunction(tree);
  if (!fn) return null;

  let required = 0;
  let optional = 0;
  for (const param of paramNodesOf(fn)) {
    const name = paramName(param);
    if (name !== null && EXCLUDED_PARAMS.has(name)) continue;
    if (isOptionalParam(param)) optional += 1;
    else required += 1;
  }
  return { count: required + optional, required, optional };
}

/**
 * Compare a function's before/after source. `changed` is true when required or
 * optional arity differs (param-count is `required + optional`, so it's covered);
 * `skipped` is true when either image could not be parsed (caller emits no
 * block — never a whole-file fallback).
 */
export async function signatureDelta(
  before: string,
  after: string,
  lang: SupportedLang,
): Promise<SignatureDelta> {
  const [pre, post] = await Promise.all([
    extractParamProfile(before, lang),
    extractParamProfile(after, lang),
  ]);
  if (!pre || !post) return { changed: false, skipped: true };
  const changed = pre.required !== post.required || pre.optional !== post.optional;
  return { changed, skipped: false };
}

// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { RubricRule, RubricTrigger } from "../types";
import { parseSource, type SupportedLang } from "./ast-loader";

/**
 * defensive-overreach: try/catch around pure CPU code with a silent catch.
 *
 * Conservative by design — better to under-flag than over-flag.
 * Triggers HIGH only when:
 *   1. try body has NO I/O signals (await, fetch, fs., http, etc.)
 *   2. catch block is silent (only console/log/pass - no rethrow, no other side effects)
 */

const LANG_FROM_EXT: Record<string, SupportedLang> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  py: "py",
};

function detectLang(filePath: string): SupportedLang | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return LANG_FROM_EXT[ext] ?? null;
}

/** I/O signal patterns for text-based detection in the try body */
const IO_PATTERNS: RegExp[] = [
  /\bawait\b/,
  /\bfetch\s*\(/,
  /\bfs\./,
  /\bhttp\b/,
  /\bchild_process\b/,
  /\bspawn\s*\(/,
  /\bexec\s*\(/,
  /\.then\s*\(/,
  /\bopen\s*\(/,   // Python open()
  /\brequests?\./,  // Python requests
  /\bsocket\b/,
  /\bsubprocess\b/,
  /\bos\.popen\b/,
];

/** Log-like call names considered "silent" in TS/JS catch blocks */
const SILENT_TS_LOG_NAMES = new Set([
  "log", "warn", "error", "info", "debug", "trace",
  "console",
]);

/**
 * Returns true if the given text contains any I/O signals.
 * Applied to the full text of the try body block.
 */
function hasIoSignals(text: string): boolean {
  return IO_PATTERNS.some((re) => re.test(text));
}

// TS/JS: Returns true if a catch clause body is "silent":
// - Only contains console/log calls or empty
// - No throw statements
// - No assignments to non-local state
function isTsCatchSilent(catchClause: SyntaxNode): boolean {
  const body = catchClause.childForFieldName("body");
  if (!body) return true; // empty catch — silent

  const bodyText = body.text;

  // Presence of throw → not silent
  if (/\bthrow\b/.test(bodyText)) return false;

  // Walk all statements in the catch body
  for (const child of body.namedChildren) {
    if (!isAllowedTsNode(child)) return false;
  }
  return true;
}

// Returns true if the TS/JS node is an allowed "silent" node in a catch block.
// Allowed: expression statements that are only console/log calls.
function isAllowedTsNode(node: SyntaxNode): boolean {
  if (node.type === "empty_statement") return true;

  if (node.type === "expression_statement") {
    const expr = node.namedChildren[0];
    if (!expr) return true;
    if (expr.type === "call_expression") {
      return isSilentTsCallExpr(expr);
    }
    return false;
  }

  // throw_statement → not silent
  if (node.type === "throw_statement") return false;

  // Any other statement → not silent (conservative)
  return false;
}

// Returns true if a call_expression is a console/log-style silent call.
function isSilentTsCallExpr(callExpr: SyntaxNode): boolean {
  const fn = callExpr.childForFieldName("function");
  if (!fn) return false;

  // console.log(e) → member_expression with object=console
  if (fn.type === "member_expression") {
    const obj = fn.childForFieldName("object");
    if (obj && SILENT_TS_LOG_NAMES.has(obj.text)) return true;
    // log.error(e) etc.
    const prop = fn.childForFieldName("property");
    if (prop && SILENT_TS_LOG_NAMES.has(prop.text)) return true;
    return false;
  }

  // log(e) or logger(e) as standalone call
  if (fn.type === "identifier") {
    return SILENT_TS_LOG_NAMES.has(fn.text);
  }

  return false;
}

/** Python log function names that count as silent */
const SILENT_PY_LOG_NAMES = new Set([
  "print", "log", "logging", "logger",
]);

/**
 * Python: Returns true if an except clause body is "silent":
 * - Only contains pass statements or log/print calls
 * - No raise statements
 */
function isPyCatchSilent(exceptClause: SyntaxNode): boolean {
  const body = exceptClause.childForFieldName("body");
  if (!body) return true;

  const bodyText = body.text;
  if (/\braise\b/.test(bodyText)) return false;

  for (const child of body.namedChildren) {
    if (!isAllowedPyNode(child)) return false;
  }
  return true;
}

function isAllowedPyNode(node: SyntaxNode): boolean {
  if (node.type === "pass_statement") return true;

  if (node.type === "expression_statement") {
    const expr = node.namedChildren[0];
    if (!expr) return true;
    if (expr.type === "call") {
      return isSilentPyCall(expr);
    }
    return false;
  }

  // raise → not silent
  if (node.type === "raise_statement") return false;

  return false;
}

function isSilentPyCall(callNode: SyntaxNode): boolean {
  const fn = callNode.childForFieldName("function");
  if (!fn) return false;

  if (fn.type === "identifier") {
    return SILENT_PY_LOG_NAMES.has(fn.text);
  }

  // logging.error(e) / logger.debug(e)
  if (fn.type === "attribute") {
    const obj = fn.childForFieldName("object");
    if (obj && SILENT_PY_LOG_NAMES.has(obj.text)) return true;
  }

  return false;
}

/** Collect all try_statement nodes in the tree */
function collectTryStatements(root: SyntaxNode): SyntaxNode[] {
  const results: SyntaxNode[] = [];

  function walk(node: SyntaxNode): void {
    if (node.type === "try_statement") results.push(node);
    for (const child of node.namedChildren) walk(child);
  }

  walk(root);
  return results;
}

export const defensiveOverreachRule: RubricRule = {
  id: "defensive-overreach",
  tier: 2,
  languages: ["ts", "tsx", "js", "jsx", "py"],

  async run(input) {
    const t0 = performance.now();
    const triggers: RubricTrigger[] = [];

    for (const file of input.changedFiles) {
      const lang = detectLang(file);
      if (!lang) continue;

      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch {
        continue;
      }

      const tree = await parseSource(source, lang);
      if (!tree) continue;

      const lines = source.split("\n");
      const tryNodes = collectTryStatements(tree.rootNode);

      for (const tryNode of tryNodes) {
        const tryBody = tryNode.childForFieldName("body");
        if (!tryBody) continue;

        const tryBodyText = tryBody.text;

        // Skip if body contains I/O signals — conservative, don't flag I/O wraps
        if (hasIoSignals(tryBodyText)) continue;

        if (lang === "py") {
          // Python: check each except_clause
          const exceptClauses = tryNode.namedChildren.filter(
            (c: SyntaxNode) => c.type === "except_clause",
          );
          if (exceptClauses.length === 0) continue;

          const allSilent = exceptClauses.every((ec: SyntaxNode) =>
            isPyCatchSilent(ec),
          );
          if (!allSilent) continue;

          const line = tryNode.startPosition.row;
          triggers.push({
            rule_id: "defensive-overreach",
            tier: 2 as const,
            severity: "high",
            file,
            line: line + 1,
            end_line: tryNode.endPosition.row + 1,
            snippet: lines[line] ?? "",
            message:
              "try/except wraps CPU-only code with a silent except (pass or log-only). Exceptions should be handled or allowed to propagate.",
            suggested_fix:
              "Remove the try/except, handle the specific error case explicitly, or rethrow after logging.",
          });
        } else {
          // TS/JS: check catch_clause
          const catchClause = tryNode.namedChildren.find(
            (c: SyntaxNode) => c.type === "catch_clause",
          );
          if (!catchClause) continue;

          if (!isTsCatchSilent(catchClause)) continue;

          const line = tryNode.startPosition.row;
          triggers.push({
            rule_id: "defensive-overreach",
            tier: 2 as const,
            severity: "high",
            file,
            line: line + 1,
            end_line: tryNode.endPosition.row + 1,
            snippet: lines[line] ?? "",
            message:
              "try/catch wraps CPU-only code with a silent catch (console.log or empty). Exceptions should be handled or allowed to propagate.",
            suggested_fix:
              "Remove the try/catch, handle the specific error case explicitly, or rethrow after logging.",
          });
        }
      }
    }

    return {
      rule_id: "defensive-overreach",
      triggers,
      duration_ms: performance.now() - t0,
    };
  },
};

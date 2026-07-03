// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Parse the first JSDoc-style block at the top of a
 * TS/JS source file and return its first descriptive line.
 *
 * Used by the repo-graph file-level scene to show each file's
 * purpose as a one-liner. Returns "" when the file does not begin with
 * a doc-comment (after optional blank lines + license `// ...` line
 * comments).
 *
 * "First descriptive line" = the first non-empty content line inside
 * the comment that does NOT start with a JSDoc `@tag`. Tags + their
 * argument lines (`@param`, `@returns`, `@throws`, etc.) are skipped.
 */

export function parseFirstDocComment(source: string): string {
  const lines = source.split(/\r?\n/);

  // Skip leading whitespace + line comments. If we hit anything else
  // before a `/**`, this file does not lead with a doc-comment.
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
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
  if (singleLineMatch) return singleLineMatch[1]!.trim();

  // Multi-line form. Walk the comment body until `*/`.
  i += 1;
  while (i < lines.length) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (trimmed.startsWith("*/")) break;
    // Strip the leading `* ` (or `*`) prefix.
    const body = trimmed.replace(/^\*\s?/, "").trim();
    if (body === "") {
      i += 1;
      continue;
    }
    if (body.startsWith("@")) {
      // Hit a tag before finding any description → no descriptive line.
      return "";
    }
    return body;
  }
  return "";
}

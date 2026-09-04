// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { createHash } from "node:crypto";

const normalize = (line: string): string => line.replace(/\s+/g, " ").trim();

/** sha256 of one line's whitespace-normalized content. */
export function contentFingerprint(lineText: string): string {
  return createHash("sha256").update(normalize(lineText)).digest("hex");
}

/**
 * Content-fingerprint of the flagged 1-indexed line, captured at critique-time.
 * Returns "" when `line` is out of range OR the line is blank (un-fingerprintable
 * -> the oracle abstains). Position-independent: only the line's CONTENT is hashed.
 */
export function lineContentFingerprint(fileText: string, line: number): string {
  const lines = fileText.split("\n");
  if (line < 1 || line > lines.length) return "";
  if (normalize(lines[line - 1]) === "") return "";
  return contentFingerprint(lines[line - 1]);
}

/**
 * Set of content-fingerprints for every non-blank line, computed at eval-time.
 * The oracle checks whether the captured flagged-line fingerprint is still a
 * member -- present => content survived (moved/reformatted/untouched) => not_yet;
 * absent => content is gone => acted. Drift-robust.
 */
export function fileContentFingerprints(fileText: string): Set<string> {
  const set = new Set<string>();
  for (const line of fileText.split("\n")) {
    if (normalize(line) !== "") set.add(contentFingerprint(line));
  }
  return set;
}

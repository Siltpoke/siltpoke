// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Per-file fingerprint = content sha256 + AST signature.
 *
 * Used by the builder to short-circuit re-walks: if BOTH the content
 * sha and the AST sig match the cached fingerprint, the file's nodes +
 * edges are reused from the previous graph and the file isn't re-parsed.
 */
import { createHash } from "node:crypto";
import type { Tree } from "web-tree-sitter";
import { computeAstSignature } from "./ast-signature";
import type { FileFingerprint } from "./types";

/**
 * Bump when the extractor starts producing different nodes or edges for the
 * same bytes. A file whose fingerprint carries any other value is re-parsed on
 * the next build instead of reusing its stored nodes — once; the rebuild
 * restamps it. Without this, an extraction fix reaches only the files someone
 * happens to edit.
 *
 *   2 — a symbol's `doc` is the first sentence of its doc comment, not the
 *       first line (defect [45]). Fingerprints written before this field
 *       existed have no value and count as older.
 */
export const EXTRACTOR_VERSION = 2;

/**
 * Same bytes do not mean same nodes once the extractor changes what it
 * produces, so stored nodes are reused only when the extractor that wrote
 * them is the current one. Absent (older than the field) and newer both miss.
 */
export function sameExtractor(cached: FileFingerprint): boolean {
  return cached.extractor === EXTRACTOR_VERSION;
}

export function computeContentSha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function computeFingerprint(content: string, tree: Tree): FileFingerprint {
  return {
    content_sha256: computeContentSha(content),
    ast_sig: computeAstSignature(tree),
    // Must stay in lockstep with the builder's own fingerprint construction:
    // a fingerprint written WITHOUT this field reads as "unknown" and forces a
    // re-parse forever, permanently defeating the cache for those files.
    degraded: tree.rootNode.hasError,
    extractor: EXTRACTOR_VERSION,
  };
}

/**
 * True iff both halves match — file can be skipped on incremental rebuild.
 */
export function fingerprintMatches(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.content_sha256 === b.content_sha256 && a.ast_sig === b.ast_sig;
}

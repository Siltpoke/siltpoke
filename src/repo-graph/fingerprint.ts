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
  };
}

/**
 * True iff both halves match — file can be skipped on incremental rebuild.
 */
export function fingerprintMatches(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.content_sha256 === b.content_sha256 && a.ast_sig === b.ast_sig;
}

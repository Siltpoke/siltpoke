// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Path canonicalizer for `seen.json` / fingerprints / advance-entry keys (spec §5):
 * repo-root-relative, POSIX separators, no leading `./` or `/`, normalized `..`,
 * NFC, idempotent. A mismatch between two callers' key forms = a "seen" file
 * reappears forever (the watermark never matches).
 *
 * Root-escape policy: a path that, after normalization, still points above the
 * repo root (starts with `../`, or is exactly `..`) is REJECTED by throwing
 * `RootEscapeError` — chosen over a sentinel return value so a caller can never
 * accidentally treat a rejected path as a normal (if odd) key. Any POST handler
 * that derives a `seen.json` key from user/network input MUST catch this and
 * refuse the mutation rather than writing an out-of-root key.
 *
 * Leading `/` is stripped BEFORE `normalize()` runs, not after. Node's POSIX
 * `normalize()` treats a leading-`/` string as absolute and silently collapses
 * any `..` that would go above root (e.g. `normalize("/../../x.ts")` →
 * `"/x.ts"`, the escape erased from the string). Stripping the leading `/`
 * first means `/../../x.ts` is normalized as the RELATIVE `../../x.ts`, which
 * `normalize()` leaves untouched (POSIX can't resolve a relative `..` above an
 * unknown root) — so it reaches the reject check intact, same as the
 * unprefixed form. (Fix round 1, review 2026-07-27: a leading-`/` variant of
 * the same escape string was silently accepted+transformed instead of
 * rejected — the bug this ordering closes.)
 */
import { normalize } from "node:path/posix";

export class RootEscapeError extends Error {
  constructor(relPath: string) {
    super(`canonicalKey: root-escaping path rejected: ${relPath}`);
    this.name = "RootEscapeError";
  }
}

export function canonicalKey(relPath: string): string {
  const posix = relPath.replace(/\\/g, "/");
  const relative = posix.replace(/^\/+/, "");
  const normalized = normalize(relative || ".");
  const stripped = normalized.replace(/\/+$/, "");

  if (stripped === ".." || stripped.startsWith("../")) {
    throw new RootEscapeError(relPath);
  }

  const collapsed = stripped === "." ? "" : stripped;
  return collapsed.normalize("NFC");
}

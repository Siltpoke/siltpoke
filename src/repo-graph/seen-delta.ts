// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Pure classification of a single file's seen-vs-current fingerprint delta
 * (slice ③), plus `classifyAll` which runs it over an entire watermark.
 *
 * `classifySeenFingerprintDelta` is intentionally dumb: it takes the two
 * fingerprint sides (already looked up) plus a pre-computed
 * `astSigVersionMismatch` flag, and returns facts — no path, no I/O, no
 * lookups. `classifyAll` owns everything stateful: canonicalizing keys,
 * computing the version-mismatch flag ONCE, walking the key union, and
 * dropping the boring case (`tracked` + nothing changed).
 */
import { AST_SIG_VERSION } from "./ast-signature";
import { canonicalKey, RootEscapeError } from "./seen-path";
import type { Fingerprints, SeenFileDelta, SeenWatermark } from "./types";

/** A `seen.json` / `Fingerprints` per-file entry, as validated at read time. */
interface FileSide {
  content_sha256: string;
  ast_sig: string;
}

/**
 * Per-entry shape guard (task-1 carry-forward). `readSeen`'s top-level shape
 * check does not descend into `files[key]` — a hand-edited or partially
 * written `seen.json` could have a `files` object whose values aren't
 * `{content_sha256, ast_sig}`. Same risk on the `Fingerprints` side (no
 * per-entry validation there either). Treat anything that doesn't look like
 * a real `FileSide` as absent — this feeds `unparseable`/`new_to_you`/
 * `deleted` fallbacks rather than crashing on `undefined.content_sha256`.
 */
function asFileSide(value: unknown): FileSide | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.content_sha256 !== "string" || typeof rec.ast_sig !== "string") {
    return undefined;
  }
  return { content_sha256: rec.content_sha256, ast_sig: rec.ast_sig };
}

/**
 * Classify one file's delta between its `seen.json` baseline entry and its
 * current fingerprint entry. Pure — no I/O, no path attached (caller adds
 * `path`).
 *
 * Rule order:
 *   1. `currentFile` missing → `deleted` (unparseable iff the SEEN side's
 *      ast_sig is empty — the deleted file's only surviving signal).
 *   2. `seenFile` missing → `new_to_you` (unparseable iff the CURRENT side's
 *      ast_sig is empty — the new file's only signal).
 *   3. else → `tracked`: `body_changed` = sha differs; `unparseable` = EITHER
 *      side's ast_sig is empty; `signature_changed` = ast_sig differs AND
 *      NOT unparseable AND NOT `astSigVersionMismatch`.
 *
 * C5: `unparseable` is scoped BY baseline_status, never a blanket
 * `!seen?.ast_sig || !cur?.ast_sig` OR — that would flag every `new_to_you`/
 * `deleted` file unparseable via its undefined side, even when the one side
 * that actually exists has a perfectly real ast_sig.
 */
export function classifySeenFingerprintDelta(
  seenFileRaw: FileSide | undefined,
  currentFileRaw: FileSide | undefined,
  opts: { astSigVersionMismatch: boolean },
): Omit<SeenFileDelta, "path"> {
  const seenFile = asFileSide(seenFileRaw);
  const currentFile = asFileSide(currentFileRaw);

  if (currentFile === undefined) {
    return {
      baseline_status: "deleted",
      signature_changed: false,
      body_changed: false,
      unparseable: seenFile === undefined || seenFile.ast_sig === "",
    };
  }

  if (seenFile === undefined) {
    return {
      baseline_status: "new_to_you",
      signature_changed: false,
      body_changed: false,
      unparseable: currentFile.ast_sig === "",
    };
  }

  const body_changed = seenFile.content_sha256 !== currentFile.content_sha256;
  const unparseable = seenFile.ast_sig === "" || currentFile.ast_sig === "";
  const signature_changed =
    seenFile.ast_sig !== currentFile.ast_sig && !unparseable && !opts.astSigVersionMismatch;

  return {
    baseline_status: "tracked",
    signature_changed,
    body_changed,
    unparseable,
  };
}

/**
 * Canonicalize every key of a `files` record, dropping (not throwing on) any
 * key `canonicalKey` rejects as root-escaping. Shared by both sides of
 * `classifyAll` so the union-building loop stays simple (C6).
 */
function canonicalizeFiles(files: Record<string, unknown> | undefined): Map<string, FileSide | undefined> {
  const out = new Map<string, FileSide | undefined>();
  for (const [rawKey, value] of Object.entries(files ?? {})) {
    let key: string;
    try {
      key = canonicalKey(rawKey);
    } catch (err) {
      if (err instanceof RootEscapeError) continue;
      throw err;
    }
    out.set(key, asFileSide(value));
  }
  return out;
}

/**
 * Classify every file in the union of `seen.files` and `current.files` keys.
 * Drops `tracked` files with no change (only changed/new/deleted files
 * appear in the result) — callers only care about what's different.
 *
 * `currentVersion` defaults to the live `AST_SIG_VERSION` but is injectable
 * so tests (and any future caller comparing against a specific algorithm
 * generation) can force a mismatch without needing a real version bump.
 *
 * C6: both `seen`'s keys and `current.files`'s keys are canonicalized before
 * the union — `Fingerprints` keys (slice ②) are not guaranteed canonical, and
 * a canonical-vs-raw mismatch would misclassify a present file as `deleted`.
 * A key that `canonicalKey` rejects (`RootEscapeError`) is skipped, not
 * thrown — one bad key must never abort the whole classify.
 *
 * C7: an empty/absent `current` (unindexed repo, or the index was cleared)
 * never throws — and never floods the caller with a whole-repo "deleted"
 * projection. Fix round 1 (2026-07-27 review): if `current.files` is
 * entirely empty AFTER canonicalization, `classifyAll` ABSTAINS and returns
 * `[]`, regardless of how many files `seen` has. An empty `current` means
 * "we don't know the current state" (never indexed / index cleared) — the
 * files on disk have NOT actually vanished, so reporting them all as
 * `deleted` would be exactly the kind of false/scary bulk signal this spec's
 * discovery-only guards exist to prevent. This mirrors `SeenWatermark`'s own
 * `unknown_baseline` pattern: prefer an explicit "unknown/abstain" over a
 * false bulk projection. Ordinary per-key `deleted` detection — `current` is
 * POPULATED but missing this one specific key — is unaffected; only the
 * all-empty-current case short-circuits.
 */
export function classifyAll(
  seen: SeenWatermark,
  current: Fingerprints,
  currentVersion: number = AST_SIG_VERSION,
): SeenFileDelta[] {
  const astSigVersionMismatch = seen.ast_sig_version !== currentVersion;

  const canonicalSeen = canonicalizeFiles(seen.files);
  const canonicalCurrent = canonicalizeFiles(current.files);

  // C7 fix round 1: an entirely-empty current (post-canonicalization) means
  // "unknown current state", not "every seen file was deleted" — abstain.
  if (canonicalCurrent.size === 0) {
    return [];
  }

  const keyUnion = new Set<string>([...canonicalSeen.keys(), ...canonicalCurrent.keys()]);

  const deltas: SeenFileDelta[] = [];
  for (const path of keyUnion) {
    const seenFile = canonicalSeen.get(path);
    const currentFile = canonicalCurrent.get(path);
    const delta = classifySeenFingerprintDelta(seenFile, currentFile, { astSigVersionMismatch });

    if (delta.baseline_status === "tracked" && !delta.signature_changed && !delta.body_changed) {
      continue; // unchanged tracked file — not interesting, drop it
    }

    deltas.push({ path, ...delta });
  }

  return deltas;
}

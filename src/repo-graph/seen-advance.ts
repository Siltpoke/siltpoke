// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The write core for `seen.json` (slice ③, spec R5/R7/R13) — the ONLY module
 * allowed to mutate the user-seen watermark post-seed. Two mutators:
 *
 *   - `advanceSeenFile` — advance ONE file's watermark entry to its current
 *     fingerprint (or remove the entry if the file is gone from `current`).
 *   - `markAllSeen`     — advance EVERY file at once (a full "mark all as
 *     seen"), backing up the prior `seen.json` first, clearing
 *     `unknown_baseline`, and re-stamping `ast_sig_version`.
 *
 * ## The `origin` capability (R13, plan cross-family review C1)
 *
 * Both mutators require a `SeenWriteOrigin` token. This is deliberately NOT
 * a string-literal type (`type SeenWriteOrigin = "human_ui"`) — a string
 * literal is forgeable by ANY producer module (the indexer, the review
 * runner, ...) simply by typing `"human_ui"`. Instead this is an OPAQUE
 * BRAND type, keyed by a module-private `unique symbol`:
 *
 *   - `HUMAN_UI_BRAND` is a module-private `unique symbol`, never exported —
 *     no other module can `import` it.
 *   - `SeenWriteOrigin` is exported as `{ readonly [HUMAN_UI_BRAND]: true }`
 *     — an object type whose only key is that unexported symbol. A producer
 *     can name the TYPE (e.g. to type a parameter it forwards untouched) but
 *     cannot CONSTRUCT a value of it: writing `{ [HUMAN_UI_BRAND]: true }`
 *     requires the symbol itself, which isn't reachable from outside this
 *     file. (An earlier revision made `SeenWriteOrigin` the unique-symbol
 *     type itself rather than a brand key on an object — TypeScript
 *     silently widens a `unique symbol`-typed value to plain `symbol` the
 *     moment it's stored in any variable other than the original literal
 *     `const`, which broke every call site that first assigned a cast
 *     result to a local before passing it on, including the daemon's real
 *     future POST-handler code. The brand-key-on-an-object form doesn't
 *     have that widening problem — verified against `bunx tsc --noEmit`.)
 *   - `withHumanOrigin(fn)` is the ONE exported way to obtain a real token:
 *     it calls `fn(HUMAN_UI_CAPABILITY)` (the one real value of the type)
 *     and returns the result. Intended callers: the daemon's
 *     human-triggered POST handlers ONLY — routes that fire from a real
 *     user click in the dashboard (e.g. "mark file seen" / "mark all seen"
 *     buttons). An indexer, review runner, or any background producer must
 *     NEVER call `withHumanOrigin` — doing so would defeat the
 *     "human-originated only" guarantee this module exists to enforce.
 *   - Both mutators additionally RUNTIME-CHECK `origin === HUMAN_UI_CAPABILITY`
 *     by reference identity (not structural/shape equality) and throw
 *     `TypeError` otherwise. Reference identity — not just "does it have the
 *     right brand key" — is deliberate: it also rejects a STRUCTURAL CLONE
 *     of a legitimately-captured token (e.g. `{ ...captured }`, which DOES
 *     copy an enumerable symbol-keyed property and would satisfy a
 *     shape/duck-typed check). The negative tests in
 *     `seen-advance.test.ts` exercise a forged string, a forged plain
 *     object, `undefined`, and a spread-clone of a real captured token —
 *     all rejected.
 *
 * Known limit (documented, not hidden): `withHumanOrigin` is itself an
 * exported function, so nothing in the module system stops a determined
 * caller from importing and calling it directly — JS module boundaries are
 * not a hard security sandbox. What IS prevented: (1) casual/accidental
 * misuse — a producer cannot just type the string `"human_ui"` or spread a
 * captured token and have it accepted; (2) the type checker flags any
 * attempt to fabricate a `SeenWriteOrigin` without a visible unsafe cast
 * (`as unknown as SeenWriteOrigin`), which is a loud, grep-able,
 * review-visible smell; (3) even a successful cast or a structural clone is
 * caught at runtime by the reference-identity check, so a forged token can
 * never actually mutate `seen.json`. The residual trust is "only call
 * `withHumanOrigin` from a real human-triggered handler" — carried by code
 * review + this file's own doc comment, which is the same trust boundary
 * every capability-token pattern in a single-process JS runtime ultimately
 * rests on (there is no process-level sandboxing between modules in the
 * same Bun/Node process).
 */
import { existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { AST_SIG_VERSION } from "./ast-signature";
import { canonicalKey, RootEscapeError } from "./seen-path";
import { captureGitHeadSha } from "./seen-seed";
import { readSeen, writeSeen } from "./store";
import type { FileFingerprint, Fingerprints, SeenWatermark } from "./types";

const SEEN_FILE = "seen.json";
const SEEN_BACKUP_FILE = "seen.json.bak";

/** Module-private brand key. NEVER export this — see file header. Only code
 * in this file can write or read an object property keyed by it. */
const HUMAN_UI_BRAND: unique symbol = Symbol("seen.human_ui");

/**
 * Opaque capability type — see file header "The `origin` capability" for
 * the full unforgeability argument. A producer module cannot construct a
 * value of this type (the brand key isn't reachable from outside this
 * file); the only way to obtain the real one is `withHumanOrigin`.
 */
export type SeenWriteOrigin = { readonly [HUMAN_UI_BRAND]: true };

/** Module-private capability token — the ONE real value of type
 * `SeenWriteOrigin`. NEVER export this directly — see file header. */
const HUMAN_UI_CAPABILITY: SeenWriteOrigin = { [HUMAN_UI_BRAND]: true };

/**
 * The ONLY exported way to obtain a `SeenWriteOrigin` capability token.
 * Intended callers: the daemon's human-triggered POST handlers ONLY. See
 * file header "Known limit" for what this mechanism does and doesn't
 * enforce.
 */
export function withHumanOrigin<T>(fn: (origin: SeenWriteOrigin) => T): T {
  return fn(HUMAN_UI_CAPABILITY);
}

/** Runtime gate: rejects anything that isn't the real capability token by
 * reference identity (not structural equality — see file header on why a
 * spread-clone must also fail). The backstop against a forged/absent/cloned
 * origin that slipped past the type system via an unsafe cast. */
function assertHumanOrigin(origin: SeenWriteOrigin): void {
  if (origin !== HUMAN_UI_CAPABILITY) {
    throw new TypeError(
      "seen-advance: invalid origin capability — must be obtained via withHumanOrigin()",
    );
  }
}

/**
 * Per-entry shape guard (task-1/2 carry-forward) — a hand-edited or
 * partially-written `Fingerprints` file could have a `files[key]` value
 * that isn't `{content_sha256, ast_sig}`. Treat anything that doesn't look
 * like a real `FileFingerprint` as absent rather than crashing on
 * `undefined.content_sha256`.
 */
function asFileFingerprint(value: unknown): FileFingerprint | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.content_sha256 !== "string" || typeof rec.ast_sig !== "string") {
    return undefined;
  }
  if (typeof rec.degraded === "boolean") {
    return { content_sha256: rec.content_sha256, ast_sig: rec.ast_sig, degraded: rec.degraded };
  }
  return { content_sha256: rec.content_sha256, ast_sig: rec.ast_sig };
}

/**
 * Canonicalize an arbitrary raw `{key: FileFingerprint-shaped}` record,
 * dropping (not throwing on) any root-escaping key and any malformed
 * per-entry value. Shared by `canonicalizeCurrentFiles` (the `current` side)
 * and, as of the slice ③ fast-follow, `advanceSeenFile` (the on-disk
 * `seen.files` side) — `readSeen` (`store.ts`) validates only the TOP-LEVEL
 * `SeenWatermark` shape (`ast_sig_version`/`baseline_sha`/`files`/
 * `unknown_baseline` present with the right primitive types); it does NOT
 * re-canonicalize each `files` key, so a hand-edited or pre-canonicalization
 * `seen.json` can carry a raw key like `"./src/a.ts"` sitting right next to
 * (or instead of) its canonical form.
 */
function canonicalizeFilesRecord(
  rawFiles: Record<string, unknown> | null | undefined,
): Record<string, FileFingerprint> {
  const out: Record<string, FileFingerprint> = {};
  if (rawFiles === null || rawFiles === undefined || typeof rawFiles !== "object") return out;

  for (const [rawKey, rawValue] of Object.entries(rawFiles)) {
    const fp = asFileFingerprint(rawValue);
    if (fp === undefined) continue;

    let key: string;
    try {
      key = canonicalKey(rawKey);
    } catch (err) {
      if (err instanceof RootEscapeError) continue;
      throw err;
    }
    out[key] = fp;
  }
  return out;
}

/**
 * Canonicalize every key of `current.files` (C6 — no shallow assign; a
 * slice-② `Fingerprints` key isn't guaranteed canonical). Guards `current`
 * itself being null/undefined/wrong-shape (C7) — never assumes the caller
 * validated it; an empty/not-indexed `current` simply yields `{}` here
 * rather than crashing.
 */
function canonicalizeCurrentFiles(
  current: Fingerprints | null | undefined,
): Record<string, FileFingerprint> {
  const rawFiles: Record<string, unknown> =
    current !== null && current !== undefined && typeof current.files === "object" && current.files !== null
      ? current.files
      : {};
  return canonicalizeFilesRecord(rawFiles);
}

/** Copy the existing `seen.json` to `seen.json.bak` (recovery backup). A
 * no-op when `seen.json` doesn't exist yet — nothing to preserve. */
async function backupSeenIfPresent(storageDir: string): Promise<void> {
  const seenPath = join(storageDir, SEEN_FILE);
  if (!existsSync(seenPath)) return;
  await copyFile(seenPath, join(storageDir, SEEN_BACKUP_FILE));
}

/**
 * Advance ONE file's `seen.json` entry to its current fingerprint.
 *
 *   1. C7 fix round 2 (reviewer 2026-07-27): re-canonicalize `current.files`
 *      FIRST, exactly as `markAllSeen` now does. If the result is EMPTY —
 *      `current` is null/undefined/wrong-shape, or the repo genuinely isn't
 *      indexed yet — this function ABSTAINS: no-op, same posture as
 *      `markAllSeen`'s empty-current guard (silent return, no read, no
 *      write, existing `seen.json` left completely untouched). Without this
 *      guard, ANY requested `path` would look absent from an empty
 *      `current`, so the "not present → remove the key" branch below would
 *      silently erase a previously-seen watermark entry — the identical
 *      self-defeating-watermark hazard `markAllSeen` was patched for one
 *      commit earlier (a caller-side assumption like "Task 5 only fires an
 *      advance when there's an actual delta row" is an unverified future
 *      dependency; this central-guard write core must be safe on its own).
 *   2. Otherwise: `path` is canonicalized before use (C6). A root-escaping
 *      `path` (rejected by `canonicalKey` via `RootEscapeError`) is
 *      REJECTED — the mutation is silently skipped, never crashed (mirrors
 *      the seen-path.ts policy that one bad key must never throw the whole
 *      op).
 *   3. Looked up against the (now known non-empty) canonicalized
 *      `current.files` (C6) — a non-canonical `current` key (carried over
 *      from slice-② `Fingerprints`, which doesn't guarantee canonical keys)
 *      must not make a present file look deleted and get wrongly removed.
 *   4. Present in `current` → write its fingerprint into `seen.files[key]`.
 *      Genuinely absent from a POPULATED `current` (a real deletion — the
 *      file existed in the index before but doesn't anymore) → REMOVE the
 *      key from `seen.files`.
 *   4b. Fast-follow (slice ③, 2026-07-27): the on-disk `seen.files` is
 *      re-canonicalized too, exactly like `current.files` — `readSeen` only
 *      validates the top-level `SeenWatermark` shape, not that each existing
 *      key is already canonical, so an overwrite/delete keyed only by the
 *      canonical form could otherwise leave (or create) a duplicate
 *      raw-plus-canonical entry.
 *   5. Does NOT touch `unknown_baseline` — only `markAllSeen` clears that.
 */
export async function advanceSeenFile(
  storageDir: string,
  path: string,
  current: Fingerprints,
  origin: SeenWriteOrigin,
): Promise<void> {
  assertHumanOrigin(origin);

  const canonicalCurrent = canonicalizeCurrentFiles(current);
  if (Object.keys(canonicalCurrent).length === 0) {
    return; // C7 fix round 2 — abstain, see doc comment above
  }

  let key: string;
  try {
    key = canonicalKey(path);
  } catch (err) {
    if (err instanceof RootEscapeError) return; // reject the mutation, don't crash the op
    throw err;
  }

  const fp = canonicalCurrent[key];

  const seen = await readSeen(storageDir);
  // Fast-follow (slice ③): canonicalize the ON-DISK `seen.files` keys too,
  // symmetric with `current` above and with `markAllSeen`/`classifyAll`
  // (both of which already canonicalize the seen side). Spreading the raw
  // `seen.files` here would be asymmetric: a raw non-canonical key could sit
  // ALONGSIDE a freshly-written canonical key (an overwrite never touches
  // the raw duplicate) or survive a delete that only removes the canonical
  // form (the raw-keyed entry becomes an invisible "ghost" the delta math
  // never accounts for again).
  const nextFiles = canonicalizeFilesRecord(seen.files);
  if (fp === undefined) {
    delete nextFiles[key]; // real deletion — current IS populated, this key just isn't in it
  } else {
    nextFiles[key] = { content_sha256: fp.content_sha256, ast_sig: fp.ast_sig };
  }

  await writeSeen(storageDir, { ...seen, files: nextFiles });
}

/**
 * Advance EVERY file at once — the "mark all as seen" action.
 *
 *   1. C7 fix round 1 (reviewer 2026-07-27): re-canonicalize `current.files`
 *      FIRST. If the result is EMPTY — `current` is null/undefined/
 *      wrong-shape, or the repo genuinely isn't indexed yet — this function
 *      ABSTAINS: no write happens at all, and any existing `seen.json`
 *      (including its `unknown_baseline` flag) is left completely
 *      untouched. Writing `seen.files = {}` here would be a *self-defeating
 *      watermark*: once the index is later populated, EVERY file would read
 *      `new_to_you` — the exact opposite of "I've seen everything",
 *      silently produced by a click the user made in good faith. This
 *      mirrors the identical hazard `classifyAll` (`seen-delta.ts`) was
 *      patched for one commit earlier this slice — the write core must not
 *      lean on a future "don't offer the button when unindexed" UI guard.
 *   2. Otherwise: back up the existing `seen.json` to `seen.json.bak`
 *      (recovery; no-op if `seen.json` doesn't exist yet), then write
 *      `seen.files = <canonicalized current>`, `unknown_baseline = false`,
 *      `ast_sig_version = AST_SIG_VERSION`.
 *   3. Fix round 1: `baseline_sha` is RE-STAMPED via a fresh best-effort
 *      `git rev-parse HEAD` in `project_root` (reusing `seen-seed.ts`'s
 *      `captureGitHeadSha` — same best-effort/null-on-non-git posture as
 *      the initial seed), NOT carried forward from the prior watermark —
 *      `markAllSeen` is a full re-baseline, so a stale SHA from a much
 *      earlier point in the repo's history would be actively misleading.
 */
export async function markAllSeen(
  storageDir: string,
  project_root: string,
  current: Fingerprints,
  origin: SeenWriteOrigin,
): Promise<void> {
  assertHumanOrigin(origin);

  const canonicalCurrent = canonicalizeCurrentFiles(current);
  if (Object.keys(canonicalCurrent).length === 0) {
    return; // C7 fix round 1 — abstain, see doc comment above
  }

  await backupSeenIfPresent(storageDir);

  const files: SeenWatermark["files"] = {};
  for (const [key, fp] of Object.entries(canonicalCurrent)) {
    files[key] = { content_sha256: fp.content_sha256, ast_sig: fp.ast_sig };
  }

  const baseline_sha = await captureGitHeadSha(project_root);

  await writeSeen(storageDir, {
    ast_sig_version: AST_SIG_VERSION,
    baseline_sha,
    files,
    unknown_baseline: false,
  });
}

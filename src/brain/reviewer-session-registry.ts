// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The registry half of a reviewer-session reaper, shared by every host that
 * needs one (agy conversations, qoder sessions).
 *
 * Both reapers rest on the same safety argument: siltpoke deletes ONLY what it
 * recorded itself at call time, never anything it merely found on disk. That
 * argument lives in this file — the record shape, the best-effort read/write,
 * the keep-last-K + min-age selection, and the containment predicate that any
 * delete must pass. What differs per host is where the id COMES FROM and what
 * a session looks like on disk, and that stays in each reaper.
 *
 * Extracted after the two reapers had drifted into near-twins: 55 duplicated
 * lines across four clones, which the public snapshot's duplication gate
 * reported at 2.01% against a 2% threshold. Behaviour is unchanged — each
 * function below is the code that was in both files, moved once.
 *
 * Best-effort throughout: a failure here (missing file, bad permissions,
 * corrupt JSON) is swallowed and never thrown into the review path.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { atomicWrite } from "../utils/atomic-write";

/** One entry in a siltpoke-owned registry — the ONLY safe source of truth for
 * "siltpoke created this session". */
export interface ReviewerSessionRecord {
  id: string;
  recordedAt: number;
}

/**
 * Canonical-UUID gate, anchored on purpose. An UNANCHORED uuid pattern would
 * pass a hostile id like `"../../etc/1234abcd-1234-1234-1234-123456789012"`,
 * which CONTAINS a uuid, and that id would then be used to build a path.
 * Every delete path in a reaper runs through this before it touches the disk.
 */
export const STRICT_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Keep this many most-recent siltpoke-made sessions before reaping the rest.
 * Small on purpose: siltpoke has no need to look back further than a handful
 * of recent reviewer calls. */
export const DEFAULT_KEEP_LAST = 10;

/** Minimum age (ms) before a recorded session is eligible for reaping — a
 * second guardrail on top of unambiguous per-call attribution. 24h: a session
 * just recorded (and, worst case, just misattributed) is essentially never
 * >24h old, so it stays out of the reap set long enough for a human to notice
 * anything wrong. */
export const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Reads a JSON file and returns `undefined` on ANY failure (missing file, bad
 * permissions, malformed JSON) — callers treat `undefined` as "nothing to do",
 * never as an error to propagate. */
export function readJsonBestEffort(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Every well-formed record in the registry; anything else is dropped rather
 * than trusted, since these ids become paths. */
export function readRegistry(registryPath: string): ReviewerSessionRecord[] {
  const parsed = readJsonBestEffort(registryPath);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is ReviewerSessionRecord =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === "string" &&
      typeof (entry as { recordedAt?: unknown }).recordedAt === "number",
  );
}

export function writeRegistryBestEffort(
  registryPath: string,
  records: ReviewerSessionRecord[],
): void {
  try {
    atomicWrite(registryPath, JSON.stringify(records, null, 2));
  } catch {
    // best-effort — a failed registry write never throws into the review path
  }
}

/**
 * Appends `id` unless it is already the newest entry. Every host mints a fresh
 * id per `-p` call, so a back-to-back duplicate is not expected — this guards
 * only against the same call being recorded twice.
 */
export function appendSessionId(
  registryPath: string,
  id: string,
  now: number = Date.now(),
): void {
  const existing = readRegistry(registryPath);
  if (existing.length > 0 && existing[existing.length - 1]?.id === id) return;
  writeRegistryBestEffort(registryPath, [...existing, { id, recordedAt: now }]);
}

/**
 * The entries a reap may delete. An entry qualifies only if it satisfies BOTH:
 *   - it is NOT among the `keepLast` newest (by recordedAt), and
 *   - it is older than `olderThanMs`.
 * Anything failing either test is kept, so a freshly recorded id is never
 * deleted even once the registry grows past `keepLast`.
 */
export function selectReapable(
  registry: ReviewerSessionRecord[],
  opts: { keepLast: number; olderThanMs: number; now: number },
): ReviewerSessionRecord[] {
  if (registry.length <= opts.keepLast) return [];
  // Oldest-first, so the slice drops the oldest and keeps the newest keepLast.
  const sorted = [...registry].sort((a, b) => a.recordedAt - b.recordedAt);
  const beyondKeep = sorted.slice(0, sorted.length - opts.keepLast);
  const ageCutoff = opts.now - opts.olderThanMs;
  return beyondKeep.filter((r) => r.recordedAt < ageCutoff);
}

/**
 * Rewrites the registry to the survivors — but only when something was
 * actually reaped, which avoids needless churn and preserves the original
 * ordering for the untouched majority.
 */
export function dropReapedFromRegistry(
  registryPath: string,
  registry: ReviewerSessionRecord[],
  reaped: ReviewerSessionRecord[],
): void {
  if (reaped.length === 0) return;
  const reapedIds = new Set(reaped.map((r) => r.id));
  writeRegistryBestEffort(
    registryPath,
    registry.filter((r) => !reapedIds.has(r.id)),
  );
}

/**
 * True when `candidate` resolves inside `root` — the containment assertion
 * every delete makes, belt-and-suspenders on top of the UUID gate rather than
 * trusting a well-formed id alone.
 */
export function isWithin(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const r = resolve(candidate);
  return r === rootPath || r.startsWith(rootPath + sep);
}

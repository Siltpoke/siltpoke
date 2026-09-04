// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Best-effort SQLite-conversation reaper for agy (Antigravity CLI) reviewer
 * calls (AgyBrainProvider track, Task 8). agy has no `--ephemeral` mode —
 * every `agy -p` call persists a NEW SQLite conversation DB under
 * `~/.gemini/antigravity-cli/conversations/<uuid>.db` (Task 1 spike,
 * an internal design note §(c): 13 DBs / 14MB after
 * ~10 probe calls — unbounded growth, no agy-side cleanup).
 *
 * SAFETY DESIGN (non-negotiable — this module DELETES files):
 * this reaper deletes ONLY conversation DBs that siltpoke itself created as
 * a reviewer call — NEVER the user's own interactive agy conversations.
 * There is no marker inside the `.db` files themselves (opaque protobuf
 * blobs) or in agy's own caches that would let "siltpoke-made" be told apart
 * from "user-made" after the fact. The safe distinguishing signal is
 * self-tracking at call time — and specifically, UNAMBIGUOUS per-call
 * attribution:
 *
 *   1. `recordAgyConversation()` — called right after every siltpoke
 *      `agy -p` call (success or failure). It reads the conversation id from
 *      the PER-CALL `--log-file` that siltpoke's spawn wrapper passed to agy
 *      (a unique temp path siltpoke generates for THIS subprocess). agy
 *      writes a `... server.go:NNN] Created conversation <uuid>` line into
 *      that log naming exactly the conversation THIS subprocess created
 *      (Task 8 fix-spike, 2026-07-10 — verified live: the per-call log is the
 *      only place carrying our own call's conversation uuid). This id is
 *      appended to a siltpoke-OWNED registry file
 *      (`<homeBase>/agy-reviewer-conversations.json` — under `~/.siltpoke/`,
 *      NOT inside `~/.gemini/`, which is agy's own tree).
 *
 *      WHY NOT the cwd cache (`cache/last_conversations.json[cwd]`): that
 *      cache is keyed ONLY by cwd, not by pid/subprocess. In the core
 *      siltpoke-on-agy scenario the reviewed cwd is the user's own repo root,
 *      and if the user ALSO has an interactive Antigravity session open on
 *      that same repo, a newer conversation the USER creates can overwrite
 *      the cwd entry between our subprocess exiting and our read — so reading
 *      that cache could record the USER's conversation id as if siltpoke made
 *      it, and the (correct) registry-gated reaper would then delete the
 *      user's DB. The per-call log file is private to OUR invocation, so it
 *      is immune to that race. (The original Task-8 impl used the cwd cache;
 *      that was the CRITICAL data-loss hole caught in review, fixed here.)
 *
 *   2. `reapAgyConversations()` — reads ONLY that siltpoke-owned registry,
 *      keeps the last K (default 10) newest entries, applies a MIN-AGE gate
 *      (default 24h — a freshly-recorded id is never reaped, a second
 *      guardrail against a just-misattributed id being deleted before a human
 *      could notice), and deletes `.db` (+ `-shm`/`-wal` sidecars) for the
 *      rest. It NEVER inspects or deletes any `.db` file whose id is absent
 *      from the registry — an id it never recorded is, by construction, not a
 *      conversation siltpoke made, so it is left untouched regardless of
 *      mtime, size, or anything else about the file. This is deliberately NOT
 *      a blind-mtime reaper over the whole conversations dir (that could
 *      delete the user's own active conversation) — if the registry can't be
 *      read or written, the correct behavior is to do nothing (best-effort),
 *      never fall back to a broader sweep.
 *
 * Every fs operation here is individually wrapped so a failure (missing
 * dir, permission error, corrupt registry JSON, etc.) is swallowed and never
 * throws into the review path — the reaper failing must never break a
 * review. See src/brain/providers/agy.ts for the call-site wiring.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { atomicWrite } from "../utils/atomic-write";
import { resolveAntigravityHome, siltpokeRoot } from "../installer/paths";

/** One entry in the siltpoke-owned registry — the ONLY safe source of truth
 * for "siltpoke created this conversation". */
export interface AgyReviewerConversationRecord {
  id: string;
  recordedAt: number;
}

const REGISTRY_FILENAME = "agy-reviewer-conversations.json";

/** Default retention — keep this many most-recent siltpoke-made
 * conversations before reaping the rest. Small on purpose: each DB is at
 * most a few hundred KB-1MB (spike: ~13 DBs / 14MB after ~10 probes) and
 * siltpoke has no need to look back further than a handful of recent
 * reviewer calls. */
const DEFAULT_KEEP_LAST = 10;

/** Default minimum age (ms) before a recorded conversation is eligible for
 * reaping — a second guardrail (belt-and-suspenders on top of unambiguous
 * per-call attribution). 24h: a conversation just-recorded (and, in the
 * worst case, just-misattributed) is essentially never >24h old, so it stays
 * out of the reap set long enough for a human to notice anything wrong. */
const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Matches agy's own log line that names the conversation a given `-p`
 * subprocess created, e.g.
 * `I0710 20:38:15.980076  5949 server.go:861] Created conversation <uuid>`
 * (Task 8 fix-spike). Captures the id token agy names (a uuid in practice;
 * kept liberal — the anchor phrase is the trust signal, so we record whatever
 * conversation id agy declares it created). */
const CREATED_CONVERSATION_RE = /Created conversation\s+(\S+)/;
/** Fallback: any uuid-shaped token, used only if the explicit "Created
 * conversation" anchor is absent (defensive against a log-format change). */
const UUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
/**
 * Anchored (whole-string) version of UUID_RE — used as a containment guard
 * before any path is built from a registry id. UUID_RE alone is NOT safe for
 * this: being unanchored, `UUID_RE.test(id)` would pass a hostile id like
 * `"../../etc/1234abcd-1234-1234-1234-123456789012"` (it CONTAINS a uuid
 * substring), which `extractConversationIdFromLog`'s permissive `\S+` capture
 * could in principle produce from a malformed/hostile log line. Mirrors
 * qoder-reaper's `SESSION_ID_RE` (same anchoring discipline, same bar).
 */
const STRICT_UUID_RE = new RegExp(`^${UUID_RE.source}$`);

function defaultRegistryPath(homeBase?: string): string {
  return join(homeBase ?? siltpokeRoot(), REGISTRY_FILENAME);
}

function defaultConversationsDir(antigravityHome?: string): string {
  return join(antigravityHome ?? resolveAntigravityHome(), "conversations");
}

/** Reads a JSON file and returns `undefined` on ANY failure (missing file,
 * bad permissions, malformed JSON) — callers treat `undefined` as "nothing
 * to do", never as an error to propagate. */
function readJsonBestEffort(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readRegistry(registryPath: string): AgyReviewerConversationRecord[] {
  const parsed = readJsonBestEffort(registryPath);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is AgyReviewerConversationRecord =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === "string" &&
      typeof (entry as { recordedAt?: unknown }).recordedAt === "number",
  );
}

function writeRegistryBestEffort(
  registryPath: string,
  records: AgyReviewerConversationRecord[],
): void {
  try {
    atomicWrite(registryPath, JSON.stringify(records, null, 2));
  } catch {
    // best-effort — a failed registry write never throws into the review path
  }
}

/**
 * Extracts the conversation id agy created for OUR subprocess from the
 * per-call `--log-file` content. Prefers the explicit `Created conversation
 * <uuid>` anchor; falls back to the first uuid-shaped token. Returns
 * `undefined` if neither is present.
 */
export function extractConversationIdFromLog(
  logText: string,
): string | undefined {
  const anchored = logText.match(CREATED_CONVERSATION_RE);
  if (anchored?.[1]) return anchored[1];
  const anyUuid = logText.match(UUID_RE);
  if (anyUuid?.[0]) return anyUuid[0];
  return undefined;
}

/**
 * Reads the conversation id from the PER-CALL `--log-file` that siltpoke's
 * spawn wrapper passed to this `agy -p` invocation, and appends it to
 * siltpoke's own registry. Call this AFTER every `agy -p` invocation siltpoke
 * makes (success or failure). The `logFilePath` MUST be the unique per-call
 * path passed via `--log-file` — because that file is private to OUR
 * subprocess, the id it names is unambiguously the conversation OUR call
 * created (immune to the cwd-cache race that a shared cache would suffer).
 *
 * Best-effort: any failure (log missing/unwritten because agy fell back to
 * default logging, no id in the log, registry unwritable) is swallowed —
 * this never throws.
 */
export function recordAgyConversation(opts?: {
  logFilePath?: string;
  homeBase?: string;
}): void {
  try {
    const logFilePath = opts?.logFilePath;
    if (!logFilePath || !existsSync(logFilePath)) return;
    let logText: string;
    try {
      logText = readFileSync(logFilePath, "utf8");
    } catch {
      return;
    }
    const id = extractConversationIdFromLog(logText);
    if (!id) return;

    const registryPath = defaultRegistryPath(opts?.homeBase);
    const existing = readRegistry(registryPath);
    // Dedupe against the newest entry only: agy assigns a fresh uuid per
    // call (spike: every `-p` call makes a NEW conversation), so back-to-
    // back duplicate ids are not expected in practice — this guards against
    // double-recording the same call if this function is ever invoked twice
    // for it.
    if (existing.length > 0 && existing[existing.length - 1]?.id === id) {
      return;
    }
    const updated = [...existing, { id, recordedAt: Date.now() }];
    writeRegistryBestEffort(registryPath, updated);
  } catch {
    // best-effort — never throws into the review path
  }
}

/**
 * Deletes the `<id>.db` (+ `-shm`/`-wal` sidecars) for one conversation id.
 * Mirrors qoder-reaper's `deleteSessionBestEffort` containment discipline:
 *   1. Reject any id that isn't a canonical UUID (STRICT_UUID_RE) BEFORE it
 *      touches a path — a malformed/hostile registry entry (e.g. containing
 *      `../` or `/`) can never be used to build a path outside
 *      conversationsDir.
 *   2. Belt-and-suspenders: even a passing id is re-`resolve()`d and asserted
 *      to stay within `conversationsDir` before any `rmSync` — explicit
 *      containment rather than trusting the UUID gate alone.
 * Best-effort: every step is individually wrapped so a failure never throws
 * into the review path.
 */
function deleteConversationDbBestEffort(
  conversationsDir: string,
  id: string,
): void {
  if (!STRICT_UUID_RE.test(id)) return;

  const dirRoot = resolve(conversationsDir);
  const withinConversationsDir = (candidate: string): boolean => {
    const r = resolve(candidate);
    return r === dirRoot || r.startsWith(dirRoot + sep);
  };

  for (const suffix of [".db", ".db-shm", ".db-wal"]) {
    try {
      const path = join(conversationsDir, `${id}${suffix}`);
      // Containment assertion — belt-and-suspenders on the UUID gate above.
      if (!withinConversationsDir(path)) continue;
      if (existsSync(path)) {
        rmSync(path, { force: true });
      }
    } catch {
      // best-effort — never throws into the review path
    }
  }
}

/**
 * Prunes siltpoke-made agy conversation DBs beyond a keep-last-K retention,
 * using ONLY the siltpoke-owned registry as the source of truth for which
 * conversation ids are safe to delete. A `.db` file whose id is absent from
 * the registry (i.e. the user's own agy work) is NEVER touched, regardless
 * of its mtime — this function does not even look at file mtimes to decide
 * what to delete, only registry membership + recordedAt ordering + the
 * min-age gate.
 *
 * Reap eligibility (an entry must satisfy ALL of):
 *   - it is NOT among the `keepLast` newest entries (by recordedAt), AND
 *   - it is older than `olderThanMs` (recordedAt < now - olderThanMs).
 * Any entry failing either test is kept (its DB is not deleted, its registry
 * row survives) — so a freshly-recorded id is never deleted even once the
 * registry grows past `keepLast`.
 *
 * Best-effort: every fs operation is individually wrapped so a failure
 * (unreadable dir, permission error, missing file) is swallowed — this
 * function never throws.
 */
export function reapAgyConversations(opts?: {
  conversationsDir?: string;
  registryPath?: string;
  keepLast?: number;
  olderThanMs?: number;
  now?: number;
}): void {
  try {
    const conversationsDir = opts?.conversationsDir ?? defaultConversationsDir();
    const registryPath = opts?.registryPath ?? defaultRegistryPath();
    const keepLast = opts?.keepLast ?? DEFAULT_KEEP_LAST;
    const olderThanMs = opts?.olderThanMs ?? DEFAULT_MIN_AGE_MS;
    const now = opts?.now ?? Date.now();

    const registry = readRegistry(registryPath);
    if (registry.length <= keepLast) return;

    // Oldest-first by recordedAt so the slice below drops the oldest
    // entries and keeps the newest `keepLast`.
    const sorted = [...registry].sort((a, b) => a.recordedAt - b.recordedAt);
    const beyondKeep = sorted.slice(0, sorted.length - keepLast);

    // Second guardrail: within the beyond-keep set, only entries older than
    // the min-age threshold are actually reaped. Younger ones are retained
    // (kept in the registry too) so a just-misattributed id can never be
    // deleted before it ages past the gate.
    const ageCutoff = now - olderThanMs;
    const toReap = beyondKeep.filter((r) => r.recordedAt < ageCutoff);

    for (const record of toReap) {
      deleteConversationDbBestEffort(conversationsDir, record.id);
    }

    const reapedIds = new Set(toReap.map((r) => r.id));
    // Only rewrite if we actually removed something (avoid needless churn +
    // preserve original ordering for the untouched majority). Survivors =
    // everything not reaped: the keepLast-newest, plus any beyond-keep entry
    // still too young to reap.
    if (reapedIds.size > 0) {
      const survivors = registry.filter((r) => !reapedIds.has(r.id));
      writeRegistryBestEffort(registryPath, survivors);
    }
  } catch {
    // best-effort — never throws into the review path
  }
}

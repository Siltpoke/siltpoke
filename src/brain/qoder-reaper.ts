// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Best-effort session reaper for qoder (`qodercli -p`) reviewer calls
 * (CcForkReviewerProvider — a tracked follow-up as of 2026-07-10). Every
 * `qodercli -p` call
 * persists a NEW session under
 * `~/.qoder/projects/<cwd-key>/<session-id>.jsonl` (+ a sibling
 * `<session-id>/` state dir) — keyed per reviewed-repo cwd, with NO observed
 * TTL / auto-prune (spike, an internal design note
 * notes.md Step 4(d): unbounded growth; the only qoder-native deletion path
 * is `qodercli --delete-session <index>`, which is manual AND would spawn yet
 * another session — so this reaper removes the files directly instead).
 *
 * SAFETY DESIGN (non-negotiable — this module DELETES files under the user's
 * ~/.qoder). The sibling agy-reaper had a CRITICAL bug (it learned the
 * conversation id from a shared cwd-keyed cache that a concurrent USER session
 * could overwrite -> it deleted the user's own live conversation). That class
 * of error MUST NOT recur here. The core repo cwd is the user's own repo root,
 * and the user may ALSO be running qoder interactively in that same repo — so
 * the reviewer's sessions sit in the SAME `projects/<cwd-key>/` directory as
 * the user's own qoder work. Deleting by cwd-key alone would delete the user's
 * sessions. The safe distinguishing signal is UNAMBIGUOUS per-call
 * attribution:
 *
 *   1. `recordQoderSession()` — called after every siltpoke `qodercli -p`
 *      call. It reads the `session_id` from THIS call's OWN `-p -o json`
 *      envelope on stdout (spike Step 2: the single result object carries
 *      `"session_id":"<uuid>"`, verified 1:1 against the created session dir).
 *      That id is the return value of OUR subprocess — it is NOT a shared
 *      cache another process can overwrite, so it is immune to the exact race
 *      that bit agy-reaper. The id is appended to a siltpoke-OWNED registry
 *      (`<homeBase>/qoder-reviewer-sessions.json` — under `~/.siltpoke/`, NOT
 *      inside `~/.qoder/`, which is qoder's own tree).
 *
 *   2. `reapQoderSessions()` — reads ONLY that siltpoke-owned registry, keeps
 *      the last K (default 10) newest entries, applies a MIN-AGE gate (default
 *      24h — a freshly-recorded id is never reaped, a second guardrail so a
 *      just-misattributed id can never be deleted before a human could
 *      notice), and deletes the `<id>.jsonl` + `<id>/` state dir for the rest.
 *      It NEVER deletes any session whose id is absent from the registry — an
 *      id it never recorded is, by construction, not a session siltpoke made,
 *      so the user's own qoder sessions are left untouched regardless of
 *      mtime. This is deliberately NOT a blind cwd-key sweep (that could
 *      delete the user's own active session).
 *
 * WHY SCAN INSTEAD OF STORING THE cwd-key: qoder resolves symlinks when it
 * derives its `projects/<cwd-key>/` directory name (e.g. `/tmp` ->
 * `/private/tmp` on macOS), so reproducing that transform from the reviewed
 * cwd is fragile — a mismatched key would just miss (safe: no cleanup) but is
 * unreliable. Instead the reaper LOCATES a registry id by scanning the
 * immediate children of `~/.qoder/projects/` for an EXACT `<id>.jsonl` /
 * `<id>` basename match. Because session ids are globally-unique UUIDs minted
 * per session, an exact-id match can only ever be OUR session — never a user
 * session (which has a different uuid). Every path this module constructs is
 * `join(projectsDir, <child>, <id>[.jsonl])`, so nothing outside
 * `~/.qoder/projects/` is ever touched.
 *
 * Every fs operation here is individually wrapped so a failure (missing dir,
 * permission error, corrupt registry JSON, etc.) is swallowed and never throws
 * into the review path — the reaper failing must never break or slow a review.
 * See src/brain/providers/ccfork-reviewer.ts for the call-site wiring.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { atomicWrite } from "../utils/atomic-write";
import { resolveQoderHome, siltpokeRoot } from "../installer/paths";

/** One entry in the siltpoke-owned registry — the ONLY safe source of truth
 * for "siltpoke created this qoder session". */
export interface QoderReviewerSessionRecord {
  id: string;
  recordedAt: number;
}

const REGISTRY_FILENAME = "qoder-reviewer-sessions.json";

/** Default retention — keep this many most-recent siltpoke-made sessions
 * before reaping the rest. Small on purpose: each session is a few KB
 * (`.jsonl` transcript + a tiny state dir), and siltpoke has no need to look
 * back further than a handful of recent reviewer calls. */
const DEFAULT_KEEP_LAST = 10;

/** Default minimum age (ms) before a recorded session is eligible for reaping
 * — a second guardrail on top of unambiguous per-call attribution. 24h: a
 * session just-recorded (and, worst case, just-misattributed) is essentially
 * never >24h old, so it stays out of the reap set long enough for a human to
 * notice anything wrong. */
const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** UUID shape qoder mints for its session ids — used only as a defensive
 * sanity gate on ids pulled from the registry before any path is built, so a
 * malformed/hostile registry entry can never widen the basename we match. */
const SESSION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function defaultRegistryPath(homeBase?: string): string {
  return join(homeBase ?? siltpokeRoot(), REGISTRY_FILENAME);
}

function defaultProjectsDir(qoderHome?: string): string {
  return join(qoderHome ?? resolveQoderHome(), "projects");
}

/** Reads a JSON file and returns `undefined` on ANY failure (missing file,
 * bad permissions, malformed JSON) — callers treat `undefined` as "nothing to
 * do", never as an error to propagate. */
function readJsonBestEffort(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readRegistry(registryPath: string): QoderReviewerSessionRecord[] {
  const parsed = readJsonBestEffort(registryPath);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is QoderReviewerSessionRecord =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === "string" &&
      typeof (entry as { recordedAt?: unknown }).recordedAt === "number",
  );
}

function writeRegistryBestEffort(
  registryPath: string,
  records: QoderReviewerSessionRecord[],
): void {
  try {
    atomicWrite(registryPath, JSON.stringify(records, null, 2));
  } catch {
    // best-effort — a failed registry write never throws into the review path
  }
}

/**
 * Extracts the `session_id` qoder minted for OUR subprocess from its own
 * `-p --output-format json` envelope on stdout. Handles both real CC-fork
 * shapes defensively: a SINGLE result object (qoder) or an array of events
 * with a terminal `type:"result"` event. Returns `undefined` if stdout is not
 * parseable JSON or carries no `session_id` string (e.g. a bad-flag exit that
 * prints plain ANSI text — spike Step 2(c): nothing to record, which is safe).
 */
export function extractQoderSessionId(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const readId = (obj: unknown): string | undefined => {
    if (typeof obj !== "object" || obj === null) return undefined;
    const sid = (obj as { session_id?: unknown }).session_id;
    return typeof sid === "string" && sid.length > 0 ? sid : undefined;
  };
  if (Array.isArray(parsed)) {
    // codebuddy-shaped array-of-events: the result event is last.
    for (let i = parsed.length - 1; i >= 0; i--) {
      const ev = parsed[i];
      if (
        typeof ev === "object" &&
        ev !== null &&
        (ev as { type?: unknown }).type === "result"
      ) {
        const id = readId(ev);
        if (id) return id;
      }
    }
    return undefined;
  }
  return readId(parsed);
}

/**
 * Reads the `session_id` from THIS `qodercli -p` call's own envelope on stdout
 * and appends it to siltpoke's own registry. Call this AFTER every siltpoke
 * `qodercli -p` invocation (success or failure). Because the id comes from OUR
 * subprocess's own return value — not a shared cache — the id it names is
 * unambiguously the session OUR call created (immune to the cwd-cache race
 * that felled agy-reaper).
 *
 * Best-effort: any failure (unparseable stdout, no `session_id`, registry
 * unwritable) is swallowed — this never throws.
 */
export function recordQoderSession(opts?: {
  stdout?: string;
  homeBase?: string;
}): void {
  try {
    const stdout = opts?.stdout;
    if (!stdout) return;
    const id = extractQoderSessionId(stdout);
    if (!id) return;

    const registryPath = defaultRegistryPath(opts?.homeBase);
    const existing = readRegistry(registryPath);
    // Dedupe against the newest entry only: qoder mints a fresh session id per
    // `-p` call, so back-to-back duplicates aren't expected — this only guards
    // against double-recording the same call.
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
 * Deletes the `<id>.jsonl` transcript + `<id>/` state dir for one session id,
 * locating it by scanning the immediate children of `projectsDir` for an
 * EXACT-basename match. Only ever removes paths under `projectsDir` — a final
 * containment assertion (resolved path must stay within projectsDir) makes the
 * "never touch anything outside ~/.qoder/projects/" invariant explicit rather
 * than relying on the id being well-formed. Best-effort: every step is wrapped.
 */
function deleteSessionBestEffort(projectsDir: string, id: string): void {
  // Defensive: only act on a canonical UUID — a malformed registry id can
  // never be used to build a wider match (e.g. "" or "." or a traversal).
  if (!SESSION_ID_RE.test(id)) return;

  let children: string[];
  try {
    children = readdirSync(projectsDir);
  } catch {
    return; // projects dir missing/unreadable — nothing to do
  }

  const projectsRoot = resolve(projectsDir);
  const withinProjects = (candidate: string): boolean => {
    const r = resolve(candidate);
    return r === projectsRoot || r.startsWith(projectsRoot + sep);
  };

  for (const child of children) {
    for (const target of [
      join(projectsDir, child, `${id}.jsonl`),
      join(projectsDir, child, id),
    ]) {
      try {
        // Containment assertion — belt-and-suspenders on the UUID gate above.
        if (!withinProjects(target)) continue;
        if (existsSync(target)) {
          rmSync(target, { recursive: true, force: true });
        }
      } catch {
        // best-effort — never throws into the review path
      }
    }
  }
}

/**
 * Prunes siltpoke-made qoder sessions beyond a keep-last-K retention, using
 * ONLY the siltpoke-owned registry as the source of truth for which session
 * ids are safe to delete. A session whose id is absent from the registry (the
 * user's own qoder work) is NEVER touched — this function does not decide what
 * to delete from filesystem mtimes, only registry membership + recordedAt
 * ordering + the min-age gate.
 *
 * Reap eligibility (an entry must satisfy ALL of):
 *   - it is NOT among the `keepLast` newest entries (by recordedAt), AND
 *   - it is older than `olderThanMs` (recordedAt < now - olderThanMs).
 * Any entry failing either test is kept (its files survive, its registry row
 * survives) — so a freshly-recorded id is never deleted even once the registry
 * grows past `keepLast`.
 *
 * Best-effort: every fs operation is individually wrapped so a failure
 * (unreadable dir, permission error, missing file) is swallowed — this
 * function never throws.
 */
export function reapQoderSessions(opts?: {
  projectsDir?: string;
  registryPath?: string;
  keepLast?: number;
  olderThanMs?: number;
  now?: number;
}): void {
  try {
    const projectsDir = opts?.projectsDir ?? defaultProjectsDir();
    const registryPath = opts?.registryPath ?? defaultRegistryPath();
    const keepLast = opts?.keepLast ?? DEFAULT_KEEP_LAST;
    const olderThanMs = opts?.olderThanMs ?? DEFAULT_MIN_AGE_MS;
    const now = opts?.now ?? Date.now();

    const registry = readRegistry(registryPath);
    if (registry.length <= keepLast) return;

    // Oldest-first by recordedAt so the slice drops the oldest and keeps the
    // newest `keepLast`.
    const sorted = [...registry].sort((a, b) => a.recordedAt - b.recordedAt);
    const beyondKeep = sorted.slice(0, sorted.length - keepLast);

    // Second guardrail: only beyond-keep entries older than the min-age
    // threshold are actually reaped. Younger ones are retained (kept in the
    // registry too) so a just-misattributed id can never be deleted before it
    // ages past the gate.
    const ageCutoff = now - olderThanMs;
    const toReap = beyondKeep.filter((r) => r.recordedAt < ageCutoff);

    for (const record of toReap) {
      deleteSessionBestEffort(projectsDir, record.id);
    }

    const reapedIds = new Set(toReap.map((r) => r.id));
    // Only rewrite if we actually removed something (avoid churn + preserve
    // ordering for the untouched majority). Survivors = the keepLast-newest,
    // plus any beyond-keep entry still too young to reap.
    if (reapedIds.size > 0) {
      const survivors = registry.filter((r) => !reapedIds.has(r.id));
      writeRegistryBestEffort(registryPath, survivors);
    }
  } catch {
    // best-effort — never throws into the review path
  }
}

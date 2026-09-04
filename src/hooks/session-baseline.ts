// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Session baseline storage — one record per SESSION, not one per cwd.
 *
 * The baseline (`head_sha` at session start) is what lets the acted-on oracle
 * tell "the user fixed the flagged line" from "we have no idea what the code
 * looked like". It used to live in a single `{cwd}/.siltpoke/baseline.json`
 * slot, while the lookup keyed on an EXACT `session_id`. Those two facts are
 * incompatible the moment two sessions share a checkout: the second session's
 * start overwrote the slot, and the first session was blinded permanently —
 * every critique it enqueued got `created_sha: null`, and the oracle abstained
 * `no_baseline_sha` on all of them, so the memory writer never ran.
 *
 * **Scope — read this before citing it as a cause.** This is a STRUCTURAL
 * HAZARD fix, established by reading the code: one slot plus an exact-id read
 * cannot serve two real sessions in one checkout, whatever else is true. It is
 * NOT the explanation for the `no_baseline_sha` abstains observed in this repo
 * up to 2026-07-30. Those were diagnosed separately as siltpoke's OWN nested
 * Brain session rewriting the slot with a throwaway id — fixed by the
 * `SILTPOKE_INTERNAL` recursion guard (`tests/hooks/session-start-recursion-guard.test.ts`),
 * with positive evidence (`brain-calls.jsonl` rows carrying
 * `{"skipped": "recursion_guard"}` ~0.4s before each real Stop row) and a
 * timing argument that `resolveSessionHeadSha` runs before the Brain call. A
 * live store that still reads `0 acted` after that fix is explained by the
 * already-poisoned `baseline.json` the fix cannot retro-heal, not by this
 * hazard. Do not re-derive concurrency as the cause of that reading.
 *
 * The two defects are genuinely distinct: that guard keys on an env var, and two
 * real concurrent sessions are indistinguishable by env var, so it cannot cover
 * this case. Hence per-session keying — while the legacy single slot keeps being
 * written for the readers that go straight to that path
 * (`eval/e2e-canary/drive.ts`) and for sessions already in flight across the
 * upgrade, which have no per-session file yet.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";

export interface SessionBaseline {
  head_sha: string | null;
  session_id: string;
  captured_at: string;
  /**
   * Present only on a baseline taken at the first Stop rather than at
   * SessionStart — see `resolveOrCaptureSessionHeadSha`. A late capture is HEAD
   * partway through the session, not HEAD before it, so anything that reasons
   * about the VALUE (rather than merely its presence) has to be able to tell
   * them apart. Absent, never `false`, so a genuine record stays byte-identical
   * to what earlier versions wrote.
   */
  late_capture?: true;
}

/** A baseline that actually carries a sha — what a caller can act on. */
export interface ResolvedBaseline {
  head_sha: string;
  session_id: string;
  captured_at: string;
  /**
   * Carried through from the record, NOT dropped. A late capture is HEAD partway
   * through the session, so any caller that reads the VALUE — `maybeRecordWhy`
   * diffs against it — has to be able to refuse one. A marker no accessor
   * surfaces is a marker no consumer can honour.
   */
  late_capture?: true;
}

/**
 * How long a per-session baseline is kept. One file per session accumulates
 * forever otherwise; a session that has not been seen in this long cannot still
 * have pending critiques (the queue's own TTL is 2 days / 3 hooks).
 */
export const BASELINE_RETENTION_DAYS = 7;

/**
 * The session id reaches a filesystem path, so it is untrusted input: allow only
 * what a host actually emits (UUIDs and slugs) and nothing that can traverse.
 * A rejected id is not an error — the caller degrades to the legacy slot.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeSessionId(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId);
}

export function stateDirFor(cwd: string): string {
  return join(cwd, ".siltpoke");
}

export function legacyBaselinePath(stateDir: string): string {
  return join(stateDir, "baseline.json");
}

export function sessionBaselineDir(stateDir: string): string {
  return join(stateDir, "baselines");
}

/**
 * Short digest of the EXACT id, appended to the filename. The whitelist above
 * permits mixed case and macOS's default APFS is case-insensitive, so two ids
 * differing only in case would otherwise resolve to ONE physical file and
 * clobber each other — reproducing this module's own bug for that input class,
 * below the level `parseBaselineFile`'s exact-match check can see. The digest
 * differs for any case variant, so the filenames differ even after case
 * folding. (Real host ids are lowercase UUIDs; nothing enforces that, so it is
 * not relied on.)
 */
function idDigest(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
}

/** `null` when the id cannot be used as a filename — caller falls back. */
export function sessionBaselinePath(stateDir: string, sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  return join(sessionBaselineDir(stateDir), `${sessionId}-${idDigest(sessionId)}.json`);
}

/**
 * Write the baseline for this session. Writes BOTH the per-session record (the
 * one the lookup uses) and the legacy single slot (kept for its direct readers
 * and for cross-upgrade continuity). Pruning failures are swallowed — a full
 * baselines directory must never break SessionStart.
 */
export async function writeSessionBaseline(cwd: string, baseline: SessionBaseline): Promise<void> {
  const stateDir = stateDirFor(cwd);
  await mkdir(stateDir, { recursive: true });
  const payload = JSON.stringify(baseline, null, 2);

  // tmp+rename, not a bare write: the LEGACY slot is shared by every session in
  // this cwd, so a plain open-truncate-write leaves a window where a concurrent
  // reader parses a half-written file, degrades to null, and lands the very
  // `no_baseline_sha` abstain this module exists to prevent — via a race instead
  // of a guaranteed collision. `atomicWrite` also mkdir -p's, so the
  // per-session directory needs no separate creation.
  atomicWrite(legacyBaselinePath(stateDir), payload);

  const perSession = sessionBaselinePath(stateDir, baseline.session_id);
  if (perSession === null) return; // unusable id → legacy slot only, never throw
  atomicWrite(perSession, payload);
  await pruneSessionBaselines(stateDir).catch(() => 0);
}

/** Drop per-session baselines older than the retention window. Returns the count removed. */
export async function pruneSessionBaselines(stateDir: string, now: Date = new Date()): Promise<number> {
  const dir = sessionBaselineDir(stateDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0; // no directory yet — nothing to prune
  }
  const cutoff = now.getTime() - BASELINE_RETENTION_DAYS * 86_400_000;
  let removed = 0;
  for (const name of names) {
    // `atomicWrite`'s temp files are `.tmp-<basename>-<pid>-<ts>` — they do NOT
    // end in `.json`, so a `.json`-only sweep would let orphans from an
    // interrupted write accumulate forever. Past the retention window a temp
    // file is certainly abandoned, so it is swept on the same terms.
    if (!name.endsWith(".json") && !name.startsWith(".tmp-")) continue;
    const file = join(dir, name);
    try {
      if ((await stat(file)).mtimeMs < cutoff) {
        await rm(file, { force: true });
        removed++;
      }
    } catch {
      // unreadable entry — leave it alone rather than guessing
    }
  }
  return removed;
}

/**
 * Resolve this session's baseline: the per-session record first, then the legacy
 * slot. Both are matched on an exact `session_id` — the per-session file is
 * checked too, so a stale or hand-edited file cannot hand back someone else's
 * baseline. Returns `null` rather than throwing on anything unexpected; this
 * runs inside hooks that must never break.
 */
export function readSessionBaseline(cwd: string, sessionId: string): ResolvedBaseline | null {
  const stateDir = stateDirFor(cwd);
  const perSession = sessionBaselinePath(stateDir, sessionId);
  if (perSession !== null) {
    const hit = parseBaselineFile(perSession, sessionId);
    if (hit !== null) return hit;
  }
  return parseBaselineFile(legacyBaselinePath(stateDir), sessionId);
}

function parseBaselineFile(file: string, sessionId: string): ResolvedBaseline | null {
  if (!existsSync(file)) return null;
  try {
    const persisted = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof persisted.head_sha !== "string") return null; // null sha (non-git cwd) is not resolvable
    if (typeof persisted.captured_at !== "string") return null;
    if (persisted.session_id !== sessionId) return null;
    const resolved: ResolvedBaseline = {
      head_sha: persisted.head_sha,
      session_id: sessionId,
      captured_at: persisted.captured_at,
    };
    // Only the literal `true` promotes; a hand-edited `"yes"` must not read as a
    // late capture, and must not read as a genuine baseline either — it is the
    // former by the only evidence available, so treat any present value as set.
    if (persisted.late_capture !== undefined) resolved.late_capture = true;
    return resolved;
  } catch {
    return null; // corrupt file — degrade, never crash the hook
  }
}


/**
 * Resolve this session's baseline for `cwd`, capturing one if it is missing.
 *
 * WHY THIS EXISTS. `readSessionBaseline` is a pure read, and it comes back empty
 * whenever SessionStart ran against a DIFFERENT directory than the one the Stop
 * hook ends up reviewing. Every critique from such a session is then enqueued
 * with `created_sha: null`, which short-circuits the acted-on oracle to
 * `no_baseline_sha` on every sweep until the TTL drops it — the memory loop is
 * dead for that whole session, silently.
 *
 * WHAT WAS MEASURED (2026-09-01, siltpoke), and nothing beyond it. Session
 * `05fffe58-9e6a-413b-b962-54221fd361f1`:
 *   - SessionStart's `input.cwd` was `~/Projects/ai-agents/siltpoke` — the
 *     multi-repo parent, which holds four repos and is itself NOT a git repo.
 *     Evidence: that is where the per-session record landed, and it carries
 *     `head_sha: null` because `git rev-parse HEAD` fails there. Three more
 *     null-sha records sit beside it.
 *   - The Stop hook's `event.cwd` was `~/Projects/.../siltpoke`. Evidence:
 *     critique `c-26d3` records that cwd and its file was written under that
 *     repo's `.siltpoke/`.
 *   - All three adjudications of `c-26d3` abstained `no_baseline_sha`, then
 *     `ttl_drop`.
 *
 * WHAT IS NOT ESTABLISHED: WHY the two cwds differ. It is NOT `resolveHostCwd`
 * re-anchoring — that returns `payloadCwd` untouched for every host but
 * antigravity (`resolve-host-cwd.ts:59`), and this session was Claude Code. The
 * divergence was supplied by the host payload; which mechanism produced it is
 * unknown, and is deliberately not guessed at here. This function does not
 * depend on the answer — capture-if-missing is agnostic about why the read came
 * back empty — but the register entry it corrects was itself a claim written
 * without a mechanism, so inventing one here would repeat the defect.
 *
 * WHY THE FIX IS NOT IN SessionStart. This argument stands on the measured
 * facts alone and needs no mechanism for the divergence: SessionStart was handed
 * a directory holding four repos, and nothing at that moment says which one the
 * session will touch — so there is no correct directory to baseline, whatever
 * later hands Stop a different one. The first Stop is the earliest point the
 * repo under review is known. This is the only place the capture can happen, not
 * a shortcut past a tidier one.
 *
 * WHAT IT COSTS, stated rather than implied: a late capture is HEAD at the first
 * Stop, which is later than HEAD before the session — if the session already
 * committed, the two differ. It is therefore marked `late_capture` and it is
 * PERSISTED, so every later Stop in the same session reuses it instead of
 * tracking HEAD. A real SessionStart baseline is always preferred and never
 * overwritten.
 *
 * Returns `null` when `cwd` is not a git repo — the honest answer, and the
 * pre-existing behaviour for that case.
 */
export function resolveOrCaptureSessionHeadSha(cwd: string, sessionId: string): string | null {
  const existing = readSessionBaseline(cwd, sessionId);
  if (existing !== null) return existing.head_sha;

  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return null;
  const head_sha = r.stdout.trim();
  if (head_sha === "") return null;

  // Say it out loud, BEFORE any early return. The failure this replaces was
  // invisible for a month: it surfaced only as an abstain reason in a log nobody
  // reads, one sweep later. The unsafe-id branch below is the case that repeats
  // on every Stop forever, so it is the case that most needs to be audible.
  console.error(`[siltpoke] no usable session-start baseline for this cwd — captured HEAD at Stop instead (${cwd})`);

  const perSession = sessionBaselinePath(stateDirFor(cwd), sessionId);
  // An id that cannot be a filename still gets a usable sha this turn; it just
  // cannot be pinned, so the next Stop captures again. Better than abstaining.
  if (perSession === null) return head_sha;

  // The per-session record ONLY — never the legacy single slot. That slot is
  // shared by every session in this cwd, and a late capture writing it would
  // reintroduce exactly the cross-session clobbering that per-session keying
  // exists to prevent (see this module's header).
  try {
    atomicWrite(
      perSession,
      JSON.stringify(
        {
          head_sha,
          session_id: sessionId,
          captured_at: new Date().toISOString(),
          late_capture: true,
        } satisfies SessionBaseline,
        null,
        2,
      ),
    );
    // Prune here too. `pruneSessionBaselines` has no other caller than
    // `writeSessionBaseline`, and in the very shape this function exists for the
    // child repo's `baselines/` dir is written ONLY here — so without this call
    // its retention window never runs and one record per session accumulates
    // forever, against this module's own stated design.
    void pruneSessionBaselines(stateDirFor(cwd)).catch(() => 0);
  } catch {
    // Unwritable state dir — the sha this turn is still correct and still beats
    // a `no_baseline_sha` abstain; persistence is the optimisation, not the fix.
  }
  return head_sha;
}

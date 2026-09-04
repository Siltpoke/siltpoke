// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { join } from "node:path";
import {
  readPending, writePending, pendingQueuePath,
  TTL_HOOKS, TTL_DAYS, type PendingCritique,
} from "./pending-queue";
import { adjudicate, type Adjudication, type Verdict } from "./acted-on-oracle";
import { writePositiveRule } from "./positive-writer";
import {
  adjudicationLogPath,
  appendAdjudication,
  type AdjudicationRecord,
  type WriteOutcome,
} from "./adjudication-log";
import { acquireLock, releaseLock, LockHeldError } from "../utils/process-lock";
import {
  finalizeCase1,
  gcCase1Candidates,
  sanitizeTargetPath,
  type FinalizeArgs,
  type FinalizeDeps,
  type GcOpts,
} from "./case1-capture";
import { nodeFinalizeDeps, nodeGcDeps } from "./case1-capture-node-deps";
import { loadCase1CaptureConfig, type Case1CaptureConfig } from "../config/case1-capture-config";

export const MAX_DISTIL_ATTEMPTS = 2;
const DAY_MS = 86_400_000;
const LOCK_VERSION = "distil-1";
const HEARTBEAT_MS = 5_000;
/**
 * Age cutoff for orphan `.pre.json` pre-candidate GC (Task 10, spec §8). The
 * pending queue's own TTL (`TTL_DAYS` in pending-queue.ts) is 2 days — an
 * orphan can only exist once its critique has left the queue (TTL-dropped or
 * terminally adjudicated), so 3 days gives a 1-day buffer past that TTL before
 * we call the code snapshot dead. Generous enough that a delayed/retried
 * finalize never races the GC; short enough that abandoned candidates (which
 * hold the user's flagged code, per §8) don't linger.
 */
const CASE1_GC_MAX_AGE_MS = 3 * DAY_MS;

export interface SweepDeps {
  oracleFn?: (entry: PendingCritique, cwd: string) => Promise<Verdict>;
  /**
   * `rule_text`/`rule_category` are what let Phase 2 FREEZE the rule's content
   * in `provenance-private.json` instead of storing an id-only pointer into a
   * `memory.json` that churns. Optional so a legacy injected writer still
   * typechecks — capture then falls back to empty strings rather than skipping.
   */
  writeFn?: (
    homeBase: string,
    entry: PendingCritique,
  ) => Promise<{ written: WriteOutcome; rule_id?: string; rule_text?: string; rule_category?: string }>;
  now?: () => Date;
  queuePath?: string;
  /** Test seam for the adjudication log (eval design §2.2). */
  appendAdjudicationFn?: (path: string, record: AdjudicationRecord) => Promise<void>;
  /**
   * Forward-capture Phase 2 (spec §4.2/§6) — called ONLY when an `acted`
   * verdict's writer resolves with `written: "appended"` (the sole outcome
   * that yields a NEW rule naming THIS critique; `bumped`/`dup`/`garbage`
   * never finalize). Defaults to the real `finalizeCase1` + `nodeFinalizeDeps`
   * wiring, which self-gates on `capture_case1`/`SILTPOKE_CAPTURE_CASE1`. A
   * test override receives the exact args `finalizeCase1` would.
   */
  finalizeFn?: (
    args: FinalizeArgs,
    config: Case1CaptureConfig | null | undefined,
    env: NodeJS.ProcessEnv | undefined,
    deps: FinalizeDeps,
  ) => Promise<"finalized" | "skipped">;
  /**
   * Task 10 (spec §8) — opportunistic orphan-GC of `.pre.json` pre-candidates,
   * called once per sweep after `writePending`. Housekeeping, never a gate:
   * guarded in its own try/catch so a GC failure can never affect the sweep's
   * returned counts. Defaults to the real `gcCase1Candidates` + `nodeGcDeps`
   * wiring; a test override receives the same `(stateBase, opts)` the default
   * would, without needing to fake real fs deps.
   */
  gcFn?: (stateBase: string, opts: GcOpts) => Promise<number>;
}

/**
 * Per-entry adjudication loop (NO lock). Ported from the former `sweepPending`
 * body + a `distil_attempts` retry budget. The LLM distil (`writeFn`) is called
 * here, which is safe because the caller runs this inside the detached worker,
 * not inside a Stop hook — so a slow `claude -p` is awaited to completion.
 */
export async function sweepEntriesOnce(
  homeBase: string, stateBase: string, cwd: string, deps: SweepDeps = {},
): Promise<{ written: number; expired: number; pending: number }> {
  const queuePath = deps.queuePath ?? pendingQueuePath(stateBase);
  const writeFn = deps.writeFn ?? ((h, e) => writePositiveRule(h, e));
  const now = deps.now ?? (() => new Date());
  const logPath = adjudicationLogPath(stateBase);
  const appendFn = deps.appendAdjudicationFn ?? appendAdjudication;
  const finalizeFn = deps.finalizeFn ?? finalizeCase1;
  const gcFn = deps.gcFn ?? ((sb: string, opts: GcOpts) => gcCase1Candidates(sb, opts, nodeGcDeps));
  // Loaded ONCE per sweep (not per entry) — read-only, cheap, and lets the
  // real `finalizeCase1` gate (capture_case1 + SILTPOKE_CAPTURE_CASE1) fire
  // for whichever entries actually reach the acted+appended branch below.
  const case1Config = await loadCase1CaptureConfig(homeBase);
  // A caller-supplied oracleFn returns the bare verdict (the historical seam);
  // the real oracle returns the reason and tier too. Normalize to the rich
  // shape so the log never has to invent a reason it wasn't told.
  const adjudicateFn: (e: PendingCritique, c: string) => Promise<Adjudication> =
    deps.oracleFn
      ? async (e, c) => ({ verdict: await deps.oracleFn!(e, c) })
      : (e, c) => adjudicate(e, c);

  const entries = await readPending(queuePath);
  const survivors: PendingCritique[] = [];
  let written = 0, expired = 0;

  for (const entry of entries) {
    const bumped = { ...entry, hooks_elapsed: entry.hooks_elapsed + 1 };
    const adjudicatedAt = now();
    let judged: Adjudication;
    try {
      judged = await adjudicateFn(bumped, cwd);
    } catch {
      judged = { verdict: "abstain", abstain_reason: "threw" };
    }
    // One line per adjudication (eval design §2.2). `write_outcome` is filled in
    // by whichever branch below actually resolves this entry, so a TTL drop and
    // a writer failure — both previously silent — each leave a trace.
    const record: AdjudicationRecord = {
      critique_id: bumped.critique_id,
      enqueued_at: entry.created_at,
      adjudicated_at: adjudicatedAt.toISOString(),
      verdict: judged.verdict,
      verdict_tier: judged.verdict_tier,
      abstain_reason: judged.abstain_reason,
      latency_ms: adjudicatedAt.getTime() - new Date(entry.created_at).getTime(),
    };
    // Guarded here as well as inside the default appender: the seam accepts an
    // arbitrary function, and telemetry must never be able to take the memory
    // loop down no matter who supplies the writer.
    const log = async (outcome?: WriteOutcome): Promise<void> => {
      try {
        await appendFn(logPath, outcome ? { ...record, write_outcome: outcome } : record);
      } catch {
        // Telemetry failures are never fatal.
      }
    };

    if (judged.verdict === "acted") {
      const attempts = (entry.distil_attempts ?? 0) + 1;
      try {
        const res = await writeFn(homeBase, bumped);
        if (res && (res.written === "appended" || res.written === "bumped")) written++;
        await log(res?.written);

        // Phase 2 (spec §4.2/§6) — runs AFTER the writer resolves and AFTER
        // the written/log accounting above, in its OWN try/catch so a
        // finalize failure can never be miscounted as `write_failed` (which
        // would trigger a spurious distil retry) nor affect the drop below.
        // Only `appended` is a clean 1:1 case1->rule (bumped/dup/garbage
        // name a DIFFERENT rule or none at all — spec §6).
        if (res && res.written === "appended" && bumped.capture_id && res.rule_id) {
          const anchor = bumped.anchors[0];
          // `anchor.file` is critic-produced evidence (schema `min(1)` only,
          // no absolute/traversal guarantee) — sanitize before it can reach
          // the public case1 record, same boundary Phase 1 enforces on the
          // same field. A rejected/missing anchor skips finalize rather than
          // ever passing an unsafe path through.
          const verifiedFile = anchor ? sanitizeTargetPath(cwd, anchor.file) : null;
          if (anchor && verifiedFile !== null) {
            try {
              const finalizeArgs: FinalizeArgs = {
                capture_id: bumped.capture_id,
                cwd,
                stateBase,
                // Freeze the rule's CONTENT, not just its id — `rule_id` alone
                // is only resolvable against a memory.json that may churn.
                // Empty-string fallback keeps a legacy writer's capture alive
                // (a thinner record beats no record at all).
                rule: { id: res.rule_id, text: res.rule_text ?? "", category: res.rule_category ?? "" },
                // Carry WHICH line the oracle adjudicated (anchors[0]) — its
                // fingerprint is the key into the public record's
                // `before.files[].anchor_fingerprints`.
                verified_anchor: {
                  file: verifiedFile,
                  ...(typeof anchor.line === "number" ? { line: anchor.line } : {}),
                  ...(anchor.fingerprint ? { fingerprint: anchor.fingerprint } : {}),
                  verdict_tier: judged.verdict_tier,
                },
              };
              await finalizeFn(finalizeArgs, case1Config, process.env, nodeFinalizeDeps);
            } catch {
              // Fail-soft (spec §4.2): a finalize throw must never affect the
              // sweep's written/log/drop accounting above, which already ran.
            }
          }
        }

        continue; // adjudicated (success/garbage/dup) -> drop
      } catch {
        await log("write_failed");
        if (attempts >= MAX_DISTIL_ATTEMPTS) continue; // budget exhausted -> abstain-drop
        survivors.push({ ...bumped, distil_attempts: attempts }); // retry next worker
        continue;
      }
    }
    const ageMs = adjudicatedAt.getTime() - new Date(entry.created_at).getTime();
    if (bumped.hooks_elapsed >= TTL_HOOKS || ageMs >= TTL_DAYS * DAY_MS) {
      expired++;
      await log("ttl_drop");
      continue; // TTL -> drop, write nothing
    }
    await log();
    survivors.push(bumped); // not_yet / abstain -> keep
  }

  await writePending(queuePath, survivors);

  // Task 10 (spec §8) — opportunistic orphan GC of `.pre.json` pre-candidates.
  // `survivors` are exactly the critiques still pending (kept in the queue
  // above) — their pre-candidate must never be deleted, no matter how old.
  // Guarded in its own try/catch: GC is housekeeping, never a gate, and must
  // never affect the counts already computed above.
  try {
    const livePendingIds = new Set(survivors.flatMap((s) => (s.capture_id ? [s.capture_id] : [])));
    await gcFn(stateBase, { now: now(), maxAgeMs: CASE1_GC_MAX_AGE_MS, livePendingIds });
  } catch {
    // fail-soft: a GC failure must never break the sweep or change its return
  }

  return { written, expired, pending: survivors.length };
}

/**
 * Single-flight wrapper: acquire the GLOBAL distil-worker lock (so workers
 * launched for different projects still serialize their writes to the global
 * memory.json), run one sweep, release. If the lock is already held, no-op.
 */
export async function runDistilWorker(
  homeBase: string, stateBase: string, cwd: string,
  deps: SweepDeps & { lockPath?: string } = {},
): Promise<{ written: number; expired: number; pending: number } | { skipped: "locked" }> {
  const lockPath = deps.lockPath ?? join(homeBase, "distil-worker.lock");
  let handle;
  try {
    handle = acquireLock(lockPath, { version: LOCK_VERSION, heartbeatMs: HEARTBEAT_MS });
  } catch (e) {
    if (e instanceof LockHeldError) return { skipped: "locked" };
    throw e;
  }
  try {
    return await sweepEntriesOnce(homeBase, stateBase, cwd, deps);
  } finally {
    releaseLock(handle);
  }
}

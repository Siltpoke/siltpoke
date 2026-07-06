// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Long-task background registry — the substrate that stops invisible
 * subprocess burn (stopgap).
 *
 * generate/explain run a `claude -p` subprocess for 1–60 min. Before this, they
 * ran synchronously inside the HTTP handler → navigate away orphaned the
 * subprocess (burning the user's Claude subscription) with ZERO siltpoke record
 * (cost was logged only on completion → an orphan never completes → invisible).
 *
 * This registry is the shared substrate for the fix:
 *  - an in-memory `Map` of serializable {@link TaskRecord}s, write-through to
 *    `~/.siltpoke/tasks.json` (atomic tmp+rename) so a run is visible on disk;
 *  - a NON-persisted side-map of live handles (the `Bun.Subprocess` + its
 *    `AbortController`) — handles can't serialize;
 *  - a one-task-at-a-time lock (mirrors the `/index` `activeIndexHash`);
 *  - TWO-PHASE writes: a `running` record the MOMENT a task starts (the
 *    invisible-burn fix — a later-killed run is still visible), updated to
 *    done/failed/cancelled on exit.
 *
 * Design choice: in-memory Map + JSON write-through, NOT
 * BullMQ/SQLite (overkill for one concurrent task on a single-user localhost
 * daemon). Daemon restart → a `running` record whose pid is dead is `crashed`
 * on reconcile; no orphan re-adoption.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ARCH_DEFAULT_MODEL } from "../explain/arch-generate";
import { atomicWrite } from "../utils/atomic-write";
import { classifyResultFile as _classifyResultFile } from "./result-classifier";

// Re-export for consumers that imported these from task-registry (test + external callers).
export { classifyResultFile, RESULT_FILE_FRESH_MS } from "./result-classifier";
export type { ClassifyOpts, ResultClassification } from "./result-classifier";

export type TaskKind = "arch_generate" | "explain";
export type TaskStatus = "running" | "done" | "failed" | "cancelled" | "crashed";
/** How a recorded cost was derived — the same honesty marker the usage ledger
 * carries (`real` exact usage / `tail_parsed` salvaged from a truncated tail /
 * `estimated` pre-flight contingency / `derived` recomputed from tokens). */
export type CostBasis = "real" | "tail_parsed" | "estimated" | "derived";

/** Serializable, persisted to tasks.json. NO process handles here. */
export interface TaskRecord {
  id: string;
  kind: TaskKind;
  repo: string;
  status: TaskStatus;
  startedTs: string;
  endedTs?: string;
  pid?: number;
  /** Process start timestamp (`ps -o lstart`) captured alongside `pid`.
   * pid alone is reusable by the OS; pid+lstart together near-uniquely
   * identifies the child, defeating pid-reuse misidentification at reconcile. */
  lstart?: string;
  /** Filled on completion; null when a SIGKILL'd run emitted no usage (honest:
   * never a fabricated number — the registry still records it ran). */
  costUsd?: number | null;
  /** How `costUsd` was derived (idempotent ledger). Set alongside a numeric
   * cost via recordCost(); absent when no cost was ever recorded. */
  basis?: CostBasis;
  errorMsg?: string;
}

/** A killable subprocess handle (the subset of `Bun.Subprocess` the registry needs). */
export interface KillableProc {
  readonly pid?: number;
  kill(signal?: number | string): void;
}

interface LiveHandle {
  controller: AbortController;
  proc?: KillableProc;
  /** Wall-clock guard: fires `timeoutKill` if the run outlives the ceiling.
   * Cleared by complete() on every terminal so a finished run never flips later. */
  timer?: ReturnType<typeof setTimeout>;
  /** This run's child was spawned DETACHED (it has a per-task result file).
   * Daemon stop() spares it — it survives the daemon to finish + write its file.
   * Set by the daemon caller when it passes a resultFilePath to the provider. */
  detached?: boolean;
}

/**
 * Default wall-clock ceiling: 15 min. Evidence: the only real
 * arch-generate measurement is ~196s (small repo, `server.ts:268`); input is
 * budget-sharded at 160k tokens (`arch-context.ts:24`) so a giant repo is the SAME
 * bounded call, not a longer one → genuine work can't approach 30 min. 15 min is
 * ~1.5–3× the pessimistic real-max and kills the 57-min-class hang (wedged
 * subprocess that never returns → cost-cap never fires) ~42 min sooner.
 */
export const ARCH_TIMEOUT_DEFAULT_MS = 900_000;

/**
 * Resolve the wall-clock ceiling from `SILTPOKE_ARCH_TIMEOUT_MS` (one env covers
 * both arch_generate + explain — explain is Haiku/seconds, never approaches it).
 * Invalid / non-positive → the default (the guard is a runaway-killer, not a
 * foot-gun; a bad env must not silently disable it). Giant-repo users raise it.
 */
export function resolveArchTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SILTPOKE_ARCH_TIMEOUT_MS;
  if (raw === undefined) return ARCH_TIMEOUT_DEFAULT_MS;
  // Number() not parseInt(): parseInt("1.5e6") truncates to 1 (→ a 1ms ceiling
  // that kills every run silently); Number("1.5e6") === 1_500_000 and Number is
  // stricter on trailing junk ("30abc" → NaN → default, not a wrong number).
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : ARCH_TIMEOUT_DEFAULT_MS;
}

export interface TaskRegistryOpts {
  /** Injected for deterministic tests (default ISO-now). */
  now?: () => string;
  /** Injected for deterministic ids in tests. */
  idGen?: () => string;
  /** SIGKILL escalation delay after SIGTERM (ms). */
  killEscalationMs?: number;
  /** Liveness probe (default `process.kill(pid, 0)` → false on ESRCH). Injected for tests. */
  isAlive?: (pid: number) => boolean;
  /** Process start-time probe (default `ps -o lstart= -p <pid>`; undefined on
   * failure / dead pid). Paired with `isAlive` to defeat pid reuse.
   * Injected for deterministic tests. */
  lstartOf?: (pid: number) => string | undefined;
  /** Poll interval (ms) for the finalize watcher on adopted runs (Bug B).
   * Default 1000ms. Injected for deterministic tests. */
  pollMs?: number;
  /** Injected result-file classifier for tests that need to exercise the
   * finalize-watcher error path without a real file system. Default: classifyResultFile. */
  classifyFn?: (path: string) => import("./result-classifier").ResultClassification;
}

/**
 * Read a process's start timestamp via BSD `ps -o lstart=` (present on macOS +
 * Linux). Returns the trimmed line (an opaque, stable string we only compare for
 * EQUALITY — its format is irrelevant) or undefined when the pid is dead / ps
 * is unavailable. Synchronous: called only at startup reconcile over a handful
 * of prior `running` records, never on a hot path.
 */
function defaultLstartOf(pid: number): string | undefined {
  try {
    const out = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
    if (!out.success) return undefined;
    const s = out.stdout.toString().trim();
    return s.length > 0 ? s : undefined;
  } catch {
    return undefined;
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH (or EPERM, treated as gone for our single-user case)
  }
}

export class TaskRegistry {
  private readonly records = new Map<string, TaskRecord>();
  private readonly live = new Map<string, LiveHandle>();
  private activeId: string | null = null;
  private readonly path: string;
  private readonly now: () => string;
  private readonly idGen: () => string;
  private readonly killEscalationMs: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly lstartOf: (pid: number) => string | undefined;
  /** Poll interval (ms) for the finalize watcher on adopted runs (Bug B). */
  private readonly pollMs: number;
  /** Result-file classifier (injected for tests, defaults to classifyResultFile). */
  private readonly classifyFn: (path: string) => import("./result-classifier").ResultClassification;
  /** Active finalize-watcher timers keyed by task id. */
  private readonly watchers = new Map<string, ReturnType<typeof setInterval>>();

  private readonly tasksDir: string;

  constructor(homeBase: string, opts: TaskRegistryOpts = {}) {
    this.path = join(homeBase, "tasks.json");
    this.tasksDir = join(homeBase, "tasks");
    this.now = opts.now ?? (() => new Date().toISOString());
    this.idGen = opts.idGen ?? (() => crypto.randomUUID());
    this.killEscalationMs = opts.killEscalationMs ?? 5000;
    this.isAlive = opts.isAlive ?? defaultIsAlive;
    this.lstartOf = opts.lstartOf ?? defaultLstartOf;
    this.pollMs = opts.pollMs ?? 1000;
    this.classifyFn = opts.classifyFn ?? ((path) => _classifyResultFile(path, { model: ARCH_DEFAULT_MODEL }));
    this.load();
  }

  /** True when a task is currently running (the one-at-a-time lock is held). */
  isBusy(): boolean {
    return this.activeId !== null;
  }

  activeTaskId(): string | null {
    return this.activeId;
  }

  /**
   * Two-phase phase 1: write the `running` + `started` record immediately and
   * acquire the lock. Returns null if a task is already running (caller → 409).
   * `live` carries the AbortController (+ proc handle once spawned) for cancel.
   */
  register(
    kind: TaskKind,
    repo: string,
    live: LiveHandle,
    opts: { timeoutMs?: number } = {},
  ): TaskRecord | null {
    if (this.activeId !== null) return null; // one-at-a-time lock
    const rec: TaskRecord = {
      id: this.idGen(),
      kind,
      repo,
      status: "running",
      startedTs: this.now(),
      pid: live.proc?.pid,
      lstart: live.proc?.pid !== undefined ? this.lstartOf(live.proc.pid) : undefined,
    };
    this.records.set(rec.id, rec);
    this.live.set(rec.id, live);
    this.activeId = rec.id;
    // Wall-clock guard: with no timeoutMs the behavior is unchanged (CLI /
    // no-ceiling callers). Cleared by complete() on every terminal.
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      const t = setTimeout(() => this.timeoutKill(rec.id), opts.timeoutMs);
      (t as { unref?: () => void }).unref?.();
      live.timer = t;
    }
    this.persist();
    return rec;
  }

  /**
   * Attach the proc handle + pid after the subprocess spawns. If the task was
   * ALREADY cancelled in the window between register() and the spawn (e.g. the
   * client disconnected during context assembly, before the Brain call), the
   * subprocess that just spawned would otherwise escape the SIGKILL escalation
   * (cancel() ran with no proc) — so kill it now. Closes the spawn-after-cancel
   * stopgap hole.
   */
  attachProc(id: string, proc: KillableProc): void {
    const lh = this.live.get(id);
    const rec = this.records.get(id);
    if (lh) lh.proc = proc;
    if (rec && proc.pid !== undefined) {
      rec.pid = proc.pid;
      // Capture the fingerprint NOW that the real subprocess pid exists (register
      // may have run before spawn → no pid → no lstart). Defeats pid reuse at the
      // next daemon restart's reconcile.
      rec.lstart = this.lstartOf(proc.pid);
      this.persist();
    }
    // Cancelled before the proc existed → the live handle was already removed
    // by complete(); kill the late subprocess immediately + escalate.
    if (!lh && (rec === undefined || rec.status !== "running")) {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* gone */
      }
      const pid = proc.pid;
      if (pid !== undefined) {
        const t = setTimeout(() => {
          if (this.isAlive(pid)) {
            try {
              proc.kill("SIGKILL");
            } catch {
              /* gone */
            }
          }
        }, this.killEscalationMs);
        (t as { unref?: () => void }).unref?.();
      }
    }
  }

  /** Two-phase phase 2: success (or a paid-but-rejected outcome like malformed /
   * integrity_failed / cost_cap_exceeded — cost is still recorded, errorMsg
   * carries the parse/integrity/cap reason for diagnosability). */
  finish(id: string, patch: { costUsd?: number | null; errorMsg?: string } = {}): void {
    this.complete(id, "done", { costUsd: patch.costUsd ?? null, errorMsg: patch.errorMsg });
  }

  /** Two-phase phase 2: failure (error, not cancel). */
  fail(id: string, errorMsg: string): void {
    this.complete(id, "failed", { errorMsg });
  }

  /**
   * Cancel: trigger the AbortController (→ Bun.spawn SIGTERM), then escalate to
   * SIGKILL after `killEscalationMs` if the pid is still alive. Records
   * `cancelled` immediately (the run is over from the user's view). The pid
   * actually dying is verified by a liveness probe.
   */
  cancel(id: string): void {
    this.killLive(id, "cancelled");
  }

  /**
   * Daemon-stop path — the INVERSE of cancel(). On daemon shutdown a detached
   * in-flight child must NOT be SIGTERM/SIGKILL'd: it survives the daemon to
   * finish the paid run + write its result file (reconcile/scavenger recover it
   * on the next start). So stop() does NOT abort the controller and does NOT kill
   * the proc — it only CLEARS the wall-clock timeout timers (a fired timeoutKill
   * during/after shutdown would needlessly kill the very child we mean to spare)
   * and leaves the `running` records as-is (they are genuinely still running).
   *
   * A non-detached child can't truly outlive the daemon, but stop() still doesn't
   * kill it here — the daemon's own SIGTERM teardown (server.ts) ends the process;
   * killing in-flight work is the explicit user-cancel path, never daemon stop.
   *
   * Returns the ids of the detached runs left in flight (for logging / tests).
   */
  stop(): string[] {
    const spared: string[] = [];
    for (const [id, lh] of this.live) {
      if (lh.timer) clearTimeout(lh.timer);
      if (lh.detached) spared.push(id);
    }
    return spared;
  }

  /**
   * Bug B — finalize watcher for an adopted alive child. Polls `isAlive(pid)` on
   * the `pollMs` interval; when the child exits, reads its result file via the
   * result-file oracle and records the terminal state + cost. Releases the one-at-a-time lock
   * (`activeId`) once done.
   *
   * Deliberately does NOT re-arm any timeout-kill timer (risk 4): the watcher's
   * only job is liveness polling + file-parse on exit — it never kills the child.
   *
   * Note: the per-poll liveness check is `isAlive(pid)` only (not lstart), so a
   * pid recycled mid-watch delays finalization until the next poll where the new
   * process also exits — it never misclassifies the result (the oracle reads the
   * file, not the process).
   */
  private startFinalizeWatcher(rec: TaskRecord): void {
    if (rec.pid === undefined || this.watchers.has(rec.id)) return;
    const pid = rec.pid;
    const timer = setInterval(() => {
      try {
        if (this.isAlive(pid)) return; // still running — keep waiting
        // Child has exited. Parse the result file to determine the outcome.
        const verdict = this.classifyFn(this.resultFilePathFor(rec.id));
        const finalStatus: TaskStatus = verdict.status === "running" ? "crashed" : verdict.status;
        const cur = this.records.get(rec.id);
        if (cur && cur.status === "running") {
          cur.status = finalStatus;
          cur.endedTs = this.now();
          if (typeof verdict.costUsd === "number") {
            // recordCost is first-write-wins and calls persist() internally —
            // it captures status+endedTs too since they share the same record reference.
            this.recordCost(rec.id, verdict.costUsd, verdict.basis ?? "real");
          } else {
            // No cost to record; persist the status+endedTs written above.
            this.persist();
          }
        }
        // Release the one-at-a-time lock regardless of whether the record changed
        // (guards against a parallel complete() having already cleared it).
        if (this.activeId === rec.id) this.activeId = null;
        this.stopWatcher(rec.id);
      } catch (e) {
        // A finalize failure (disk full, permission, fs error) must NEVER crash
        // the daemon. Degrade gracefully: release the lock, stop the watcher, log.
        console.error(`[task-registry] finalize watcher error for task ${rec.id}:`, e);
        if (this.activeId === rec.id) this.activeId = null;
        this.stopWatcher(rec.id);
      }
    }, this.pollMs);
    // Don't keep the event loop alive solely for this poll interval.
    (timer as { unref?: () => void }).unref?.();
    this.watchers.set(rec.id, timer);
  }

  private stopWatcher(id: string): void {
    const t = this.watchers.get(id);
    if (t) {
      clearInterval(t);
      this.watchers.delete(id);
    }
  }

  /** Cancel all active finalize watchers. Call on daemon shutdown to prevent
   * the poll intervals from pinning the event loop after stop(). */
  stopWatchers(): void {
    for (const t of this.watchers.values()) clearInterval(t);
    this.watchers.clear();
  }

  /** Number of active finalize watchers (for test assertions). */
  watcherCount(): number {
    return this.watchers.size;
  }

  /**
   * Wall-clock guard: a run that outlived the ceiling. Same abort+SIGKILL
   * escalation as cancel(), but the terminal is `crashed` — a machine-timeout is
   * NOT a user-cancel; two honest terminals (timeout-killed → crashed / cost
   * null, never a fabricated number). A no-op on an already-terminal id
   * (complete() guards `status !== "running"`).
   */
  timeoutKill(id: string): void {
    this.killLive(id, "crashed");
  }

  /**
   * Shared kill chain for cancel() + timeoutKill(): abort the controller (→
   * Bun.spawn SIGTERM), escalate to SIGKILL after `killEscalationMs` if the pid
   * is still alive, then record the terminal. The pid actually dying is
   * verified by a real liveness probe (kill(pid,0) → ESRCH).
   */
  private killLive(id: string, status: "cancelled" | "crashed"): void {
    const lh = this.live.get(id);
    if (lh) {
      try {
        lh.controller.abort();
      } catch {
        /* already aborted */
      }
      const proc = lh.proc;
      const pid = proc?.pid;
      if (proc && pid !== undefined) {
        const t = setTimeout(() => {
          if (this.isAlive(pid)) {
            try {
              proc.kill("SIGKILL");
            } catch {
              /* gone between probe + kill */
            }
          }
        }, this.killEscalationMs);
        // Don't keep the event loop alive solely for the escalation timer.
        (t as { unref?: () => void }).unref?.();
      }
    } else {
      // No live handle but the record may be an ADOPTED detached run
      // (recognized alive at the last reconcile, no re-grabbed Bun.Subprocess).
      // cancel() must STILL terminate its real child: otherwise the detached run
      // keeps spending, completes, writes its result file, and the next startup's
      // scavenger SKIPS it (the id is already a `cancelled` record) → a paid run
      // silently written off. Signal the pid directly (SIGTERM → SIGKILL escalate).
      const rec = this.records.get(id);
      const pid = rec?.status === "running" ? rec.pid : undefined;
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
        const t = setTimeout(() => {
          if (this.isAlive(pid)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              /* gone between probe + kill */
            }
          }
        }, this.killEscalationMs);
        (t as { unref?: () => void }).unref?.();
      }
    }
    // Explicit null (not an omitted/undefined field): the TaskRecord contract
    // (costUsd doc) reserves null for "ran but emitted no usage — never a
    // fabricated number". finish() already writes explicit null on a no-cost
    // done; cancel/crash must match so on-disk tasks.json is honest, not absent.
    this.complete(id, status, { costUsd: null });
  }

  get(id: string): TaskRecord | undefined {
    return this.records.get(id);
  }

  current(): TaskRecord | undefined {
    return this.activeId ? this.records.get(this.activeId) : undefined;
  }

  /**
   * The most-recently-started record (running or terminal), or undefined if no
   * task ever ran. The reconnect snapshot: a client returning to the page reads
   * this to see the running task (→ stream it) OR the last done/failed/crashed
   * run (→ surface its result/state) — `current()` alone goes null the instant a
   * run ends, so it can't tell "just finished" from "never ran".
   */
  latest(): TaskRecord | undefined {
    let best: TaskRecord | undefined;
    for (const rec of this.records.values()) {
      if (!best || rec.startedTs > best.startedTs) best = rec;
    }
    return best;
  }

  all(): TaskRecord[] {
    return [...this.records.values()];
  }

  /**
   * Idempotent-by-taskId cost ledger (dual-accounting guard). A dead
   * daemon's partial record and the adopting daemon's record for the SAME taskId
   * must de-duplicate → no double-billing. FIRST-WRITE-WINS keyed by record id:
   * the cost is set only if this record has no numeric cost yet, so calling
   * recordCost twice for one id bills once. No-op if the id is unknown (the
   * scavenger creates the record before recording for an orphan).
   */
  recordCost(id: string, usd: number, basis: CostBasis): void {
    const rec = this.records.get(id);
    if (!rec) return;
    if (typeof rec.costUsd === "number") return; // already billed this id — idempotent
    rec.costUsd = usd;
    rec.basis = basis;
    this.persist();
  }

  /** The per-task result file (`~/.siltpoke/tasks/<id>.out`) the detached
   * Brain child tees its stdout into — passed to the provider as `resultFilePath`
   * and scanned by the scavenger. Single definition shared by both sides. */
  resultFilePathFor(id: string): string {
    return join(this.tasksDir, `${id}.out`);
  }

  /** Sum of every DISTINCT record's numeric cost (null/absent cost → not billed). */
  totalCost(): number {
    let sum = 0;
    for (const rec of this.records.values()) {
      if (typeof rec.costUsd === "number") sum += rec.costUsd;
    }
    return sum;
  }

  private complete(
    id: string,
    status: Exclude<TaskStatus, "running">,
    patch: { costUsd?: number | null; errorMsg?: string },
  ): void {
    const rec = this.records.get(id);
    if (!rec || rec.status !== "running") return; // idempotent / already terminal
    rec.status = status;
    rec.endedTs = this.now();
    // Idempotent ledger: a terminal must not ERASE an already-recorded
    // numeric cost with null. recordCost() may have billed this id first (the
    // adoption / failure-ledger path); a later finish()/cancel() carrying the
    // default `costUsd: null` would otherwise zero it out → under-billing. Only
    // a numeric patch overwrites; null is ignored when a real cost already exists.
    if (patch.costUsd !== undefined) {
      if (patch.costUsd !== null || typeof rec.costUsd !== "number") {
        rec.costUsd = patch.costUsd;
      }
    }
    if (patch.errorMsg !== undefined) rec.errorMsg = patch.errorMsg;
    // Clear the wall-clock guard so a finished/cancelled run can never fire
    // a stale timeoutKill (which would be a no-op anyway, but don't leave it armed).
    const lh = this.live.get(id);
    if (lh?.timer) clearTimeout(lh.timer);
    this.live.delete(id);
    if (this.activeId === id) this.activeId = null; // release lock
    this.persist();
  }

  private persist(): void {
    atomicWrite(this.path, JSON.stringify(this.all(), null, 2));
  }

  /**
   * Load any prior tasks.json and reconcile each prior `running` record.
   *
   * For each prior `running`:
   *  - **alive pid + lstart MATCH** → ADOPT: leave it `running` and re-hold the
   *    one-at-a-time lock. The detached child is still alive and will write
   *    its result file; no live `Bun.Subprocess` handle is re-acquired and NO
   *    timeout-kill timer is re-armed (risk 4 — there is no handle to kill, and a
   *    stale timer could only mis-flip an honest record).
   *  - **alive pid + lstart MISMATCH** (OS reused the pid) → `crashed`. The pid
   *    points at a different process; never falsely adopt it (risk 1).
   *  - **dead pid** → `crashed`. (The file-parse oracle refines this to `done` +
   *    real cost when a complete result file exists; the scavenger below picks up orphans.)
   *
   * Only the FIRST adoptable record re-holds the lock (the one-at-a-time
   * invariant held while the prior daemon ran, so at most one is truly alive; a
   * second alive+match would be anomalous → leave it running but don't double-
   * grab the lock).
   */
  private load(): void {
    let prior: TaskRecord[] = [];
    if (existsSync(this.path)) {
      try {
        prior = JSON.parse(readFileSync(this.path, "utf8")) as TaskRecord[];
      } catch {
        // corrupt → the file is a cache, not a ledger. We DON'T return here (the
        // prior behavior leaked any detached child whose record lived only in the
        // lost cache); the scavenger below recovers orphans from the file dir.
        prior = [];
      }
    }
    let changed = false;
    for (const rec of prior) {
      if (rec.status === "running") {
        const pid = rec.pid;
        const adoptable =
          pid !== undefined &&
          this.isAlive(pid) &&
          rec.lstart !== undefined &&
          this.lstartOf(pid) === rec.lstart;
        if (adoptable) {
          // The detached child survived the daemon's death — adopt it.
          if (this.activeId === null) this.activeId = rec.id; // re-hold the lock
          // Bug B: start a finalize watcher so the lock is released (and the
          // record finalized) when the adopted child eventually exits. Without
          // this, generate_in_progress stays wedged until the next restart's
          // reconcile flips it.
          this.startFinalizeWatcher(rec);
        } else {
          // Dead (or pid-reused) → the file-parse oracle decides the FINAL state:
          // a complete result file makes this a done+real-cost run, not a false
          // crashed/$0. No result file → crashed.
          this.reconcileDead(rec);
          changed = true;
        }
      }
      this.records.set(rec.id, rec);
    }
    if (this.scavenge()) changed = true;
    if (changed) this.persist();
  }

  /**
   * A prior `running` whose live child is gone: consult its result file.
   * Mutates `rec` in place to the oracle's terminal — `done`+real cost when the
   * paid run actually completed (even truncated), else `crashed`. A `running`
   * verdict (file still being written by a child we can't see) is downgraded to
   * `crashed`: with no live handle and no liveness, an indefinitely-`running`
   * orphan would falsely hold the lock.
   */
  private reconcileDead(rec: TaskRecord): void {
    rec.endedTs = rec.endedTs ?? this.now();
    const file = this.resultFilePathFor(rec.id);
    if (!existsSync(file)) {
      rec.status = "crashed";
      return;
    }
    const verdict = _classifyResultFile(file, { model: ARCH_DEFAULT_MODEL });
    rec.status = verdict.status === "running" ? "crashed" : verdict.status;
    if (typeof verdict.costUsd === "number" && typeof rec.costUsd !== "number") {
      rec.costUsd = verdict.costUsd;
      rec.basis = verdict.basis;
    }
  }

  /**
   * Scavenger — scan the result-file dir for `<id>.out` whose id is ABSENT
   * from `records` and construct a record from the result-file oracle. Defends against a
   * lost/corrupt tasks.json that would otherwise leak a detached child's paid
   * outcome (the file dir is the source of truth, tasks.json only a cache).
   * Returns true if any orphan was adopted (→ persist). A still-writing orphan
   * (oracle `running`) is DOWNGRADED to `crashed` — mirroring reconcileDead():
   * a scavenged orphan has no live handle in THIS daemon, so an indefinitely-
   * `running` record (no liveness, no lock) would surface in all()/latest() as a
   * stale-running task with no process driving it. Cost stays null (honest — a
   * still-writing orphan we can't drive). A later restart with a stale mtime
   * re-classifies the file terminally (done/tail_parsed/crashed) via the oracle.
   */
  private scavenge(): boolean {
    if (!existsSync(this.tasksDir)) return false;
    let entries: string[];
    try {
      entries = readdirSync(this.tasksDir);
    } catch {
      return false;
    }
    let adopted = false;
    for (const name of entries) {
      if (!name.endsWith(".out")) continue;
      const id = name.slice(0, -".out".length);
      if (this.records.has(id)) continue; // already known (reconciled above)
      const filePath = join(this.tasksDir, name);
      const verdict = _classifyResultFile(filePath, { model: ARCH_DEFAULT_MODEL });
      // Mirror reconcileDead(): no live handle here, so a `running` oracle verdict
      // (still-writing/truncated-fresh) becomes `crashed` — never a stale-running
      // orphan with no process behind it.
      const status: TaskStatus = verdict.status === "running" ? "crashed" : verdict.status;
      // Derive the timestamps from the result file's mtime (a
      // fabricated `now()` startedTs would let a scavenged orphan outrank the
      // real most-recent run in latest(), hiding it from the reconnect snapshot).
      // Fall back to now() only if the mtime is unreadable.
      let fileTs = this.now();
      try {
        fileTs = new Date(statSync(filePath).mtimeMs).toISOString();
      } catch {
        /* keep now() */
      }
      const rec: TaskRecord = {
        id,
        kind: "arch_generate", // orphan: kind is unknown; default to the paid kind
        repo: "(scavenged)",
        status,
        startedTs: fileTs,
        endedTs: fileTs,
        costUsd: verdict.costUsd,
        basis: verdict.basis,
      };
      this.records.set(id, rec);
      adopted = true;
    }
    return adopted;
  }
}

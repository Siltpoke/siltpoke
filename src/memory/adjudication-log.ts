// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AbstainReason, Verdict } from "./acted-on-oracle";

/**
 * What the distil writer did with an `acted` critique. The first four come
 * straight from `writePositiveRule`; the last two are queue/worker outcomes
 * that previously left no trace at all.
 */
export type WriteOutcome =
  | "appended"
  | "bumped"
  | "garbage"
  | "dup"
  /** The entry aged out before anyone acted on it. */
  | "ttl_drop"
  /** The verdict was `acted` but the writer threw. Distinct from `garbage`: one
   *  is a judgement about the rule, the other is an infrastructure failure, and
   *  collapsing them would let a broken writer read as a quality problem. */
  | "write_failed";

/**
 * One line per adjudication (eval design §2.2).
 *
 * The queue and the verdicts already existed in code — they were simply thrown
 * away after being counted, which is why `acted_rate` could not be computed and
 * abstains were invisible. Writing them down makes enqueue rate, adjudication
 * rate, acted_rate, the abstain-reason distribution, the garbage/dup rate and
 * the TTL-drop rate all derivable from this one file.
 *
 * ONE LINE PER ADJUDICATION, NOT PER CRITIQUE. A critique that adjudicates
 * `not_yet` stays queued and is judged again on the next sweep, emitting another
 * record with the same `critique_id`, a later `adjudicated_at`, and a larger
 * `latency_ms` (`enqueued_at` stays pinned to the original enqueue). That is
 * intended — it is how "how long did this take to get acted on" is recoverable —
 * but it means `count(rows)` is NOT `count(critiques)`. Any rate whose
 * denominator is meant to be critiques must dedupe on `critique_id` first.
 *
 * NAMING: the metric is `acted_rate`, never `precision`. Whether a developer
 * acted on a finding is driven by workload and priority as much as by whether
 * the finding was correct — it is a PRODUCT signal, and calling it precision
 * would license using it as a correctness gate, which it cannot support.
 */
export interface AdjudicationRecord {
  critique_id: string;
  /** When the critique entered the queue. */
  enqueued_at: string;
  /** When this adjudication ran. */
  adjudicated_at: string;
  verdict: Verdict;
  /** Which mechanism decided (1 = checker rerun, 2 = content fingerprint). */
  verdict_tier?: 1 | 2;
  /** Present only on abstain — the causes are deliberately distinguishable. */
  abstain_reason?: AbstainReason;
  write_outcome?: WriteOutcome;
  /** enqueue → adjudication, for TTL tuning. */
  latency_ms: number;
}

export function adjudicationLogPath(stateBase: string): string {
  return join(stateBase, "adjudication.jsonl");
}

/**
 * Append one record. Fail-soft by construction: this is telemetry, and a log
 * that cannot be written must never take the memory loop down with it — the
 * same discipline the Stop hook's `appendJsonLine` follows.
 */
export async function appendAdjudication(
  path: string,
  record: AdjudicationRecord,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`);
  } catch {
    // Telemetry failures are never fatal.
  }
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * File-parse oracle for adopted/detached arch-generate runs.
 *
 * Extracted from task-registry.ts to keep that file under the 800-LOC hard
 * cap (lint:files ratchet). Pure I/O helper — no registry state.
 */
import { readFileSync, statSync } from "node:fs";
import { archCostFromUsage, ARCH_DEFAULT_MODEL, type ArchModel } from "../explain/arch-generate";
import { parseUsageFromTail } from "../explain/usage-tail";
import type { CostBasis, TaskStatus } from "./task-registry";

/**
 * Default "still being written" window. A truncated/unparseable `.out`
 * whose mtime is younger than this is treated as INCOMPLETE (the detached child
 * is mid-write) → `running`, never prematurely `crashed`/$0. Older than this +
 * still un-finalizable → terminal classification. 30s is comfortably above the
 * gap between stdout chunks of a live `claude -p` run.
 */
export const RESULT_FILE_FRESH_MS = 30_000;

export interface ClassifyOpts {
  /** Model whose rates price a usage-only (cost-absent) result. Default arch. */
  model?: ArchModel;
  /** Freshness window for the still-writing heuristic. Default RESULT_FILE_FRESH_MS. */
  freshMs?: number;
  /** Injected clock (ms epoch) for deterministic mtime-age tests. */
  nowMs?: () => number;
  /** Injected mtime probe (ms epoch) — defaults to statSync(path).mtimeMs. */
  mtimeMsOf?: (path: string) => number;
}

export interface ResultClassification {
  status: TaskStatus;
  costUsd: number | null;
  basis?: CostBasis;
}

/**
 * File-parse oracle — judge an adopted/detached run's outcome by PARSING its
 * result file, not by an exit code the new daemon never saw. Decision tree:
 *
 *  - empty / whitespace-only → `crashed`, cost null (the child wrote nothing).
 *  - complete JSON with a result event carrying `usage` → `done`; cost is the
 *    real `total_cost_usd` (`basis: real`) or, when that field is absent,
 *    recomputed from the token counts (`basis: derived`) — never $0 for a paid run.
 *  - JSON.parse fails (truncated):
 *      · mtime FRESH (< freshMs) → `running` — the child is still writing; do NOT
 *        finalize an in-flight run as crashed.
 *      · mtime STALE + a usage tail is salvageable → `done`, `basis: tail_parsed`
 *        (risk 8 — a paid run that truncated is NOT silently judged crashed/$0).
 *      · mtime STALE + nothing salvageable → `crashed`, cost null (honest).
 */
export function classifyResultFile(path: string, opts: ClassifyOpts = {}): ResultClassification {
  const model = opts.model ?? ARCH_DEFAULT_MODEL;
  const freshMs = opts.freshMs ?? RESULT_FILE_FRESH_MS;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const mtimeMsOf = opts.mtimeMsOf ?? ((p: string) => statSync(p).mtimeMs);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { status: "crashed", costUsd: null };
  }
  if (raw.trim().length === 0) {
    return { status: "crashed", costUsd: null };
  }

  // Complete JSON path — the happy case. `parsedComplete` tracks that JSON.parse
  // SUCCEEDED: a fully-parseable file is NOT still being written, so even when it
  // carries no usable result event it must NOT be treated as "still writing"
  // (fresh-mtime → running) — it is terminal (valid JSON, no result event).
  let parsedComplete = false;
  try {
    const events = JSON.parse(raw) as Array<{
      type?: string;
      result?: string;
      total_cost_usd?: number;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    }>;
    const final = Array.isArray(events)
      ? events.slice().reverse().find((e) => e.type === "result")
      : undefined;
    if (final?.usage) {
      const u = {
        input_tokens: final.usage.input_tokens ?? 0,
        output_tokens: final.usage.output_tokens ?? 0,
        cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: final.usage.cache_read_input_tokens ?? 0,
      };
      if (typeof final.total_cost_usd === "number") {
        return { status: "done", costUsd: final.total_cost_usd, basis: "real" };
      }
      return { status: "done", costUsd: archCostFromUsage(u, model), basis: "derived" };
    }
    // Parsed but no usable result event → the file is COMPLETE but result-less;
    // it is terminal (salvage-then-crashed below), NOT "still writing".
    parsedComplete = true;
  } catch {
    // fall through to the truncated path
  }

  // Truncated / unparseable. Fresh mtime ⇒ still being written ⇒ leave running —
  // but ONLY when JSON.parse FAILED. A fully-parseable result-less file is done
  // writing, so it skips this heuristic and goes straight to the terminal path.
  if (!parsedComplete) {
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      ageMs = nowMs() - mtimeMsOf(path);
    } catch {
      /* no mtime → treat as stale (terminal) */
    }
    if (ageMs < freshMs) {
      return { status: "running", costUsd: null };
    }
  }

  // Stale + cut: salvage a usage tail before giving up (risk 8).
  const tail = parseUsageFromTail(raw);
  if (tail) {
    const cost =
      tail.total_cost_usd ??
      archCostFromUsage(
        {
          input_tokens: tail.input_tokens,
          output_tokens: tail.output_tokens,
          cache_creation_input_tokens: tail.cache_creation_input_tokens,
          cache_read_input_tokens: tail.cache_read_input_tokens,
        },
        model,
      );
    return { status: "done", costUsd: cost, basis: "tail_parsed" };
  }

  return { status: "crashed", costUsd: null };
}

// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Doctor check for last Brain call — split out of doctor.ts to
 * keep that file under the 400-LOC ratchet.
 *
 * ALWAYS renders, with the last result, failure class, reason excerpt, and
 * timestamp, regardless of current health. When the breaker is latched
 * permanent for a binary-missing failure, a passing deterministic re-verify
 * (claude back on PATH) clears the breaker — the one mutation doctor
 * performs. Auth-flavored permanents stay latched (re-verify cannot prove
 * auth fixed; /siltpoke-wake is the user's clear).
 */
import { siltpokeRoot } from "../installer/paths";
import {
  readBrainHealth,
  writeBrainHealth,
  clearBreaker,
} from "../state/brain-health";
import type { CheckResult, DoctorOptions } from "./doctor";

export function checkBrainHealth(opts: DoctorOptions): CheckResult {
  const base = opts.siltpokeHome ?? siltpokeRoot();
  const health = readBrainHealth(base);
  const f = health.last_failure;

  if (health.last_attempt_ts === null && f === null) {
    return { name: "last Brain call: none recorded yet", pass: true, detail: null };
  }

  // Currently healthy (last attempt succeeded) — pass; retain the
  // last-failure record with timestamp in the row label.
  if (health.consecutive_failures === 0) {
    const failureNote = f !== null ? ` (last failure: ${f.class} @ ${f.ts})` : "";
    return {
      name: `last Brain call: ok @ ${health.last_success_ts ?? health.last_attempt_ts}${failureNote}`,
      pass: true,
      detail: null,
    };
  }

  // Currently failing. Deterministic re-verify can clear a binary-missing
  // permanent breaker without a paid call.
  const reverify = opts.brainReverifyFn ?? (() => Bun.which("claude") !== null);
  let cleared = false;
  if (
    health.breaker?.class === "permanent" &&
    f !== null &&
    /ENOENT|executable not found/i.test(f.stderr_excerpt) &&
    reverify()
  ) {
    // Re-verify clear = "try now", not "declare healthy" — clearBreaker
    // leaves consecutive_failures intact (next failure reopens escalated).
    writeBrainHealth(base, clearBreaker(health));
    cleared = true;
  }

  const reason = f !== null
    ? `${f.class} @ ${f.ts} — ${f.stderr_excerpt.trim().length > 0 ? f.stderr_excerpt.trim() : `exit ${f.exit_code ?? "?"}, no stderr`} (×${health.consecutive_failures} consecutive${f.attempts !== undefined ? `, ${f.attempts} attempts` : ""})`
    : `failing (×${health.consecutive_failures} consecutive)`;
  const breakerNote = cleared
    ? " · permanent breaker cleared by re-verify (claude on PATH) — next Stop hook will retry"
    : health.breaker !== null
      ? ` · breaker open (${health.breaker.class})`
      : "";
  return {
    name: "last Brain call: failing",
    pass: false,
    detail: `${reason}${breakerNote}`,
  };
}

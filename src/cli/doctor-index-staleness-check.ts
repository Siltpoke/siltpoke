// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Doctor row: repo-graph index staleness (slice ②, R12/R16).
 *
 * Warn-only — mirrors `checkDaemonStaleness`: this row's `pass` is ALWAYS
 * true, so it can never fail the doctor exit code. Only `status` carries the
 * visual distinction ("warn" for anything short of fresh). The verdict logic
 * itself lives in `stalenessVerdict` (the single source of truth shared with
 * the daemon-health endpoint and the dashboard badge) — this file only maps
 * that verdict onto a `CheckResult` row.
 */
import { loadRepoGraphConfig } from "../config/repo-graph-config";
import { siltpokeRoot } from "../installer/paths";
import { readIndexStaleness } from "../repo-graph/index-health";
import { stalenessVerdict } from "../repo-graph/staleness-verdict";
import type { CheckResult, DoctorOptions } from "./doctor";

const CHECK_NAME = "index staleness";

export async function checkIndexStaleness(opts: DoctorOptions = {}): Promise<CheckResult> {
  const home = opts.siltpokeHome ?? siltpokeRoot();
  const cwd = opts.repoRoot ?? process.cwd();
  const cfg = await loadRepoGraphConfig(home);
  const staleness = await readIndexStaleness({ cwd, home });
  const verdict = stalenessVerdict(staleness, cfg.staleness_warn_pct);

  if (verdict.level === "fresh") {
    return { name: CHECK_NAME, pass: true, detail: null };
  }
  if (verdict.level === "not_indexed") {
    return {
      name: CHECK_NAME,
      pass: true,
      status: "warn",
      detail: "no index built — open the dashboard's Code Map page and pick this repo",
    };
  }
  // "unknown" / "drifting" / "stale" — all report the split counts so the
  // row is actionable without a second lookup; "drifting" reads milder
  // because its headline already says "N% drifted" rather than "out of date".
  const { content_changed, deleted_still_indexed, unindexed_files } = verdict.counts;
  const detail = `${verdict.headline} (${content_changed} changed, ${deleted_still_indexed} deleted, ${unindexed_files} unindexed)`;
  return { name: CHECK_NAME, pass: true, status: "warn", detail };
}

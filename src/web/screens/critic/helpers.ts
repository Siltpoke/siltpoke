// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Critic screen helpers — pure functions + style constants used by the
 * main Critic surface + its sub-components.
 *
 * Extracted from src/web/screens/Critic.tsx.
 */
import { tokens } from "../../tokens/tokens";
import type {
  StatusFilter,
  SpeechKind,
  SortOrder,
  TimeRange,
} from "../../../state/api";

/**
 * Skip reasons the history/timeline surfaces colour by name.
 *
 * A missing key is not a bug — every consumer falls back to `ink3` — but a key
 * that no longer exists anywhere is dead config, and the whole point of naming
 * every skip (spec D6 / AC9) is that a reader can tell them apart. The ⏱
 * review-unit axis replaced `wrong_event_mode` / `on_demand_no_bypass`, so this
 * table follows it.
 */
export const STATUS_COLOR: Record<string, string> = {
  FIRED: tokens.color.moss,
  soft_budget_on_demand: tokens.color.amber,
  recursion_guard: tokens.color.ink3,
  quiet_hours: tokens.color.sky,
  // ⏱ review-unit skips (src/router/review-unit.ts). Only the three `fire:
  // false` reasons can appear here — a fire is not a skip, and the one fire
  // that writes a row (`pr_fallback_to_commit`) writes `review_unit_note`, not
  // `skipped`, so it is deliberately absent.
  not_a_git_repo: tokens.color.ink3,
  no_new_commit: tokens.color.ink3,
  tree_unchanged: tokens.color.ink3,
  // The docs gate (D7). Lives with the code-change gate rather than the
  // review-unit one, but it is a skip reason like the three above.
  docs_only: tokens.color.ink3,
  brain_error: tokens.color.terra,
  unknown: tokens.color.terra,
};

export interface FilterState {
  project: string | null;
  status: StatusFilter | null;
  kind: SpeechKind | null;
  range: TimeRange;
  sort: SortOrder;
  query: string | null;
  /** Builder-family filter (Brain select v2) — null means all families. */
  family: string | null;
}

/**
 * Build a filter href that flips one filter and preserves the rest.
 * Pass `value = null` to clear that filter.
 *
 * `basePath` defaults to "/history" (the original consumer); the merged
 * /timeline surface passes "/timeline" so the same chip bar drives both
 * pages by reuse.
 */
export function filterHref(
  active: FilterState,
  patch: Partial<FilterState>,
  basePath = "/history",
): string {
  const merged = { ...active, ...patch };
  const params = new URLSearchParams();
  if (merged.project) params.set("project", merged.project);
  // Status param semantics:
  //   omitted → default to "fired" server-side (hides recursion guards).
  //   "all"   → no filter (user explicitly opted in).
  //   "fired"/"skipped" → that filter.
  // ALWAYS emit an explicit value when the merged status is "all" (null) —
  // not just when this click IS the status click. A null status only ever
  // comes from an explicit ?status=all, so a kind/range/sort/project click
  // from that state must carry status=all forward; omitting it would
  // silently re-default to fired.
  if (merged.status) params.set("status", merged.status);
  else params.set("status", "all");
  if (merged.kind) params.set("kind", merged.kind);
  if (merged.range && merged.range !== "all") params.set("range", merged.range);
  if (merged.sort && merged.sort !== "newest") params.set("sort", merged.sort);
  if (merged.query) params.set("q", merged.query);
  if (merged.family) params.set("family", merged.family);
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export function formatTimeAgo(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 0) return "now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

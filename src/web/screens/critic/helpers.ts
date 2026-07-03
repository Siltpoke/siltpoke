// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
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

export const STATUS_COLOR: Record<string, string> = {
  FIRED: tokens.color.moss,
  soft_budget_on_demand: tokens.color.amber,
  recursion_guard: tokens.color.ink3,
  quiet_hours: tokens.color.sky,
  wrong_event_mode: tokens.color.ink3,
  on_demand_no_bypass: tokens.color.ink3,
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

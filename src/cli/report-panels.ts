// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// Panel renderers for the static report HTML — pure data-in / HTML-out.
// Extracted from src/cli/report.ts (god-file split).
//
// Includes the row-shape interfaces consumed by these renderers + the
// shared readJsonl utility (used here and by report-artifacts.ts via re-export).

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { CardResult, ProjectSummary } from "./card";
import type { StatsResult } from "./stats";
import { readStatus } from "../state/critique-status";
import type { I18nDict } from "./report-i18n";
import { fmt } from "./report-i18n";
import { esc, panelWrap, severityClass } from "./report-dom";

export interface BrainCallRow {
  timestamp?: string;
  cwd?: string;
  session_id?: string;
  duration_ms?: number;
  brain_output?: {
    mood?: string;
    severity?: string;
    confidence?: string;
    bubble_short?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    total_cost_usd?: number;
  };
  skipped?: string;
  gating_decision?: string;
  xp_awarded?: number;
}

export interface FeedbackRow {
  ts?: string;
  critique_id?: string;
  verdict?: string;
  reason?: string | null;
}

export interface CritiqueHistoryRow {
  timestamp?: string;
  critique_id?: string;
  cwd?: string;
  severity?: string;
  confidence?: string;
  bubble_short?: string;
  path?: string;
}

export interface ProjectInbox {
  cwd: string;
  short_name: string;
  pending: Array<{
    id: string;
    severity: string;
    confidence: string;
    ts: string;
    bubble: string;
  }>;
}

export interface UsageEventRow {
  ts?: string;
  kind?: string;
  session_id?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  total_cost_usd?: number;
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function bucketByDay(
  timestamps: string[],
  now: Date,
  days: number,
): { dateKey: string; count: number }[] {
  const todayKey = now.toISOString().slice(0, 10);
  const todayMs = Date.parse(`${todayKey}T00:00:00Z`);
  const buckets = new Array<{ dateKey: string; count: number }>(days);
  for (let i = 0; i < days; i++) {
    const ms = todayMs - (days - 1 - i) * 86_400_000;
    buckets[i] = {
      dateKey: new Date(ms).toISOString().slice(0, 10),
      count: 0,
    };
  }
  for (const ts of timestamps) {
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) continue;
    const tKey = new Date(t).toISOString().slice(0, 10);
    const tMs = Date.parse(`${tKey}T00:00:00Z`);
    const offset = Math.round((todayMs - tMs) / 86_400_000);
    if (offset < 0 || offset >= days) continue;
    const idx = days - 1 - offset;
    buckets[idx]!.count += 1;
  }
  return buckets;
}

export function renderTodayPanel(
  card: CardResult,
  stats: StatsResult,
  t: I18nDict,
): string {
  const budgetPct = Math.round(stats.used_pct * 100);
  const body = `
  <div class="stat-grid">
    <div class="stat"><div class="stat-v">${card.brain_calls_today}</div><div class="stat-k">${esc(t.brain_calls)}</div></div>
    <div class="stat"><div class="stat-v">${card.reflections_today}</div><div class="stat-k">${esc(t.reflections)}</div></div>
    <div class="stat"><div class="stat-v">$${card.cost_today_usd.toFixed(4)}</div><div class="stat-k">${esc(t.spent)}</div></div>
    <div class="stat"><div class="stat-v">${budgetPct}%</div><div class="stat-k">${esc(t.budget)}</div></div>
    <div class="stat"><div class="stat-v">${esc(card.trigger_mode)}</div><div class="stat-k">${esc(t.mode)}</div></div>
    <div class="stat"><div class="stat-v">${stats.quiet_active ? esc(t.quiet_on) : esc(t.quiet_off)}</div><div class="stat-k">${esc(t.quiet_hours)}</div></div>
  </div>`;
  return panelWrap(t.today, body, true);
}

export function renderChart(
  buckets: { dateKey: string; count: number }[],
  t: I18nDict,
): string {
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  if (max === 0) {
    return panelWrap(t.last_7_days, `<p class="muted">${esc(t.no_calls_recent)}</p>`, true);
  }
  const bars = buckets
    .map((b) => {
      const h = max > 0 ? Math.max(4, Math.round((b.count / max) * 100)) : 4;
      const label = b.dateKey.slice(5).replace("-", "/");
      return `<div class="bar" title="${b.dateKey}: ${b.count}"><div class="bar-fill" style="height:${h}%"></div><div class="bar-count">${b.count}</div><div class="bar-label">${label}</div></div>`;
    })
    .join("");
  return panelWrap(t.last_7_days, `<div class="chart">${bars}</div>`, true);
}

export function renderProjects(projects: ProjectSummary[], t: I18nDict): string {
  if (projects.length === 0) {
    return panelWrap(t.projects, `<p class="muted">${esc(t.no_project_activity)}</p>`, true);
  }
  const rows = projects
    .map(
      (p) =>
        `<tr><td><strong>${esc(p.short_name)}</strong><div class="muted small"><code>${esc(p.cwd)}</code></div></td><td>${p.calls_today}</td><td>${p.pending_critiques > 0 ? `<span class="pill">${p.pending_critiques}</span>` : "0"}</td></tr>`,
    )
    .join("");
  const body = `
  <table>
    <thead><tr><th>${esc(t.project_col)}</th><th>${esc(t.calls_today_col)}</th><th>${esc(t.pending_col)}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  return panelWrap(t.projects, body, true);
}

export function renderBrainCalls(
  rows: BrainCallRow[],
  usage: UsageEventRow[],
  t: I18nDict,
): string {
  if (rows.length === 0) {
    return panelWrap(t.recent_calls, `<p class="muted">${esc(t.no_calls_yet)}</p>`, false);
  }
  // Index usage rows by session_id so we can attach cost/tokens to each
  // brain-call without an O(n²) scan. session_id collisions (same session
  // produced both a main call AND a reflection) prefer the last entry —
  // matches what the user sees in the standalone usage log.
  const usageBySession = new Map<string, UsageEventRow>();
  for (const u of usage) {
    if (u.session_id) usageBySession.set(u.session_id, u);
  }

  const trs = rows
    .slice(-30)
    .reverse()
    .map((r) => {
      const ts = (r.timestamp ?? "").slice(0, 19).replace("T", " ");
      const cwd = r.cwd ? basename(r.cwd) : "?";
      if (r.skipped) {
        return `<tr class="skipped"><td>${esc(ts)}</td><td>${esc(cwd)}</td><td colspan="5" class="muted">${esc(t.skipped)}: ${esc(r.skipped)}</td></tr>`;
      }
      const sev = r.brain_output?.severity ?? "";
      const conf = r.brain_output?.confidence ?? "";
      const bubble = (r.brain_output?.bubble_short ?? "").slice(0, 120);
      // Prefer the embedded usage on the brain-call row (newer entries
      // carry it). Fall back to the session-keyed lookup so older rows
      // still get cost data when usage-events.jsonl has a match.
      const u = r.usage ?? (r.session_id ? usageBySession.get(r.session_id) : undefined);
      const inTok = u?.input_tokens ?? 0;
      const outTok = u?.output_tokens ?? 0;
      const cacheTok =
        (u?.cache_creation_input_tokens ?? 0) +
        (u?.cache_read_input_tokens ?? 0);
      const cost = u?.total_cost_usd;
      const tokCell =
        u !== undefined
          ? `<span class="tok-in" title="${esc(t.in_tokens)}">${inTok}</span> / <span class="tok-out" title="${esc(t.out_tokens)}">${outTok}</span> / <span class="tok-cache" title="${esc(t.cache_tokens)}">${cacheTok}</span>`
          : `<span class="muted">—</span>`;
      const costCell =
        typeof cost === "number"
          ? `$${cost.toFixed(4)}`
          : `<span class="muted">—</span>`;
      return `<tr><td>${esc(ts)}</td><td>${esc(cwd)}</td><td class="${severityClass(sev)}">${esc(sev)}/${esc(conf)}</td><td>${esc(bubble)}</td><td class="tok-cell">${tokCell}</td><td class="cost-cell">${costCell}</td><td class="muted">${r.duration_ms ? `${r.duration_ms}ms` : ""}</td></tr>`;
    })
    .join("");
  const body = `
  <p class="muted small">${esc(fmt(t.last_n, { n: "30" }))}</p>
  <table class="dense token-joined">
    <thead><tr>
      <th>${esc(t.time_col)}</th>
      <th>${esc(t.project_col)}</th>
      <th>${esc(t.sev_conf_col)}</th>
      <th>${esc(t.bubble_col)}</th>
      <th>${esc(t.in_tokens)} / ${esc(t.out_tokens)} / ${esc(t.cache_tokens)}</th>
      <th>${esc(t.cost_col)}</th>
      <th>${esc(t.dur_col)}</th>
    </tr></thead>
    <tbody>${trs}</tbody>
  </table>`;
  return panelWrap(t.recent_calls, body, false);
}

export function renderVerdicts(rows: FeedbackRow[], t: I18nDict): string {
  if (rows.length === 0) {
    return panelWrap(t.recent_verdicts, `<p class="muted">${t.no_verdicts_yet}</p>`, false);
  }
  const trs = rows
    .slice(-30)
    .reverse()
    .map((r) => {
      const ts = (r.ts ?? "").slice(0, 19).replace("T", " ");
      const cls =
        r.verdict === "dismissed"
          ? "verdict-dismissed"
          : r.verdict === "forwarded"
            ? "verdict-forwarded"
            : "verdict-acked";
      return `<tr><td>${esc(ts)}</td><td><code>${esc(r.critique_id ?? "")}</code></td><td class="${cls}">${esc(r.verdict ?? "")}</td><td>${esc(r.reason ?? "")}</td></tr>`;
    })
    .join("");
  const body = `
  <p class="muted small">${esc(fmt(t.last_n, { n: "30" }))}</p>
  <table class="dense">
    <thead><tr><th>${esc(t.time_col)}</th><th>${esc(t.critique_col)}</th><th>${esc(t.verdict_col)}</th><th>${esc(t.reason_col)}</th></tr></thead>
    <tbody>${trs}</tbody>
  </table>`;
  return panelWrap(t.recent_verdicts, body, false);
}

export async function buildProjectInboxes(
  cwds: Set<string>,
): Promise<ProjectInbox[]> {
  const out: ProjectInbox[] = [];
  for (const cwd of cwds) {
    const historyPath = join(cwd, ".siltpoke", "critiques", "history.jsonl");
    if (!existsSync(historyPath)) continue;
    const rows = await readJsonl<CritiqueHistoryRow>(historyPath);
    const pending: ProjectInbox["pending"] = [];
    for (const row of rows) {
      if (!row.path || !row.critique_id) continue;
      const status = await readStatus(row.path);
      if (status !== "pending") continue;
      pending.push({
        id: row.critique_id,
        severity: row.severity ?? "",
        confidence: row.confidence ?? "",
        ts: (row.timestamp ?? "").slice(0, 19).replace("T", " "),
        bubble: row.bubble_short ?? "",
      });
    }
    if (pending.length === 0) continue;
    out.push({
      cwd,
      short_name: basename(cwd) || cwd,
      pending,
    });
  }
  out.sort((a, b) => b.pending.length - a.pending.length);
  return out;
}

export function renderInboxes(inboxes: ProjectInbox[], t: I18nDict): string {
  if (inboxes.length === 0) {
    return panelWrap(t.pending_critiques, `<p class="muted">${esc(t.inbox_clean)}</p>`, true);
  }
  const blocks = inboxes
    .map((box) => {
      const rows = box.pending
        .map(
          (p) =>
            `<tr><td><code>${esc(p.id)}</code></td><td class="${severityClass(p.severity)}">${esc(p.severity)}/${esc(p.confidence)}</td><td>${esc(p.ts)}</td><td>${esc(p.bubble)}</td></tr>`,
        )
        .join("");
      return `
<details class="inbox" ${box.pending.length <= 5 ? "open" : ""}>
  <summary>
    <span class="inbox-name">${esc(box.short_name)}</span>
    <span class="pill">${box.pending.length}</span>
    <span class="muted small inbox-path"><code>${esc(box.cwd)}</code></span>
  </summary>
  <table class="dense">
    <thead><tr><th>${esc(t.id_col)}</th><th>${esc(t.sev_conf_col)}</th><th>${esc(t.time_col)}</th><th>${esc(t.bubble_col)}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</details>`;
    })
    .join("");
  return panelWrap(t.pending_critiques, blocks, true);
}

export function renderFooter(generatedAt: Date, t: I18nDict): string {
  const refresh = fmt(t.footer_refresh, { cmd: "<code>bun run report</code>" });
  return `<footer class="muted small">${esc(t.footer_generated)} ${esc(generatedAt.toISOString())} · ${refresh}</footer>`;
}

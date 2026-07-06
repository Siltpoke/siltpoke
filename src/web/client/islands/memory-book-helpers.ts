// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * memory-book-helpers — pure, Alpine-free logic for the /memory island.
 *
 * Split out of memory-book.ts to keep the island file under the LOC cap and to
 * let unit tests import the pure functions without any DOM/Alpine runtime.
 * Everything here is deterministic (the only impure read — today's date — lives
 * in the island's init(), and is passed into groupByDate as `todayKey`).
 *
 * Log-building helpers (FactEvent, LogRow, buildLogRows, injectSupersedeRows)
 * live in ./action-log-client (leaf module, no project deps) and are re-exported
 * here so callers keep their existing import paths.
 */
export type { FactEvent, LogRow } from "./action-log-client";
export { buildLogRows, injectSupersedeRows } from "./action-log-client";

import type { EntityRef } from "../../../memory/entity";
import { groupByEntity } from "../../../memory/entity";
import type { FactEvent, LogRow } from "./action-log-client";
import { buildLogRows, injectSupersedeRows } from "./action-log-client";

/**
 * Derived summary for the collapsed action-log line — computed client-side
 * from FactEvent[] by deriveClientSummary / decorateRow.
 */
export interface FactSummary {
  createdAt: string;
  reaffirmCount: number;
  lastReaffirmAt: string | null;
  retiredAt: string | null;
  /** Most-recent non-created, non-reaffirm event — kept for parity test + latent use. */
  latestStateChange: { action: string; at: string } | null;
}

export interface MemoryEventClient {
  ts: string;
  type: "semantic" | "episodic" | "procedural";
  text: string;
  why: string | null;
  status: "active" | "pending" | "retired";
  id: string;
  /** Reaffirmation count (Fact.recall_count); drives the "★ 重申 ×N" badge.
   *  Optional — older SSR payloads / non-fact rows may omit it (treated as 0). */
  recall_count?: number;
  /** ISO timestamp of the most recent reaffirmation (Fact.last_confirmed_at);
   *  appended as a date to the "★ 重申 ×N" badge. Optional/null — older SSR
   *  payloads / non-fact rows omit it (badge then shows no date). */
  last_confirmed_at?: string | null;
  /** Raw FactEvent[] from the SSR payload (Fact.events). Empty array for
   *  legacy / non-fact rows; synthesizeClientEvents generates synthetic events. */
  events?: FactEvent[];
  /** Supersede pointer — id of the fact this one replaced. null/absent when not a replacement. */
  supersedes?: string | null;
  /** Supersede pointer — id of the fact that replaced this one. null/absent when not superseded. */
  superseded_by?: string | null;
  /**
   * Provenance stream (Fact.learned_from.stream). Carried from the SSR payload.
   * "user" = hand-typed, "commit" = auto-learned from git commits,
   * "chat" / "critique" / "dismissal" / "remember" = other capture paths.
   * null/absent for non-semantic rows and seed/legacy facts.
   */
  stream?: string | null;
  /**
   * Communication-style vs personal-profile classification (Fact.kind). Drives
   * the kind badge + re-tag click on /memory. "style" → shapes code critiques;
   * "profile" → chat-only; null/absent → untagged. Carried from the SSR payload.
   */
  kind?: "style" | "profile" | null;
  /** Named entities this fact is about (Fact.entities), for the "by entity" view. */
  entities?: EntityRef[] | null;
}

export interface RecentChatClient {
  /** ChatSession.id — target for POST /api/chat/recap-recent patch-by-id. */
  id: string;
  summary: string;
  started_at: string;
  message_count: number;
}

export type MemoryType = "semantic" | "episodic" | "procedural";
export type MemoryStatus = "active" | "pending" | "retired";
export type ModalType = MemoryType | "working" | "";

export interface TypeMeta {
  label: string;
  color: string;
  ink: string;
  bg: string;
  bd: string;
}
export interface StatusMeta {
  label: string;
  ink: string;
  bg: string;
  bd: string;
}

/** Type visual system — mockup colors (episodic = purple #9d86c2). */
export const TYPE_META: Record<MemoryType, TypeMeta> = {
  semantic: {
    label: "Semantic",
    color: "#7fb0c8",
    ink: "#5a86a0",
    bg: "rgba(127,176,200,.13)",
    bd: "rgba(127,176,200,.45)",
  },
  episodic: {
    label: "Episodic",
    color: "#9d86c2",
    ink: "#8a72a8",
    bg: "rgba(157,134,194,.13)",
    bd: "rgba(157,134,194,.45)",
  },
  procedural: {
    label: "Procedural",
    color: "#7a9a5e",
    ink: "#5e7048",
    bg: "rgba(122,154,94,.14)",
    bd: "rgba(122,154,94,.45)",
  },
};

/** active→生效 · pending→待确认 · retired→退休. */
export const STATUS_META: Record<MemoryStatus, StatusMeta> = {
  active: {
    label: "Active",
    ink: "#5a7a3e",
    bg: "rgba(122,154,94,.15)",
    bd: "rgba(122,154,94,.45)",
  },
  pending: {
    label: "Pending",
    ink: "#a06a1e",
    bg: "rgba(232,168,92,.18)",
    bd: "rgba(232,168,92,.5)",
  },
  retired: {
    label: "Retired",
    ink: "#b84a4a",
    bg: "rgba(217,107,107,.13)",
    bd: "rgba(217,107,107,.4)",
  },
};

export const MODAL_META: Record<
  MemoryType | "working",
  { title: string; en: string; color: string; desc: string }
> = {
  semantic: {
    title: "Semantic Memory",
    en: "SEMANTIC",
    color: "#7fb0c8",
    desc: "Facts and knowledge — about this repo and your preferences",
  },
  episodic: {
    title: "Episodic Memory",
    en: "EPISODIC",
    color: "#9d86c2",
    desc: "Things that happened — what it did, how you reacted",
  },
  procedural: {
    title: "Procedural Memory",
    en: "PROCEDURAL",
    color: "#7a9a5e",
    desc: "Learned rules — how it does things (personality tuning in Settings)",
  },
  working: {
    title: "Working Memory",
    en: "WORKING",
    color: "#d96b6b",
    desc: "Short-term — current conversation + cross-chat recall, not written to the Memory Book",
  },
};

export interface Seg {
  t: string;
  isCode: boolean;
}

export interface DecoratedRow extends MemoryEventClient {
  time: string;
  dateLabel: string;
  typeLabel: string;
  typeColor: string;
  typeInk: string;
  typeBg: string;
  typeBd: string;
  statusLabel: string;
  statusInk: string;
  statusBg: string;
  statusBd: string;
  cardBg: string;
  segs: Seg[];
  /** Fact's recall_count (0 when absent) — templates show "★ 重申 ×N" when > 0. */
  reaffirmCount: number;
  /** Formatted reaffirmation date ("M/D" from last_confirmed_at) appended to the
   *  badge; "" when last_confirmed_at is null/absent (badge shows count only). */
  reaffirmAt: string;
  /** Synthesized FactEvent[] — raw stored events if present, synthetic fallback if
   *  empty (created + approved for active facts). Used by MemoryActionLog. */
  events: FactEvent[];
  /** Derived summary for the collapsed action-log line. */
  summary: FactSummary;
  /** Pre-normalized rows for the expanded rail (consecutive reaffirms folded). */
  logRows: LogRow[];
  /** Expand/collapse toggle for the action-log rail. Starts false. */
  expanded: boolean;
  /** Resolved text of the fact this one superseded (the OLD partner). Null when
   *  not a replacement or when the partner id is not found in the all list. */
  supersedesText: string | null;
  /** Resolved text of the fact that superseded this one (the NEW partner). Null
   *  when not superseded or when the partner id is not found in the all list. */
  supersededByText: string | null;
  /**
   * Human-readable provenance badge text (emoji + label), e.g. "✍️ you typed"
   * or "🤖 from commits". Null when there is no provenance to show (non-fact
   * rows, or seed/legacy facts with null stream).
   */
  streamBadge: string | null;
  /** CSS color string for the streamBadge. Empty string when streamBadge is null. */
  streamBadgeColor: string;
  /**
   * Kind badge text — 🎯 style (shapes critiques) / 💬 profile (chat-only) /
   * ❓ untagged (not yet classified). Shown on FACT rows only (null for
   * episodic/procedural). Clickable to re-tag (style↔profile; untagged→style).
   */
  kindBadge: string | null;
  /** CSS color string for the kindBadge. Empty string when kindBadge is null. */
  kindBadgeColor: string;
}

export interface MemoryGroup {
  date: string;
  label: string;
  sub: string; // weekday
  items: DecoratedRow[];
}

/** LLM-parsed classification of a free-NL composer message. */
export type MemoryEditClassification = "add" | "restate" | "contradict";

export interface Proposal {
  /** true → a single matching fact found; ✓确认 performs the real retire. */
  actionable: boolean;
  factId?: string;
  verb?: string;
  target?: string;
  detail: string;
  /**
   * Present only for an NL-parse proposal (from POST /api/facts/parse).
   * When set, the composer renders by classification (add/restate = single 确认;
   * contradict = 替换 / 两条都留 / 取消) instead of the deterministic retire card.
   */
  classification?: MemoryEditClassification;
  /** The atomic claim the user will add/replace-with (NL-parse path). */
  candidate?: string;
  /** Model confidence for the candidate (passed through to POST /api/facts). */
  confidence?: number;
  /** Matched fact id for restate (target) / contradict (the contradicted one). */
  targetFactId?: string;
  /** The contradicted/restated fact's text, shown in the proposal preview. */
  contradictedText?: string;
  /** The user's ORIGINAL typed message — stored as the new fact's save_reason
   * on confirm so a hand-typed memory's 为什么 line shows the user's own words
   * (provenance), not the "没记下来源（早期记忆）" fallback. */
  sourceText?: string;
}

/** Shape returned by POST /api/facts/parse. */
export interface ParseResponse {
  candidate: string;
  classification: MemoryEditClassification;
  confidence: number;
  targetFactId: string | null;
  contradictedFact: { id: string; text: string } | null;
}

/** Shape returned when the parse call is gated (budget / quiet-hours). */
export interface PausedResponse {
  paused: true;
  reason: string;
}

export function filterMemories(
  memories: MemoryEventClient[],
  filterType: MemoryType | "",
  filterStatus: MemoryStatus | "",
): MemoryEventClient[] {
  return memories.filter(
    (m) =>
      (!filterType || m.type === filterType) &&
      (!filterStatus || m.status === filterStatus),
  );
}

export function sortMemories(
  memories: MemoryEventClient[],
  desc: boolean,
): MemoryEventClient[] {
  const sorted = [...memories].sort((a, b) =>
    a.ts > b.ts ? -1 : a.ts < b.ts ? 1 : 0,
  );
  return desc ? sorted : sorted.reverse();
}

export function countByType(
  memories: MemoryEventClient[],
  type: MemoryType,
): number {
  return memories.filter((m) => m.type === type).length;
}

/** Split text on backticks → alternating text / inline-code segments. */
export function segs(str: string): Seg[] {
  return str
    .split("`")
    .map((t, i) => ({ t, isCode: i % 2 === 1 }))
    .filter((s) => s.t !== "");
}

/**
 * Format a Date as "YYYY-MM-DD" using the LOCAL timezone.
 * Exported so memory-book.ts can reuse it for todayKey to keep grouping consistent.
 */
export function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateKey(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) {
    return ts.length >= 10 ? ts.slice(0, 10) : ts;
  }
  return localDateKey(d);
}

function timeOf(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) {
    return ts.length >= 16 ? ts.slice(11, 16) : "";
  }
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** e.g. "2026-06-24" → "6/24". */
export function shortDate(d: string): string {
  const p = d.split("-");
  return p.length >= 3 ? `${+p[1]}/${+p[2]}` : d;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Group header label, deterministic given todayKey (YYYY-MM-DD, local TZ). */
export function groupLabel(d: string, todayKey: string): string {
  if (d === todayKey) return "Today";
  // Compute yesterday in LOCAL time: parse todayKey as local midnight, subtract 1 day.
  const prev = new Date(`${todayKey}T00:00:00`);
  prev.setDate(prev.getDate() - 1);
  if (d === localDateKey(prev)) return "Yesterday";
  const p = d.split("-");
  return p.length >= 3 ? `${MONTHS[+p[1] - 1]} ${+p[2]}` : d;
}

export function weekday(d: string): string {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = new Date(`${d}T00:00:00`).getDay();
  return names[day] ?? "";
}

// SYNC: keep semantically in step with src/memory/fact-events.ts#synthesizeLegacy
// + #deriveSummary — the two functions below are intentional client-side
// duplicates (server module can't be bundled here). Any logic change in the
// server equivalents MUST be mirrored here, and vice versa.
// Parity is mechanically verified by tests/memory/action-log-parity.test.ts.

/**
 * Synthesize a FactEvent[] for a row. If the row already has stored events
 * (non-empty), return them as-is. Otherwise generate synthetic events from the
 * row's SSR fields — mirrors fact-events.ts synthesizeLegacy but works with
 * MemoryEventClient (which uses `ts` instead of `created_at`).
 */
export function synthesizeClientEvents(m: MemoryEventClient): FactEvent[] {
  const stored = m.events ?? [];
  // Start with stored events or synthesize from SSR fields.
  let evs: FactEvent[];
  if (stored.length > 0) {
    evs = stored;
  } else {
    evs = [{ action: "created", at: m.ts, reason: null }];
    if (m.status === "active") {
      evs.push({ action: "approved", at: m.last_confirmed_at ?? m.ts, reason: null });
    }
  }
  // If the fact is retired but has no logged retired event, append a synthetic
  // retired event at read-time (never written; reversible). Uses m.ts as timestamp
  // since MemoryEventClient does not carry invalid_at / last_seen_at.
  if (m.status === "retired" && !evs.some((e) => e.action === "retired")) {
    return [...evs, { action: "retired", at: m.ts, reason: null }];
  }
  return evs;
}

/**
 * Derive the collapsed summary from a synthesized FactEvent[]. Mirrors
 * fact-events.ts deriveSummary but accepts a MemoryEventClient for `createdAt`.
 */
export function deriveClientSummary(m: MemoryEventClient, events: FactEvent[]): FactSummary {
  const reaffirms = events.filter((e) => e.action === "reaffirmed");
  const retired = events.findLast((e) => e.action === "retired") ?? null;
  const lastStateEv =
    events.findLast((e) => e.action !== "created" && e.action !== "reaffirmed") ?? null;
  return {
    createdAt: m.ts,
    // Take the max of counted reaffirm events and the stored recall_count so a
    // legacy fact with recall_count > 0 but empty events[] shows the right badge.
    reaffirmCount: Math.max(reaffirms.length, m.recall_count ?? 0),
    lastReaffirmAt: reaffirms.at(-1)?.at ?? null,
    retiredAt: retired?.at ?? null,
    latestStateChange: lastStateEv
      ? { action: lastStateEv.action, at: lastStateEv.at }
      : null,
  };
}

const STREAM_BADGE: Record<string, { label: string; color: string }> = {
  user:      { label: "✍️ you typed",     color: "#9d86c2" }, // violet
  commit:    { label: "🤖 from commits",  color: "#7a9a5e" }, // moss
  chat:      { label: "💬 from chat",     color: "#7fb0c8" }, // sky
  critique:  { label: "🔍 from review", color: "#e8a85c" }, // amber
  dismissal: { label: "👋 dismissed",     color: "#d96b6b" }, // terra
  remember:  { label: "💾 remembered",    color: "#5a4f3f" }, // ink2
};

function streamBadgeMeta(stream?: string | null): { badge: string | null; color: string } {
  if (!stream) return { badge: null, color: "" };
  const meta = STREAM_BADGE[stream];
  if (!meta) return { badge: null, color: "" };
  return { badge: meta.label, color: meta.color };
}

// 🪪 for profile (NOT 💬 — that's the chat STREAM badge; a fact can carry both,
// so the kind badge needs a distinct glyph). Shown on fact rows only.
const KIND_BADGE: Record<"style" | "profile" | "untagged", { label: string; color: string }> = {
  style: { label: "🎯 style", color: "#c2783a" }, // shapes the critic's critiques
  profile: { label: "🪪 profile", color: "#6b7a9a" }, // chat-only — kept out of code reviews
  untagged: { label: "❓ untagged", color: "#a89a86" }, // not yet classified
};

function kindBadgeMeta(kind?: "style" | "profile" | null): { badge: string; color: string } {
  const meta = KIND_BADGE[kind ?? "untagged"];
  return { badge: meta.label, color: meta.color };
}

export function decorateRow(m: MemoryEventClient, all?: MemoryEventClient[]): DecoratedRow {
  const t = TYPE_META[m.type];
  const s = STATUS_META[m.status];
  const events = synthesizeClientEvents(m);
  const summary = deriveClientSummary(m, events);
  // Resolve partner texts by id lookup — null when pointer absent or partner missing.
  const supersedesText =
    m.supersedes && all
      ? (all.find((f) => f.id === m.supersedes)?.text ?? null)
      : null;
  const supersededByText =
    m.superseded_by && all
      ? (all.find((f) => f.id === m.superseded_by)?.text ?? null)
      : null;
  // Build log rows (newest→oldest, no 'created', per-event reaffirms) then
  // inject supersede sub-rows at the right positions.
  const baseRows = buildLogRows(events, m.recall_count, m.last_confirmed_at);
  const logRows = injectSupersedeRows(
    baseRows,
    supersedesText,
    m.supersedes,
    supersededByText,
    m.superseded_by,
  );
  const { badge: streamBadge, color: streamBadgeColor } = streamBadgeMeta(m.stream);
  // Kind badge on fact (semantic) rows only — episodic/procedural have no kind.
  const kindMeta = m.type === "semantic" ? kindBadgeMeta(m.kind) : null;
  return {
    ...m,
    time: timeOf(m.ts),
    dateLabel: shortDate(dateKey(m.ts)),
    typeLabel: t.label,
    typeColor: t.color,
    typeInk: t.ink,
    typeBg: t.bg,
    typeBd: t.bd,
    statusLabel: s.label,
    statusInk: s.ink,
    statusBg: s.bg,
    statusBd: s.bd,
    cardBg: m.status === "retired" ? "#f6f1e6" : "#fffdf8",
    segs: segs(m.text),
    reaffirmCount: m.recall_count ?? 0,
    reaffirmAt: m.last_confirmed_at
      ? shortDate(dateKey(m.last_confirmed_at))
      : "",
    events,
    summary,
    logRows,
    expanded: false,
    supersedesText,
    supersededByText,
    streamBadge,
    streamBadgeColor,
    kindBadge: kindMeta?.badge ?? null,
    kindBadgeColor: kindMeta?.color ?? "",
  };
}

/**
 * Group an already-sorted list by date into header-bearing groups.
 * Pure + deterministic — todayKey is passed in (never reads new Date()).
 */
export function groupByDate(
  memories: MemoryEventClient[],
  todayKey: string,
  all?: MemoryEventClient[],
): MemoryGroup[] {
  const groups: MemoryGroup[] = [];
  for (const m of memories) {
    const dk = dateKey(m.ts);
    let g = groups[groups.length - 1];
    if (!g || g.date !== dk) {
      g = {
        date: dk,
        label: groupLabel(dk, todayKey),
        sub: weekday(dk),
        items: [],
      };
      groups.push(g);
    }
    g.items.push(decorateRow(m, all));
  }
  return groups;
}

/** Header-bearing group for the "by entity" view (mirrors MemoryGroup). */
export interface EntityMemoryGroup {
  key: string;
  label: string;
  items: DecoratedRow[];
}

/**
 * Group memories by named entity, reusing the shared pure groupByEntity
 * (src/memory/entity.ts) — single-sourced with the server-side grouping —
 * then decorate each group's rows for MemoryAlpineRow (mirrors groupByDate).
 */
export function groupMemoriesByEntity(
  memories: MemoryEventClient[],
  all?: MemoryEventClient[],
): EntityMemoryGroup[] {
  return groupByEntity(memories).map((g) => ({
    key: g.key,
    label: g.label,
    items: g.facts.map((m) => decorateRow(m, all)),
  }));
}

/**
 * Deterministic "改记忆" matcher (NO LLM).
 * Forget/retire intent + exactly one matching non-retired semantic fact →
 * actionable proposal. Otherwise an honest non-actionable proposal.
 */
export function buildProposal(
  text: string,
  memories: MemoryEventClient[],
): Proposal {
  const isForget = /忘掉|忘记|退休|forget/i.test(text);
  if (isForget) {
    const cleaned = text
      .replace(/忘掉|忘记|退休|forget|那条|这条|关于|的事|记忆|一下/gi, " ")
      .trim();
    const keywords = cleaned
      .split(/[\s,，。、:：]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    if (keywords.length > 0) {
      const candidates = memories.filter(
        (m) => m.type === "semantic" && m.status !== "retired",
      );
      const matched = candidates.filter((m) => {
        const hay = m.text.toLowerCase();
        return keywords.some((tok) => hay.includes(tok.toLowerCase()));
      });
      if (matched.length === 1) {
        const f = matched[0];
        return {
          actionable: true,
          factId: f.id,
          verb: "retire",
          target: f.text,
          detail: "I'll mark this one as retired.",
        };
      }
    }
  }
  return {
    actionable: false,
    detail: "siltpoke can't edit this one directly yet — full natural-language memory editing isn't live.",
  };
}

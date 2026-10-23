// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * What dashboard chat is told when the user chats from /timeline: the page's
 * rail as plain text — the same read the /timeline route makes with no
 * filters set (fired reviews, newest first, 12 turns) — plus the review the
 * page opens by default, the newest one.
 *
 * The page's own filters live in its query string, which chat never sees, so
 * the text says it is the unfiltered view.
 */
import { homedir } from "node:os";
import type { CriticCall, CriticTelemetry } from "../state/api";
import { readCriticTelemetry } from "../state/api";

/** The /timeline page's own default: 12 turns (routes/timeline.tsx TIMELINE_PAGE_ROWS). */
const ROWS = 12;
/** Caps keep one long review from crowding the prompt. */
const SHORT_CAP = 200;
const LONG_CAP = 1500;

function clip(text: string, cap: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function rowLine(c: CriticCall): string {
  const parts = [localTime(c.timestamp), c.project];
  if (c.status === "fired") {
    parts.push(c.speech_kind ?? "comment");
    const built = c.authorFamily || "claude";
    const reviewer = c.provider === "anthropic" || !c.provider ? "claude" : c.provider;
    parts.push(reviewer === built ? `by ${built}` : `built by ${built}, reviewed by ${reviewer}`);
    if (c.user_action) parts.push(c.user_action);
    return `- ${parts.join(" · ")}: ${clip(c.bubble_short ?? "(no summary)", SHORT_CAP)}`;
  }
  const why = c.error_message !== null ? `${c.skip_reason ?? "unknown"}: ${c.error_message}` : (c.skip_reason ?? "unknown reason");
  return `- ${parts.join(" · ")} · skipped: ${clip(why, SHORT_CAP)}`;
}

/** The page as text. Pure: the caller reads the telemetry. */
export function timelinePageText(t: Pick<CriticTelemetry, "recent">, now: Date): string {
  if (t.recent.length === 0) return "";
  const lines = [`Now: ${localTime(now.toISOString())}.`, "Reviews on the page, newest first (no filters set):", ...t.recent.map(rowLine)];
  const open = t.recent.find((c) => c.status === "fired");
  if (open) {
    lines.push("", `Open by default — the newest review (${localTime(open.timestamp)}, ${open.project}):`);
    if (open.bubble_long) lines.push(clip(open.bubble_long, LONG_CAP));
    if (open.critique_for_claude) lines.push(`What it asked the coding agent: ${clip(open.critique_for_claude, LONG_CAP)}`);
  }
  return lines.join("\n");
}

export async function readTimelinePageText(homeBase: string, now: Date = new Date()): Promise<string> {
  const telemetry = await readCriticTelemetry(homeBase, now, {
    project: null,
    status: "fired",
    kind: null,
    range: "all",
    sort: "newest",
    query: null,
    family: null,
    before: null,
    after: null,
    windowMode: "turns",
    limit: ROWS,
    homeDir: homedir(),
  });
  return timelinePageText(telemetry, now);
}

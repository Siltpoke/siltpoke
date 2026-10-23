// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The chat island's half of the Runs window (spec 2026-10-13 §10.1): the
 * Runs button, the split frame, the divider drag, and the link between a
 * chat answer and its record. Spread into `makeFloatingChatData`; the pane's
 * own content is `chat-runs-panel.ts`.
 *
 *   - Runs opens at its narrowest, 340 px, and drags wider up to 560 px
 *     (only into free space — the chat column keeps its width); double-click
 *     on the divider returns to 340; the width is remembered in this browser.
 *   - Selecting moves only the highlight on both sides.
 */
import { mountRunsPanel, type RunsPanel } from "./chat-runs-panel";
import { HISTORY_PANE_PX } from "./floating-chat-history";

export const RUNS_DEFAULT_PX = 340;
/** The narrowest Runs can be dragged. */
export const RUNS_MIN_PX = 340;
/** The widest Runs gets, however wide the window: a wider pane crowds the chat. */
export const RUNS_MAX_PX = 560;
const GRIP_PX = 7;
/**
 * The chat column's width, Runs open or closed: 530 in the corner, 800
 * maximized. The panel's own width classes in `FloatingChat.tsx` match.
 */
const CHAT_BASE_PX = { corner: 530, maximized: 800 } as const;
/**
 * New key with the 340–560 range: a width saved under the old 480–800 key
 * would have reopened every existing user at 480 or wider.
 */
const WIDTH_KEY = "siltpoke.chat.runsW";
/** Matches the panel's right margin plus a gutter on the left. */
const VIEWPORT_GUTTER_PX = 40;

function readSavedWidth(): number {
  try {
    const n = Number.parseInt(globalThis.localStorage?.getItem(WIDTH_KEY) ?? "", 10);
    return Number.isFinite(n) && n >= RUNS_MIN_PX ? Math.min(n, RUNS_MAX_PX) : RUNS_DEFAULT_PX;
  } catch {
    return RUNS_DEFAULT_PX;
  }
}

function saveWidth(px: number): void {
  try {
    globalThis.localStorage?.setItem(WIDTH_KEY, String(px));
  } catch {
    // private window / blocked storage — the width just isn't remembered
  }
}

function viewportWidth(): number {
  // clientWidth leaves out a visible scrollbar, as the fixed, centred panel does.
  return typeof document !== "undefined" ? document.documentElement.clientWidth || 1440 : 1440;
}

/** What sits left of the Runs divider: the history pane when open, then the chat column. */
function leftOfRuns(maximized: boolean, history: boolean): number {
  return (history ? HISTORY_PANE_PX : 0) + (maximized ? CHAT_BASE_PX.maximized : CHAT_BASE_PX.corner);
}

/**
 * The widest Runs can be: 560 px, and never so wide that the chat column
 * drops below its own width for this mode (530 corner, 800 maximized), or
 * squeezes the history pane when it is open. Runs grows into empty space
 * only; the chat column never pays for it. This maximum never drops below
 * the 340 default, even in a narrow window.
 */
export function runsMaxWidth(maximized: boolean, vw: number, history = false): number {
  const left = leftOfRuns(maximized, history);
  return Math.max(RUNS_DEFAULT_PX, Math.min(RUNS_MAX_PX, vw - VIEWPORT_GUTTER_PX - left - GRIP_PX));
}

/** The Runs width on screen: the stored one, trimmed for this mode and window. */
function shownWidth(r: { runsWidth: number; maximized: boolean; historyOpen: boolean }): number {
  return Math.min(r.runsWidth, runsMaxWidth(r.maximized, viewportWidth(), r.historyOpen));
}

/**
 * The Runs width that puts the divider under the pointer — worked out from
 * the layout, never read back from it (reading the panel's width mid-drag made
 * the divider jump at the window edge; review round 2).
 *
 * Corner: the panel is pinned to the right edge, so the divider moves 1:1.
 * Maximized: the panel is centred and as wide as (history +) chat + divider +
 * Runs, up to the window; the divider's x is then (vw + panel)/2 − divider −
 * Runs, solved for Runs on each side of that cap.
 */
export function widthUnderPointer(
  maximized: boolean,
  vw: number,
  start: { x: number; w: number },
  pointerX: number,
  history = false,
): number {
  if (!maximized) return start.w + (start.x - pointerX);
  const left = leftOfRuns(true, history);
  const cap = vw - VIEWPORT_GUTTER_PX;
  const gripX = (w: number): number => (vw + Math.min(cap, left + GRIP_PX + w)) / 2 - GRIP_PX - w;
  // Keep the pointer's offset from the divider at drag start.
  const target = pointerX - (start.x - gripX(start.w));
  const uncapped = vw + left - GRIP_PX - 2 * target;
  return left + GRIP_PX + uncapped <= cap ? uncapped : (vw + cap) / 2 - GRIP_PX - target;
}

/** The stored answer id from a `run` SSE event (`{run_id, message_id, recorded}`). */
export function runEventMessageId(data: string): string | undefined {
  try {
    const id = (JSON.parse(data) as { message_id?: unknown }).message_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Id + arrival time for a live answer bubble. */
export function answerMeta(id: string | undefined): { id?: string; at: string } {
  return { ...(id ? { id } : {}), at: new Date().toISOString() };
}

/** The fields and methods the Runs window adds to the chat island. */
export interface RunsWindow {
  runsOpen: boolean;
  runsWidth: number;
  /** The answer whose record is highlighted (a stored assistant message id). */
  selectedMsgId: string | null;
  _runsPanel: RunsPanel | null;
  /** Where a divider drag started (pointer x, Runs width), or null. */
  _gripDrag: { x: number; w: number } | null;
  /** The conversation the pane last showed — a switch clears the highlight. */
  _runsSession: string | null;
  toggleRuns(): void;
  /** Load the active conversation's records into the pane (no-op while closed). */
  syncRuns(): Promise<void>;
  /** A chat answer was clicked. */
  selectAnswer(messageId: string | undefined): void;
  /** A bubble timestamp: HH:MM:SS in local time, "" when unknown. */
  msgTime(iso: string | undefined): string;
  /** Inline width for the panel while Runs or the history pane is open ("" when both are closed). */
  runsPanelStyle(): string;
  /** Clamp and set; `save: false` changes only this page (a smaller window must not overwrite the width chosen on a bigger one). */
  setRunsWidth(px: number, save?: boolean): void;
  gripDown(ev: PointerEvent): void;
  gripMove(ev: PointerEvent): void;
  gripUp(): void;
  gripKey(ev: KeyboardEvent): void;
}

/** What the Runs half reads from the rest of the chat island. */
interface ChatHost {
  secret: string;
  maximized: boolean;
  /** The past-chats pane left of the chat column. */
  historyOpen: boolean;
  active(): { serverSessionId: string | null } | undefined | null;
}

type Self = RunsWindow & ChatHost;

export function makeRunsWindow(fetchFn: typeof fetch): RunsWindow {
  return {
    runsOpen: false,
    runsWidth: readSavedWidth(),
    selectedMsgId: null,
    _runsPanel: null,
    _gripDrag: null,
    _runsSession: null,

    toggleRuns() {
      const self = this as Self;
      self.runsOpen = !self.runsOpen;
      // Start from the saved width each time (at most 560), not trimmed to
      // this window — runsPanelStyle trims it to the window and mode, so a
      // wider window or the other mode gets the full width back.
      if (self.runsOpen) self.runsWidth = readSavedWidth();
      if (self.runsOpen) void self.syncRuns();
    },

    async syncRuns() {
      const self = this as Self;
      if (!self.runsOpen || typeof document === "undefined") return;
      if (self._runsPanel === null) {
        const root = document.querySelector<HTMLElement>("#siltpoke-floating-chat [data-runs-root]");
        if (!root) return;
        self._runsPanel = mountRunsPanel(root, {
          fetchFn,
          secret: () => self.secret,
          onPick: (id) => {
            self.selectedMsgId = id;
            document
              .querySelector(`#siltpoke-floating-chat [data-msg-id="${CSS.escape(id)}"]`)
              ?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
          },
        });
      }
      const session = self.active()?.serverSessionId ?? null;
      // The highlight belongs to one conversation: carrying it into another
      // made that one say "No record for this answer" (review round 1).
      if (session !== self._runsSession) self.selectedMsgId = null;
      self._runsSession = session;
      await self._runsPanel.load(session);
      self._runsPanel.select(self.selectedMsgId);
    },

    selectAnswer(messageId) {
      const self = this as Self;
      if (!messageId) return;
      self.selectedMsgId = messageId;
      if (!self.runsOpen) {
        self.runsOpen = true;
        void self.syncRuns();
        return;
      }
      self._runsPanel?.select(messageId);
    },

    msgTime(iso) {
      const d = iso ? new Date(iso) : null;
      if (!d || Number.isNaN(d.getTime())) return "";
      return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
    },

    runsPanelStyle() {
      const self = this as Self;
      const fit = (px: number): string => `width:min(calc(100vw - ${VIEWPORT_GUTTER_PX}px), ${px}px)`;
      const left = leftOfRuns(self.maximized, self.historyOpen);
      if (!self.runsOpen) return self.historyOpen ? fit(left) : "";
      // A width set in the other mode (or a wider window) is trimmed here, not
      // overwritten: going back restores it.
      const runs = shownWidth(self);
      return `${fit(left + GRIP_PX + runs)};--runs-w:${runs}px`;
    },

    setRunsWidth(px, save = true) {
      const self = this as Self;
      const max = runsMaxWidth(self.maximized, viewportWidth(), self.historyOpen);
      self.runsWidth = Math.round(Math.min(Math.max(px, RUNS_MIN_PX), max));
      if (save) saveWidth(self.runsWidth);
    },

    gripDown(ev) {
      const self = this as Self;
      (ev.target as Element | null)?.setPointerCapture?.(ev.pointerId);
      // Start from the width on screen, which may be trimmed for this mode.
      self._gripDrag = { x: ev.clientX, w: shownWidth(self) };
    },

    gripMove(ev) {
      const self = this as Self;
      const start = self._gripDrag;
      if (!start) return;
      self.setRunsWidth(widthUnderPointer(self.maximized, viewportWidth(), start, ev.clientX, self.historyOpen));
    },

    gripUp() {
      (this as Self)._gripDrag = null;
    },

    gripKey(ev) {
      const self = this as Self;
      if (ev.key === "ArrowLeft") self.setRunsWidth(shownWidth(self) + 40);
      else if (ev.key === "ArrowRight") self.setRunsWidth(shownWidth(self) - 40);
      else if (ev.key === "Home") self.setRunsWidth(RUNS_DEFAULT_PX);
      else return;
      ev.preventDefault();
    },
  };
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * memory-book — Alpine island for the /memory  screen.
 *
 * Three views:
 *   - timeline (时间流): date-grouped stream of every durable memory, primary.
 *   - byType (按类型): 2×2 gradient cards → modal drill-down + NL composer.
 *   - entity (实体): groups via the shared groupByEntity (src/memory/entity.ts).
 *
 * The composer () has two paths. (1) Deterministic forget fast-path (NO
 * LLM):  keyword-matches one existing semantic fact; ✓确认 performs the
 * real POST /api/facts/:id/retire (soft delete). (2) NL path: any other text
 * → POST /api/facts/parse (one haiku call, budget/quiet-hours gated, NEVER
 * writes) → an add/restate/contradict proposal the user must confirm (confirmAdd
 * / confirmRestate / confirmReplace / keepBoth → POST /api/facts or /restate).
 * Either way nothing is mutated without an explicit confirm — never a faked one.
 *
 * Pure logic lives in ./memory-book-helpers (Alpine-free, unit-tested). This
 * file is the Alpine data object + browser registration only.
 *
 * Registration: document.addEventListener("alpine:init", ...) so it fires before Alpine.start() walks the DOM. Imported by src/web/client/index.ts.
 *
 * IMPORTANT: never bind handlers via addEventListener on island DOM — hx-boost morph nav drops direct listeners. Use x-on:* instead (modal ESC binding uses x-on:keydown.escape.window, which survives morph).
 */
import {
  buildProposal,
  countByType,
  type DecoratedRow,
  decorateRow,
  type EntityMemoryGroup,
  type FactEvent,
  filterMemories,
  groupByDate,
  groupMemoriesByEntity,
  localDateKey,
  type MemoryEventClient,
  type MemoryGroup,
  type MemoryStatus,
  type MemoryType,
  MODAL_META,
  type ModalType,
  type ParseResponse,
  type PausedResponse,
  type Proposal,
  type RecentChatClient,
  STATUS_META,
  sortMemories,
  TYPE_META,
} from "./memory-book-helpers";
import { tokens } from "../../tokens/tokens";

// Re-export the pure surface so existing imports (and unit tests) can keep
// importing from "./memory-book".
export * from "./memory-book-helpers";

/**
 * The page's resolved proj_hash as a `?repo=` query suffix, read from the
 * `[data-proj-hash]` attribute Layout.tsx sets on the root `<html>` element
 * (per-request project resolution — see src/daemon/project-context.ts). Every
 * write fetch below appends this so the server-side write-guard resolves the
 * SAME project the page did. "" when unresolved → no query param (the
 * server falls back to its own sticky-pin resolution, same as any other
 * omitted `?repo=`).
 */
function writeRepoQuery(): string {
  const projHash =
    (typeof document !== "undefined"
      ? document.querySelector("[data-proj-hash]")?.getAttribute("data-proj-hash")
      : null) ?? "";
  return projHash ? `?repo=${projHash}` : "";
}

export interface MemoryBookData {
  memories: MemoryEventClient[];
  recentChats: RecentChatClient[];
  workingCount: number;
  secret: string;
  todayKey: string;
  view: "timeline" | "byType" | "entity";
  filterType: MemoryType | "";
  filterStatus: MemoryStatus | "";
  sortDesc: boolean;
  modalType: ModalType;
  chat: string;
  proposal: Proposal | null;
  parsing: boolean;
  toast: string | null;
  /**
   * Guards the lazy per-chat recap fetch to fire at most once per
   * page load (openModal("working") can be clicked repeatedly). Not reset on
   * closeModal — a full page reload is the only way to re-arm it.
   */
  _recapFetched: boolean;
  TYPE_COLORS: Record<MemoryType, string>;
  STATUS_COLORS: Record<MemoryStatus, string>;
  init(): void;
  filteredMemories(): MemoryEventClient[];
  groups(): MemoryGroup[];
  byEntityGroups(): EntityMemoryGroup[];
  memoriesForModal(): DecoratedRow[];
  samples(type: MemoryType): DecoratedRow[];
  countByType(type: MemoryType): number;
  countActiveByType(type: MemoryType): number;
  emptyMessage(): string;
  modalTypeLabel(): string;
  modalTitle(): string;
  modalEn(): string;
  modalDesc(): string;
  modalColor(): string;
  modalEmptyMessage(): string;
  setView(view: "timeline" | "byType" | "entity"): void;
  setFilterType(type: MemoryType | ""): void;
  setFilterStatus(status: MemoryStatus | ""): void;
  toggleSort(): void;
  sortLabel(): string;
  openModal(type: ModalType): void;
  closeModal(): void;
  /**
   * Lazy cross-chat recap fetch, fired (not awaited) by openModal on
   * first "working" open. Internal — not called directly from templates, but
   * on the public interface so tests can await it deterministically.
   */
  _fetchRecaps(): Promise<void>;
  sendChat(): Promise<void>;
  confirmProposal(): Promise<void>;
  confirmAdd(): Promise<void>;
  confirmRestate(id: string): Promise<void>;
  confirmReplace(oldId: string): Promise<void>;
  keepBoth(): Promise<void>;
  _createFact(body: {
    text: string;
    confidence?: number;
    supersedes?: string;
    save_reason?: string;
  }): Promise<boolean>;
  cancelProposal(): void;
  flashToast(msg: string): void;
  retireFact(id: string): Promise<boolean>;
  reactivateFact(id: string): Promise<void>;
  approveFact(id: string): Promise<void>;
  rejectFact(id: string): Promise<void>;
  deleteFact(id: string): Promise<void>;
  /** Re-tag — cycle a fact's kind (style↔profile, untagged→style). */
  cycleFactKind(event: { id: string; kind?: "style" | "profile" | null }): void;
  setFactKind(id: string, kind: "style" | "profile"): Promise<void>;
  /** Pin/unpin a fact against decay (POST /api/facts/:id/pin). */
  setPinned(id: string, pinned: boolean): Promise<void>;
  /**
   * Scroll the target card into view and briefly highlight it. Morph-safe —
   * only invoked via x-on:click in templates, never via addEventListener.
   * No-op for null/missing id or absent DOM element (e.g. filtered out).
   */
  jumpToFact(id: string | null): void;
}

/**
 * Factory for the memoryBook Alpine data object.
 * Exported for direct unit-testing (no Alpine runtime required).
 */
export function makeMemoryBookData(): MemoryBookData {
  // Non-reactive toast timer handle.
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    memories: [] as MemoryEventClient[],
    recentChats: [] as RecentChatClient[],
    workingCount: 0,
    secret: "",
    todayKey: "",
    view: "timeline" as "timeline" | "byType" | "entity",
    filterType: "" as MemoryType | "",
    filterStatus: "" as MemoryStatus | "",
    sortDesc: true,
    modalType: "" as ModalType,
    chat: "",
    proposal: null as Proposal | null,
    parsing: false,
    toast: null as string | null,
    _recapFetched: false,

    TYPE_COLORS: {
      semantic: TYPE_META.semantic.color,
      episodic: TYPE_META.episodic.color,
      procedural: TYPE_META.procedural.color,
    },

    STATUS_COLORS: {
      active: STATUS_META.active.ink,
      pending: STATUS_META.pending.ink,
      retired: STATUS_META.retired.ink,
    },

    init() {
      const el = (this as unknown as { $el: HTMLElement }).$el;
      try {
        this.memories = JSON.parse(
          el.dataset.memories ?? "[]",
        ) as MemoryEventClient[];
      } catch {
        this.memories = [];
      }
      try {
        this.recentChats = JSON.parse(
          el.dataset.recentChats ?? "[]",
        ) as RecentChatClient[];
      } catch {
        this.recentChats = [];
      }
      this.workingCount = this.recentChats.length;
      this.secret = el.dataset.secret ?? "";
      // todayKey is the only impure read — kept here, never inside pure helpers.
      // Use localDateKey (not toISOString) so grouping matches the browser's TZ.
      this.todayKey = localDateKey(new Date());
    },

    filteredMemories(): MemoryEventClient[] {
      return sortMemories(
        filterMemories(this.memories, this.filterType, this.filterStatus),
        this.sortDesc,
      );
    },

    groups(): MemoryGroup[] {
      // Pass the full memories list so decorateRow can resolve supersede partner
      // texts even when filtering hides the partner from the visible set.
      return groupByDate(this.filteredMemories(), this.todayKey, this.memories);
    },

    byEntityGroups(): EntityMemoryGroup[] {
      return groupMemoriesByEntity(this.filteredMemories(), this.memories);
    },

    memoriesForModal(): DecoratedRow[] {
      if (this.modalType === "" || this.modalType === "working") return [];
      const modalType = this.modalType as MemoryType;
      const all = this.memories;
      // Drill-down modal = "what siltpoke currently knows" → active only.
      // Retired facts stay reachable via the timeline view's status chip.
      return sortMemories(
        this.memories.filter(
          (m) => m.type === modalType && m.status === "active",
        ),
        true,
      ).map((m) => decorateRow(m, all));
    },

    samples(type: MemoryType): DecoratedRow[] {
      const all = this.memories;
      // Card preview = active only (mirrors the active-only drill-down modal).
      return sortMemories(
        this.memories.filter((m) => m.type === type && m.status === "active"),
        true,
      )
        .slice(0, 2)
        .map((m) => decorateRow(m, all));
    },

    countByType(type: MemoryType): number {
      // Timeline filter-bar chip count = TOTAL (all statuses) so the chip number
      // matches the row count you see after clicking it. The by-type CARD uses
      // countActiveByType instead (active-only).
      return countByType(this.memories, type);
    },

    countActiveByType(type: MemoryType): number {
      // By-type card count = active-only sum (retired excluded; still reachable
      // via the timeline status chip). Mirrors memoriesForModal + samples.
      return countByType(
        this.memories.filter((m) => m.status === "active"),
        type,
      );
    },

    emptyMessage(): string {
      if (this.filterType === "procedural") {
        return "0 rules — I'll write one when I notice you repeat a preference";
      }
      if (this.filterType === "semantic") {
        return "0 facts — info I extract from your conversations about your preferences and background shows here";
      }
      if (this.filterType === "episodic") {
        return "0 episodes — key conversation moments worth recording accumulate here";
      }
      if (this.memories.length === 0) {
        return "no memories yet";
      }
      return "no memories match these filters";
    },

    modalTypeLabel(): string {
      const labels: Record<string, string> = {
        semantic: "Semantic",
        episodic: "Episodic",
        procedural: "Procedural",
        working: "Working",
      };
      return labels[this.modalType] ?? "";
    },

    modalTitle(): string {
      const m = MODAL_META[this.modalType as MemoryType | "working"];
      return m ? m.title : "";
    },
    modalEn(): string {
      const m = MODAL_META[this.modalType as MemoryType | "working"];
      return m ? m.en : "";
    },
    modalDesc(): string {
      const m = MODAL_META[this.modalType as MemoryType | "working"];
      return m ? m.desc : "";
    },
    modalColor(): string {
      const m = MODAL_META[this.modalType as MemoryType | "working"];
      return m ? m.color : tokens.color.ink3;
    },

    modalEmptyMessage(): string {
      const messages: Record<string, string> = {
        procedural: "0 rules — I'll write one when I notice you repeat a preference",
        semantic:
          "0 facts — info I extract from your conversations about your preferences and background shows here",
        episodic: "0 episodes — key conversation moments worth recording accumulate here",
      };
      return messages[this.modalType] ?? "";
    },

    setView(view: "timeline" | "byType" | "entity"): void {
      this.view = view;
    },

    setFilterType(type: MemoryType | ""): void {
      this.filterType = type;
    },

    setFilterStatus(status: MemoryStatus | ""): void {
      this.filterStatus = status;
    },

    toggleSort(): void {
      this.sortDesc = !this.sortDesc;
    },

    sortLabel(): string {
      return this.sortDesc ? "Newest → Oldest" : "Oldest → Newest";
    },

    openModal(type: ModalType): void {
      this.modalType = type;
      // Lazy cross-chat recap: fire-and-forget on first "working"
      // open only (guarded by _recapFetched). Alpine calls openModal
      // synchronously from a template click handler, so this must NOT be
      // awaited here — the modal opens immediately with placeholder
      // summaries, then the recap list patches in place once the fetch
      // resolves.
      if (type === "working" && !this._recapFetched) {
        this._recapFetched = true;
        void this._fetchRecaps();
      }
    },

    closeModal(): void {
      this.modalType = "";
    },

    /**
     * POST /api/chat/recap-recent and patch matching `recentChats`
     * entries by id with the real recap. Sends the ids of the chats THIS panel
     * is displaying so the server recaps exactly what the user sees (not an
     * independently-picked newest-N that can diverge from the panel's own
     * selection). Self-gates budget/quiet hours server-side. Fail-open: any
     * error (network, non-ok, bad JSON) is swallowed — the deterministic
     * placeholder summaries stay as-is.
     */
    async _fetchRecaps(): Promise<void> {
      try {
        const ids = this.recentChats.map((c) => c.id);
        const res = await fetch("/api/chat/recap-recent", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Siltpoke-Secret": this.secret },
          body: JSON.stringify({ ids }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          recapped: Array<{ id: string; summary: string }>;
        };
        const byId = new Map(data.recapped.map((r) => [r.id, r.summary]));
        this.recentChats = this.recentChats.map((c) => {
          const summary = byId.get(c.id);
          return summary === undefined ? c : { ...c, summary };
        });
      } catch (err) {
        console.error("[memoryBook] recap fetch error:", err);
      }
    },

    /**
     * Free-NL composer entry. The deterministic 忘掉/forget fast-path stays
     * ($0, no LLM): a pure retire is matched synchronously by buildProposal.
     * Any OTHER text is sent to POST /api/facts/parse for an LLM-classified
     * proposal (add / restate / contradict). The parse call is gated — a
     * budget/quiet-hours pause surfaces an honest  toast, never a write.
     */
    async sendChat(): Promise<void> {
      // Guard against double-submit while a parse call is in flight (the Enter
      // key can fire even with the send button disabled).
      if (this.parsing) return;
      const t = this.chat.trim();
      if (!t) return;
      this.chat = "";

      // Deterministic forget fast-path — no LLM, no network.
      if (/忘掉|忘记|退休|forget/i.test(t)) {
        this.proposal = buildProposal(t, this.memories);
        return;
      }

      // Otherwise: LLM intent parse.
      this.parsing = true;
      try {
        const res = await fetch("/api/facts/parse", {
          method: "POST",
          headers: {
            "X-Siltpoke-Secret": this.secret,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text: t }),
        });
        if (!res.ok) {
          this.flashToast("Couldn't parse that — try again");
          return;
        }
        const data = (await res.json()) as ParseResponse | PausedResponse;
        if ("paused" in data && data.paused) {
          this.flashToast("Paused · budget or quiet hours, try later");
          return;
        }
        const parsed = data as ParseResponse;
        this.proposal = {
          actionable: true,
          detail: parsed.candidate,
          classification: parsed.classification,
          candidate: parsed.candidate,
          confidence: parsed.confidence,
          targetFactId: parsed.targetFactId ?? undefined,
          contradictedText: parsed.contradictedFact?.text,
          sourceText: t,
        };
      } catch (err) {
        console.error("[memoryBook] parse error:", err);
        this.flashToast("Couldn't parse that — try again");
      } finally {
        this.parsing = false;
      }
    },

    async confirmProposal(): Promise<void> {
      const p = this.proposal;
      if (!p?.actionable || !p.factId) return;
      const ok = await this.retireFact(p.factId);
      if (!ok) {
        // Keep the proposal so the user can retry the same ✓确认 click.
        this.flashToast("Something went wrong · couldn't update this memory, try later");
        return;
      }
      this.proposal = null;
      this.flashToast("Confirmed · memory updated ✓");
    },

    cancelProposal(): void {
      this.proposal = null;
    },

    /**
     * Shared helper for the create paths (add / replace / keep-both). POSTs the
     * draft to /api/facts; on 201 appends the returned (pending) fact to the
     * local timeline immutably and returns true. On any failure logs + returns
     * false (caller surfaces an honest toast; timeline unchanged). Internal —
     * not on the public interface.
     */
    async _createFact(body: {
      text: string;
      confidence?: number;
      supersedes?: string;
      save_reason?: string;
    }): Promise<boolean> {
      try {
        const res = await fetch(`/api/facts${writeRepoQuery()}`, {
          method: "POST",
          headers: {
            "X-Siltpoke-Secret": this.secret,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          console.error("[memoryBook] create failed:", res.status);
          return false;
        }
        const json = (await res.json()) as {
          fact: {
            id: string;
            text: string;
            created_at: string;
            save_reason: string | null;
          };
        };
        const f = json.fact;
        this.memories = [
          ...this.memories,
          {
            id: f.id,
            ts: f.created_at,
            type: "semantic" as MemoryType,
            text: f.text,
            why: f.save_reason ?? null,
            status: "pending" as MemoryStatus,
          },
        ];
        return true;
      } catch (err) {
        console.error("[memoryBook] create error:", err);
        return false;
      }
    },

    /**
     * Confirm an "add" proposal → POST /api/facts {text, confidence}. New fact
     * lands pending (re-approved via the ✓确认 button). On success appends
     * the row + toast + clears the proposal; on failure the proposal is kept for
     * retry with an honest toast.
     */
    async confirmAdd(): Promise<void> {
      const p = this.proposal;
      if (!p?.candidate) return;
      const ok = await this._createFact({
        text: p.candidate,
        confidence: p.confidence,
        save_reason: p.sourceText ? `You added manually: ${p.sourceText}` : undefined,
      });
      if (!ok) {
        this.flashToast("Something went wrong · couldn't save it, try later");
        return;
      }
      this.proposal = null;
      this.flashToast("Saved · awaiting your confirmation ✓");
    },

    /**
     * Confirm a "restate" proposal → POST /api/facts/:id/restate. Reconfirms an
     * existing fact (pending → active, or active clocks refreshed). On success
     * flips the row to active + toast + clears the proposal.
     */
    async confirmRestate(id: string): Promise<void> {
      try {
        const res = await fetch(`/api/facts/${id}/restate${writeRepoQuery()}`, {
          method: "POST",
          headers: { "X-Siltpoke-Secret": this.secret },
        });
        if (!res.ok) {
          console.error("[memoryBook] restate failed:", res.status);
          this.flashToast("Something went wrong · couldn't reaffirm this, try later");
          return;
        }
        // Use the returned fact to update the LIVE badge — recall_count and
        // last_confirmed_at advance on every reaffirm, so ★重申 ×N · date must
        // reflect the new values without a page reload.
        const json = (await res.json()) as {
          fact: { recall_count: number; last_confirmed_at: string | null };
        };
        this.memories = this.memories.map((m) =>
          m.id === id
            ? {
                ...m,
                status: "active" as MemoryStatus,
                recall_count: json.fact.recall_count,
                last_confirmed_at: json.fact.last_confirmed_at,
              }
            : m,
        );
        this.proposal = null;
        this.flashToast("Reaffirmed · this memory was confirmed again ✓");
      } catch (err) {
        console.error("[memoryBook] restate error:", err);
        this.flashToast("Something went wrong · couldn't reaffirm this, try later");
      }
    },

    /**
     * Contradiction → 替换 (replace). POST /api/facts {text, supersedes: oldId}.
     * New fact lands pending with a supersede link; the old fact stays active
     * until the new one is approved. On success appends the new pending row
     * + toast + clears the proposal.
     */
    async confirmReplace(oldId: string): Promise<void> {
      const p = this.proposal;
      if (!p?.candidate) return;
      const ok = await this._createFact({
        text: p.candidate,
        confidence: p.confidence,
        supersedes: oldId,
        save_reason: p.sourceText ? `You added manually: ${p.sourceText}` : undefined,
      });
      if (!ok) {
        this.flashToast("Something went wrong · couldn't replace, try later");
        return;
      }
      this.proposal = null;
      this.flashToast("Replacement proposed · the old one retires once you confirm the new memory ✓");
    },

    /**
     * Contradiction → 两条都留 (keep both). POST /api/facts {text} with NO
     * supersede link — the coexistence escape hatch. On success appends the
     * new pending row + toast + clears the proposal.
     */
    async keepBoth(): Promise<void> {
      const p = this.proposal;
      if (!p?.candidate) return;
      const ok = await this._createFact({
        text: p.candidate,
        confidence: p.confidence,
        save_reason: p.sourceText ? `You added manually: ${p.sourceText}` : undefined,
      });
      if (!ok) {
        this.flashToast("Something went wrong · couldn't save it, try later");
        return;
      }
      this.proposal = null;
      this.flashToast("Keeping both · new memory awaiting your confirmation ✓");
    },

    flashToast(msg: string): void {
      if (toastTimer) clearTimeout(toastTimer);
      this.toast = msg;
      toastTimer = setTimeout(() => {
        this.toast = null;
      }, 1900);
    },

    /**
     * Real soft-retire — NO confirm dialog (the ✓确认 click IS the
     * confirmation). POSTs to /api/facts/:id/retire with the daemon secret.
     * On 200, flips that fact's status to "retired" immutably (soft delete —
     * the row stays) and returns true. On any failure, logs, leaves the row
     * unchanged, and returns false so the caller can surface an honest error.
     *
     * Live action-log: uses server-returned fact.events (authoritative full
     * history). Falls back to optimistic append when the response body is
     * absent or malformed so the log still updates immediately.
     */
    async retireFact(id: string): Promise<boolean> {
      try {
        const res = await fetch(`/api/facts/${id}/retire${writeRepoQuery()}`, {
          method: "POST",
          headers: { "X-Siltpoke-Secret": this.secret },
        });
        if (!res.ok) {
          console.error("[memoryBook] retire failed:", res.status);
          return false;
        }
        // Prefer server-authoritative events; fall back to optimistic append.
        let serverEvents: FactEvent[] | null = null;
        try {
          const json = (await res.json()) as { fact?: { events?: FactEvent[] } };
          const evs = json?.fact?.events;
          if (Array.isArray(evs)) serverEvents = evs;
        } catch {
          // Null body or unparseable JSON — use optimistic fallback below.
        }
        const nowISO = new Date().toISOString();
        this.memories = this.memories.map((m) => {
          if (m.id !== id) return m;
          return {
            ...m,
            status: "retired" as MemoryStatus,
            events: serverEvents ?? [
              ...(m.events ?? []),
              { action: "retired", at: nowISO, reason: "user_rejected" } satisfies FactEvent,
            ],
          };
        });
        return true;
      } catch (err) {
        console.error("[memoryBook] retire error:", err);
        return false;
      }
    },

    /**
     * Reactivate a retired fact — undo a retire (retired → active). POSTs to
     * /api/facts/:id/reactivate. On 200, flips that fact's status back to
     * "active" immutably; on failure, logs + honest toast, row unchanged.
     *
     * Live action-log: appends a "reactivated" event using the server-returned
     * fact.events (authoritative). Optimistic fallback if body is absent.
     */
    async reactivateFact(id: string): Promise<void> {
      try {
        const res = await fetch(`/api/facts/${id}/reactivate${writeRepoQuery()}`, {
          method: "POST",
          headers: { "X-Siltpoke-Secret": this.secret },
        });
        if (!res.ok) {
          console.error("[memoryBook] reactivate failed:", res.status);
          this.flashToast("Something went wrong · couldn't undo retire, try later");
          return;
        }
        // Prefer server-authoritative events; fall back to optimistic append.
        let serverEvents: FactEvent[] | null = null;
        try {
          const json = (await res.json()) as { fact?: { events?: FactEvent[] } };
          const evs = json?.fact?.events;
          if (Array.isArray(evs)) serverEvents = evs;
        } catch {
          // Null body or unparseable JSON — use optimistic fallback below.
        }
        const nowISO = new Date().toISOString();
        this.memories = this.memories.map((m) => {
          if (m.id !== id) return m;
          return {
            ...m,
            status: "active" as MemoryStatus,
            events: serverEvents ?? [
              ...(m.events ?? []),
              { action: "reactivated", at: nowISO, reason: null } satisfies FactEvent,
            ],
          };
        });
        this.flashToast("Undo retire done · this memory is active again ✓");
      } catch (err) {
        console.error("[memoryBook] reactivate error:", err);
        this.flashToast("Something went wrong · couldn't undo retire, try later");
      }
    },

    /**
     * Approve a pending fact — pending → active. POSTs to
     * /api/facts/:id/approve. On 200, flips that fact's status to "active"
     * immutably + toast; on failure, logs + honest toast, row unchanged.
     *
     * Live action-log: appends an "approved" event using the server-returned
     * fact.events (authoritative). Optimistic fallback if body is absent.
     */
    async approveFact(id: string): Promise<void> {
      try {
        const res = await fetch(`/api/facts/${id}/approve${writeRepoQuery()}`, {
          method: "POST",
          headers: { "X-Siltpoke-Secret": this.secret },
        });
        if (!res.ok) {
          console.error("[memoryBook] approve failed:", res.status);
          this.flashToast("Something went wrong · couldn't confirm this memory, try later");
          return;
        }
        // Prefer server-authoritative events; fall back to optimistic append.
        let serverEvents: FactEvent[] | null = null;
        try {
          const json = (await res.json()) as { fact?: { events?: FactEvent[] } };
          const evs = json?.fact?.events;
          if (Array.isArray(evs)) serverEvents = evs;
        } catch {
          // Null body or unparseable JSON — use optimistic fallback below.
        }
        const nowISO = new Date().toISOString();
        this.memories = this.memories.map((m) => {
          if (m.id !== id) return m;
          return {
            ...m,
            status: "active" as MemoryStatus,
            events: serverEvents ?? [
              ...(m.events ?? []),
              { action: "approved", at: nowISO, reason: null } satisfies FactEvent,
            ],
          };
        });
        this.flashToast("Confirmed · this memory is now active ✓");
      } catch (err) {
        console.error("[memoryBook] approve error:", err);
        this.flashToast("Something went wrong · couldn't confirm this memory, try later");
      }
    },

    /**
     * Re-tag click — cycle a fact's kind: style→profile, profile→style,
     * untagged→style. The click moves the critic's recall input (style facts shape
     * critiques; profile facts stay chat-only).
     */
    cycleFactKind(event: { id: string; kind?: "style" | "profile" | null }): void {
      const next: "style" | "profile" = event.kind === "style" ? "profile" : "style";
      void this.setFactKind(event.id, next);
    },

    /**
     * Persist a fact's new kind (POST /api/facts/:id/kind) and flip the row on
     * 200 only (mirror approveFact: optimistic update gated on success, never
     * before the server confirms). Idempotent on the server (same kind → no write).
     */
    async setFactKind(id: string, kind: "style" | "profile"): Promise<void> {
      try {
        const res = await fetch(`/api/facts/${id}/kind${writeRepoQuery()}`, {
          method: "POST",
          headers: {
            "X-Siltpoke-Secret": this.secret,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ kind }),
        });
        if (!res.ok) {
          console.error("[memoryBook] set-kind failed:", res.status);
          this.flashToast("Something went wrong · couldn't re-tag this memory, try later");
          return;
        }
        this.memories = this.memories.map((m) => (m.id === id ? { ...m, kind } : m));
        this.flashToast(
          kind === "style"
            ? "Re-tagged 🎯 style · shapes your reviews"
            : "Re-tagged 🪪 profile · chat-only",
        );
      } catch (err) {
        console.error("[memoryBook] set-kind error:", err);
        this.flashToast("Something went wrong · couldn't re-tag this memory, try later");
      }
    },

    /**
     * Persist a fact's pinned flag (POST /api/facts/:id/pin) and flip the row
     * on 200 only (mirror setFactKind: optimistic update gated on success,
     * never before the server confirms — row stays unchanged on failure, the
     * effective "rollback"). Idempotent on the server (unchanged pinned →
     * no write). Wires the manual decay-protection affordance
     * (setFactPinnedCore) onto the fact row.
     */
    async setPinned(id: string, pinned: boolean): Promise<void> {
      try {
        const res = await fetch(`/api/facts/${id}/pin${writeRepoQuery()}`, {
          method: "POST",
          headers: {
            "X-Siltpoke-Secret": this.secret,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ pinned }),
        });
        if (!res.ok) {
          console.error("[memoryBook] set-pinned failed:", res.status);
          this.flashToast(
            "Something went wrong · couldn't update pin status, try later",
          );
          return;
        }
        this.memories = this.memories.map((m) => (m.id === id ? { ...m, pinned } : m));
        this.flashToast(
          pinned ? "📌 Pinned · protected from decay" : "Unpinned · decay rules apply again",
        );
      } catch (err) {
        console.error("[memoryBook] set-pinned error:", err);
        this.flashToast("Something went wrong · couldn't update pin status, try later");
      }
    },

    /**
     * Reject a pending fact — same soft-retire mutation as retireFact (the
     * backend has no distinct "reject"; rejection IS a user_rejected retire),
     * with a reject-flavoured toast. Delegates to retireFact for the real POST
     * so the wiring stays in one place.
     */
    async rejectFact(id: string): Promise<void> {
      const ok = await this.retireFact(id);
      this.flashToast(
        ok ? "Rejected · this memory won't be kept" : "Something went wrong · couldn't reject this memory, try later",
      );
    },

    /**
     * Delete (soft-retire) an ACTIVE fact from its row — same retire mutation,
     * delete-flavoured toast. The row stays as 退休 and is reversible via the
     * 撤回退休 button, so "delete" is never destructive.
     */
    async deleteFact(id: string): Promise<void> {
      const ok = await this.retireFact(id);
      this.flashToast(
        ok ? "🗑 Deleted · can be undone from Retired" : "Something went wrong · couldn't delete, try later",
      );
    },

    /**
     * Scroll the partner fact's card into view and add a transient highlight
     * ring (memory-row-highlight class, removed after 1.5 s).
     * Morph-safe: invoked only via x-on:click in templates, never addEventListener.
     * No-op when id is null/falsy, document is absent (SSR/unit-test), or the
     * target element is not currently in the DOM (filtered / not rendered).
     */
    jumpToFact(id: string | null): void {
      if (!id || typeof document === "undefined") return;
      const el = document.querySelector(`[data-event-id="${id}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("memory-row-highlight");
      setTimeout(() => el.classList.remove("memory-row-highlight"), 1500);
    },
  };
}

// Guard: only register in browser context.
if (typeof document !== "undefined") {
  document.addEventListener("alpine:init", () => {
    globalThis.Alpine.data("memoryBook", () => makeMemoryBookData());
  });
}

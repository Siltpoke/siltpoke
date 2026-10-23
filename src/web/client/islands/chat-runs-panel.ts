// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Chat Runs window — the right half of the chat panel (spec
 * 2026-10-13-agent-in-use-truth §10.1). Plain DOM, not Alpine templates:
 *
 *   - selecting a run only moves a class, it never re-renders (spec: a
 *     re-render reset what she had opened, mock v6);
 *   - a new record is APPENDED as a new row; rows already on screen are
 *     kept as they are, with whatever is open inside them.
 *
 * The chat island owns when to load (open / new `run` event / conversation
 * switch); this file owns what the pane shows.
 */
import { runRowHtml } from "../lib/chat-runs-render";
import { buildRunView, type ChatRun, type RunView } from "../lib/chat-runs-view";

export interface RunsPanelDeps {
  fetchFn: typeof fetch;
  secret: () => string;
  /** A row was clicked: the chat side highlights this answer. */
  onPick: (messageId: string) => void;
}

export interface RunsPanel {
  /** Show one conversation's records (null = none yet). Resets the list only
   * when the conversation changed; otherwise appends what is new. */
  load(sessionId: string | null): Promise<void>;
  /** Highlight the row of this answer. Returns false when it has no record. */
  select(messageId: string | null): boolean;
}

const NO_RECORD =
  "No record for this answer. Chat calls are recorded since 2026-10-14; older answers have none, and a conversation's records are deleted after 30 days without a new call.";

export function mountRunsPanel(root: HTMLElement, deps: RunsPanelDeps): RunsPanel {
  const list = root.querySelector<HTMLElement>("[data-runs-list]");
  const sub = root.querySelector<HTMLElement>("[data-runs-sub]");
  const note = root.querySelector<HTMLElement>("[data-runs-note]");
  const views = new Map<string, RunView>();
  let session: string | null = null;
  let selected: string | null = null;
  let loadSeq = 0;

  function setSub(text: string): void {
    if (sub) sub.textContent = text;
  }

  function setNote(text: string | null): void {
    if (!note) return;
    note.textContent = text ?? "";
    note.hidden = text === null;
  }

  function rowFor(messageId: string): HTMLElement | null {
    return list?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`) ?? null;
  }

  function paintSelection(): void {
    list?.querySelectorAll<HTMLElement>(".cr-run").forEach((el) => {
      el.classList.toggle("cr-sel", el.dataset.messageId === selected);
    });
  }

  function appendRows(runs: ChatRun[]): void {
    if (!list) return;
    runs.forEach((run, i) => {
      if (list.querySelector(`[data-run-id="${CSS.escape(run.run_id)}"]`)) return;
      const row = document.createElement("div");
      row.className = "cr-run";
      row.tabIndex = 0;
      row.dataset.runId = run.run_id;
      row.dataset.messageId = run.message_id;
      try {
        const view = buildRunView(run, i);
        views.set(run.run_id, view);
        row.innerHTML = runRowHtml(view);
      } catch (err) {
        // One record this window cannot read must not hide the others.
        row.innerHTML = `<div class="cr-l1"><span class="cr-n">#${i + 1}</span><span class="cr-st cr-bad">?</span></div><div class="cr-note"></div>`;
        const note = row.querySelector(".cr-note");
        if (note) note.textContent = `This record could not be shown: ${err instanceof Error ? err.message : String(err)}`;
      }
      list.appendChild(row);
    });
    paintSelection();
  }

  function clearRows(): void {
    views.clear();
    if (list) list.textContent = "";
  }

  function summary(): void {
    const n = list?.children.length ?? 0;
    setSub(session === null ? "No conversation yet" : `This conversation · ${n} call${n === 1 ? "" : "s"}`);
    if (n === 0 && session !== null && (note?.hidden ?? true)) {
      setNote("No calls recorded in this conversation yet.");
    }
  }

  async function load(sessionId: string | null): Promise<void> {
    const seq = ++loadSeq;
    if (sessionId !== session) {
      clearRows();
      session = sessionId;
    }
    setNote(null);
    if (sessionId === null) {
      summary();
      return;
    }
    // Called as a plain function: `deps.fetchFn(…)` would run the browser's
    // fetch with `this = deps`, which it rejects ("Illegal invocation").
    const fetchFn = deps.fetchFn;
    let runs: ChatRun[];
    try {
      const res = await fetchFn(`/api/chat/sessions/${encodeURIComponent(sessionId)}/runs`, {
        headers: { "X-Siltpoke-Secret": deps.secret() },
      });
      if (seq !== loadSeq) return;
      if (!res.ok) {
        setNote(`Could not load the records (HTTP ${res.status}).`);
        summary();
        return;
      }
      const body = (await res.json()) as { runs?: ChatRun[] };
      runs = Array.isArray(body.runs) ? body.runs : [];
    } catch {
      if (seq !== loadSeq) return;
      setNote("Could not load the records (the dashboard server did not answer).");
      summary();
      return;
    }
    if (seq !== loadSeq) return;
    appendRows(runs);
    summary();
  }

  function select(messageId: string | null): boolean {
    selected = messageId;
    paintSelection();
    const row = messageId ? rowFor(messageId) : null;
    if (messageId !== null && row === null) setNote(NO_RECORD);
    else if (note?.textContent === NO_RECORD) setNote(null);
    row?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    return row !== null;
  }

  async function copy(btn: HTMLElement, text: string): Promise<void> {
    const before = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Copy failed; select the text instead";
    }
    setTimeout(() => {
      btn.textContent = before;
    }, 1600);
  }

  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>(".cr-run");
    if (!target || !row) return;
    const view = views.get(row.dataset.runId ?? "");

    const copyBtn = target.closest<HTMLElement>("[data-copy]");
    if (copyBtn && view) {
      ev.preventDefault();
      ev.stopPropagation();
      const kind = copyBtn.dataset.copy;
      void copy(copyBtn, kind === "prompt" ? view.wholePrompt : kind === "output" ? view.rawOutput : view.rawRecord);
      return;
    }
    const stepsBtn = target.closest<HTMLElement>("[data-steps]");
    if (stepsBtn) {
      // The links sit in the "What happened" summary: stop the click from
      // toggling it, and open it when "Open all" is pressed.
      ev.preventDefault();
      ev.stopPropagation();
      const open = stepsBtn.dataset.steps === "open";
      const what = stepsBtn.closest("details");
      if (what && open) what.open = true;
      row.querySelectorAll<HTMLDetailsElement>(".cr-evd").forEach((d) => {
        d.open = open;
      });
      return;
    }
    const raw = target.closest<HTMLElement>(".cr-rawbtn");
    if (raw) {
      ev.preventDefault();
      ev.stopPropagation();
      const pre = raw.nextElementSibling as HTMLElement | null;
      if (pre) {
        pre.hidden = !pre.hidden;
        raw.setAttribute("aria-expanded", String(!pre.hidden));
      }
      return;
    }
    if (target.closest("details")) return;
    const id = row.dataset.messageId ?? null;
    select(id);
    if (id) deps.onPick(id);
  });

  root.addEventListener("keydown", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (ev.key !== "Enter" || !target?.classList.contains("cr-run")) return;
    const id = target.dataset.messageId ?? null;
    select(id);
    if (id) deps.onPick(id);
  });

  return { load, select };
}

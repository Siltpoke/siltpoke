// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * since-you-looked island — the "Since you last looked" discovery panel
 * (slice ③, task 6). Renders every dynamic node IMPERATIVELY against the
 * `#syl-*` ids `SinceYouLookedPanel.tsx` sets up, the same split as
 * `islands/repo-graph.ts` (server renders the shell, the island owns live
 * content) — chosen over declarative `x-for`/`x-show` so a DOM-mount test
 * can call the factory's `init()` directly (no real `Alpine.start()` loop
 * required) and dispatch real `click`/`keydown` events against the row
 * disclosure nodes it builds. See
 * `tests/web/client/islands/since-you-looked.test.ts`.
 *
 * Gesture contract (binding correction, NOT the brief's original prose):
 * the ONLY fetch `init()` fires is the lazy `GET /seen`. The advance POST
 * (`POST /seen/advance`) and the mark-all POST (`POST /seen/mark-all`) are
 * bound EXCLUSIVELY to a `click` or `keydown`(Enter|Space) listener attached
 * to a row's disclosure control / the mark-all button — never `x-init`,
 * never a mount-effect, never an `IntersectionObserver` or scroll listener.
 * After either POST succeeds, the island re-fetches `GET /seen` so the
 * panel reflects the change (the advanced row disappears) — never a local
 * splice, so the panel can never drift from the server's own classification.
 *
 * Discovery framing: `statusTag` returns neutral prose ("signature changed
 * · body changed" / "new to you" / "deleted"), never a score or an urgency
 * word. `groupByDirectory` is the ONLY grouping rule — no severity sort.
 *
 * Slice ④ (task 6): each row also renders a WHY cell (`whyCopy`) from the
 * `why: WhyAnchor` the real `GET /seen` route now attaches per delta
 * (`../../../daemon/routes/seen-why.ts`). `why` is OPTIONAL on the wire
 * type here (not on the real route's response, but on this file's own
 * `SeenApiData` — kept optional so older/defensive payloads without it
 * still render, degrading to the same "no WHY recorded" copy as rung 3).
 * Honest-anchor copy only — "you asked: …" / "changed in session …", never
 * a causal claim like "the reason was …".
 */
import type { StalenessVerdict } from "../../../repo-graph/staleness-verdict";
import type { SeenFileDelta } from "../../../repo-graph/types";
import type { WhyAnchor } from "../../../repo-graph/why-lookup";

/** A `SeenFileDelta` with the WHY anchor the real route attaches (slice ④). */
export type SeenFileDeltaWithWhy = SeenFileDelta & { why?: WhyAnchor };

export interface SeenApiData {
  unknown_baseline: boolean;
  staleness: StalenessVerdict;
  deltas: SeenFileDeltaWithWhy[];
}

// ── Pure helpers (exported for direct, DOM-free testing) ────────────────────

/** Repo-relative directory of `path`, trailing slash included; "" at repo root. */
export function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx + 1);
}

/** The path's final segment (filename), for the row's visible label. */
export function baseNameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Neutral status prose for one delta — no score, no "missed"/"unreviewed",
 * no urgency word. `tracked` composes signature/body into one tag;
 * `new_to_you`/`deleted` are their own tag. `unparseable` appends a plain
 * caveat, never a color or an exclamation.
 */
export function statusTag(delta: SeenFileDelta): string {
  if (delta.baseline_status === "new_to_you") {
    return delta.unparseable ? "new to you · unparseable" : "new to you";
  }
  if (delta.baseline_status === "deleted") {
    return delta.unparseable ? "deleted · unparseable" : "deleted";
  }
  const parts: string[] = [];
  if (delta.signature_changed) parts.push("signature changed");
  if (delta.body_changed) parts.push("body changed");
  if (parts.length === 0) parts.push("changed"); // defensive: classifyAll never emits this case
  if (delta.unparseable) parts.push("unparseable");
  return parts.join(" · ");
}

/**
 * Honest-anchor WHY copy for one delta's `why: WhyAnchor` — the 4 states
 * `lookupWhy` can return, rendered as prose (never a causal claim):
 *   - rung "U": changed on disk, not yet committed.
 *   - rung 1:   anchored to the exact turn — quotes the user's ask.
 *   - rung 2:   anchored to a session, not a specific turn — points at the
 *               transcript rather than guessing which turn.
 *   - rung 3 (or `why` absent/degraded): no WHY recorded.
 */
export function whyCopy(why: WhyAnchor | undefined): string {
  if (!why) return "no WHY recorded";
  if (why.rung === "U") return "changed on disk · not yet committed";
  if (why.rung === 1) return `you asked: "${why.user_ask ?? ""}"`;
  if (why.rung === 2) return `changed in session ${why.session_id ?? "?"} · open transcript`;
  return "no WHY recorded";
}

/** Group deltas by directory, each group's files sorted by full path;
 *  groups sorted lexically ("" — repo root — sorts first). The ONLY
 *  grouping/ordering rule — no severity-based reordering. */
export function groupByDirectory<T extends SeenFileDelta>(deltas: T[]): Array<{ dir: string; files: T[] }> {
  const map = new Map<string, T[]>();
  for (const delta of deltas) {
    const dir = dirOf(delta.path);
    const list = map.get(dir);
    if (list) {
      list.push(delta);
    } else {
      map.set(dir, [delta]);
    }
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, files]) => ({ dir, files: [...files].sort((a, b) => a.path.localeCompare(b.path)) }));
}

// ── DOM refs + imperative render ─────────────────────────────────────────────

interface Refs {
  loading: HTMLElement;
  error: HTMLElement;
  banner: HTMLElement;
  empty: HTMLElement;
  body: HTMLElement;
  staleness: HTMLElement;
  markAllBtn: HTMLButtonElement;
}

function getRefs(root: HTMLElement): Refs | null {
  const q = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>(`#${id}`);
  const loading = q<HTMLElement>("syl-loading");
  const error = q<HTMLElement>("syl-error");
  const banner = q<HTMLElement>("syl-banner");
  const empty = q<HTMLElement>("syl-empty");
  const body = q<HTMLElement>("syl-body");
  const staleness = q<HTMLElement>("syl-staleness");
  const markAllBtn = q<HTMLButtonElement>("syl-mark-all");
  if (!loading || !error || !banner || !empty || !body || !staleness || !markAllBtn) return null;
  return { loading, error, banner, empty, body, staleness, markAllBtn };
}

/**
 * The WHY cell (slice ④) — an anchor `<a>` only for rung 2 (points at the
 * transcript file), a plain `<span>` for every other state. Honest copy
 * from `whyCopy`; rung 1's full `user_ask` goes on the `title` attribute
 * (same "quote in the tooltip, short prose inline" pattern the brief's SSR
 * `WhyCell` used) since the inline text is already the quote itself here.
 */
function buildWhyCell(why: WhyAnchor | undefined): HTMLElement {
  const isSession = why?.rung === 2 && !!why.transcript_path;
  const el = document.createElement(isSession ? "a" : "span");
  el.className = "syl-row-why";
  el.textContent = whyCopy(why);
  if (isSession) (el as HTMLAnchorElement).href = `file://${why.transcript_path}`;
  if (why?.rung === 1 && why.user_ask) el.title = why.user_ask;
  return el;
}

function buildRow(delta: SeenFileDeltaWithWhy, onActivate: (path: string) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "syl-row";
  row.dataset.path = delta.path;

  const pathEl = document.createElement("span");
  pathEl.className = "syl-row-path";
  pathEl.textContent = baseNameOf(delta.path);
  row.appendChild(pathEl);

  const tagEl = document.createElement("span");
  tagEl.className = "syl-row-tag";
  tagEl.textContent = statusTag(delta);
  row.appendChild(tagEl);

  row.appendChild(buildWhyCell(delta.why));

  // Custom disclosure control (role=button + tabindex + explicit keydown) —
  // same accessible-custom-control shape as ActiveReposPanel's row header.
  // Gesture contract: click OR keydown(Enter|Space) — nothing else.
  const disclosure = document.createElement("div");
  disclosure.className = "syl-row-disclosure";
  disclosure.setAttribute("role", "button");
  disclosure.setAttribute("tabindex", "0");
  disclosure.dataset.path = delta.path;
  disclosure.textContent = "mark seen";
  const activate = (e: Event): void => {
    e.preventDefault();
    onActivate(delta.path);
  };
  disclosure.addEventListener("click", activate);
  disclosure.addEventListener("keydown", (e: Event) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter" || key === " " || key === "Spacebar") activate(e);
  });
  row.appendChild(disclosure);

  return row;
}

function buildGroups(deltas: SeenFileDeltaWithWhy[], onActivate: (path: string) => void): HTMLElement[] {
  return groupByDirectory(deltas).map(({ dir, files }) => {
    const wrap = document.createElement("div");
    wrap.className = "syl-dir-group";
    const label = document.createElement("div");
    label.className = "syl-dir-label";
    label.textContent = dir || "(repo root)";
    wrap.appendChild(label);
    for (const delta of files) wrap.appendChild(buildRow(delta, onActivate));
    return wrap;
  });
}

/** Re-render every dynamic node from current (loading/error/data) state. */
function render(refs: Refs, loading: boolean, error: boolean, data: SeenApiData | null, onActivate: (path: string) => void): void {
  refs.loading.hidden = !loading;
  refs.error.hidden = !error;

  if (loading || error || !data) {
    refs.banner.hidden = true;
    refs.empty.hidden = true;
    refs.body.replaceChildren();
    refs.markAllBtn.hidden = true;
    refs.staleness.textContent = "";
    return;
  }

  const { unknown_baseline, staleness, deltas } = data;
  refs.staleness.textContent = staleness.caveat ? `${staleness.headline} (${staleness.caveat})` : staleness.headline;

  if (unknown_baseline) {
    // C-discovery: suppress the per-file rows entirely — never list every
    // file as new_to_you just because the baseline is unknown.
    refs.banner.hidden = false;
    refs.empty.hidden = true;
    refs.body.replaceChildren();
    refs.markAllBtn.hidden = false; // still offer a way to SET the baseline
    return;
  }
  refs.banner.hidden = true;

  if (deltas.length === 0) {
    refs.empty.hidden = false;
    refs.body.replaceChildren();
    refs.markAllBtn.hidden = true;
    return;
  }
  refs.empty.hidden = true;
  refs.markAllBtn.hidden = false;
  refs.body.replaceChildren(...buildGroups(deltas, onActivate));
}

// ── Factory ───────────────────────────────────────────────────────────────

export interface SinceYouLookedData {
  repo: string;
  secret: string;
  loading: boolean;
  error: boolean;
  data: SeenApiData | null;
  marking: boolean;
  advancing: Set<string>;
  init(): void;
  fetchSeen(): Promise<void>;
  advanceFile(path: string): Promise<void>;
  markAll(): Promise<void>;
}

export function makeSinceYouLooked(fetchFn: typeof fetch = fetch): SinceYouLookedData {
  let refs: Refs | null = null;

  const onActivate = (path: string): void => {
    void self.advanceFile(path);
  };

  const self: SinceYouLookedData = {
    repo: "",
    secret: "",
    loading: true,
    error: false,
    data: null,
    marking: false,
    advancing: new Set<string>(),

    init(): void {
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      if (!el) return;
      refs = getRefs(el);
      this.repo = el.dataset.repo ?? "";
      this.secret = el.closest<HTMLElement>("[data-secret]")?.getAttribute("data-secret") ?? "";
      refs?.markAllBtn.addEventListener("click", () => void this.markAll());
      // The ONLY fetch init() fires — a lazy GET. No advance/mark-all call
      // ever happens here or from any observer/scroll/mount effect.
      void this.fetchSeen();
    },

    async fetchSeen(): Promise<void> {
      if (!refs) return;
      this.loading = true;
      this.error = false;
      render(refs, this.loading, this.error, this.data, onActivate);

      if (!this.repo) {
        this.loading = false;
        this.error = true;
        render(refs, this.loading, this.error, this.data, onActivate);
        return;
      }

      try {
        const res = await fetchFn(`/api/repo-graph/seen?repo=${this.repo}`);
        if (!res.ok) throw new Error("bad status");
        const body = (await res.json()) as { success: boolean; data: SeenApiData | null };
        if (!body.success || !body.data) throw new Error("bad envelope");
        this.data = body.data;
        this.loading = false;
        this.error = false;
      } catch {
        this.data = null;
        this.loading = false;
        this.error = true;
      }
      render(refs, this.loading, this.error, this.data, onActivate);
    },

    async advanceFile(path: string): Promise<void> {
      if (this.advancing.has(path)) return;
      this.advancing.add(path);
      try {
        const res = await fetchFn("/api/repo-graph/seen/advance", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": this.secret },
          body: JSON.stringify({ repo: this.repo, path }),
        });
        const body = (await res.json().catch(() => null)) as { success?: boolean } | null;
        if (res.ok && body?.success) {
          // C13: re-fetch so the panel reflects the change — never a local
          // splice, so it can't drift from the server's own classification.
          await this.fetchSeen();
        }
      } catch {
        // network error — row stays; the user can retry the gesture.
      } finally {
        this.advancing.delete(path);
      }
    },

    async markAll(): Promise<void> {
      if (this.marking) return;
      this.marking = true;
      refs?.markAllBtn.setAttribute("disabled", "true");
      try {
        const res = await fetchFn("/api/repo-graph/seen/mark-all", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": this.secret },
          body: JSON.stringify({ repo: this.repo }),
        });
        const body = (await res.json().catch(() => null)) as { success?: boolean } | null;
        if (res.ok && body?.success) {
          await this.fetchSeen();
        }
      } catch {
        // network error — banner/list stays; the user can retry.
      } finally {
        this.marking = false;
        refs?.markAllBtn.removeAttribute("disabled");
      }
    },
  };

  return self;
}

// ── Registration ──────────────────────────────────────────────────────────

/** Minimal Alpine surface this island needs — matches `registerRepoGraph`'s
 *  exported-function shape so a DOM-mount test can capture the factory
 *  without a real `Alpine.start()` loop. */
export interface AlpineLike {
  data: (name: string, factory: () => unknown) => void;
}

export function registerSinceYouLooked(Alpine: AlpineLike): void {
  Alpine.data("sinceYouLooked", () => makeSinceYouLooked());
}

if (typeof document !== "undefined") {
  document.addEventListener("alpine:init", () => {
    const Alpine = (globalThis as { Alpine?: AlpineLike }).Alpine;
    if (Alpine) registerSinceYouLooked(Alpine);
  });
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * modelPicker island — the Settings page's "Change model" window (spec §12.2).
 * One per page; each role row's button opens it for that role
 * (`$dispatch('open-model-window', { role })`).
 *
 *   - opens on the saved lists at once (GET /api/brain/models), then asks every
 *     agent and models.dev again (?refresh=1) and redraws;
 *   - the row in use is always first and marked only by a green ✓; then priced
 *     rows from cheapest to dearest; then unpriced; an agent's own tier names
 *     last;
 *   - `Use` saves the role (POST /api/brain/roles/<role>, the route the CLI's
 *     command shares) and does NOT close the window: the row moves to the top
 *     and the bar says ✓ Saved;
 *   - closing after a save reloads the page, so the table shows the new choice.
 *
 * What each role uses now comes from the page (`data-roles`, server-written
 * JSON). The secret comes from `closest("[data-secret]")` — memory
 * `dashboard-write-island-secret-closest`.
 *
 * Registration: document.addEventListener("alpine:init", ...) before
 * Alpine.start(). Imported by src/web/client/index.ts.
 */
import { keepTabInside } from "../lib/dialog-focus";
import type { ModelRow, ModelWindowView, SourceLine } from "../../../brain/model-window";

export type PickerRole = "chat" | "review" | "extract";

export interface InUse {
  family: string;
  /** "" = the agent's own default / configured model. */
  model: string;
  why: string;
  isDefault: boolean;
  /** What stands in for the agent when no single one is in use ("the agent you build with"). */
  label?: string;
  /** The page row's words for an agent's own model, shown until the list loads. */
  modelText?: string;
}

const ROLE_NAME: Record<PickerRole, string> = { chat: "Chat", review: "Critic", extract: "Summarizer" };

export interface ModelPickerData {
  open: boolean;
  role: PickerRole;
  tab: string;
  roles: Partial<Record<PickerRole, InUse>>;
  inUse: InUse | null;
  view: ModelWindowView | null;
  refreshing: boolean;
  saving: boolean;
  saved: boolean;
  /** Something was saved since the window opened. */
  changed: boolean;
  error: string;
  init(): void;
  title(): string;
  openFor(role: PickerRole): Promise<void>;
  rows(): ModelRow[];
  /** Each source's line: "sites" (models.dev, openrouter.ai), "agents" (the five), or all. */
  sources(kind?: "sites" | "agents"): SourceLine[];
  isInUse(row: ModelRow): boolean;
  /** The In use now bar's model: the model, or the agent's own row's words, or "". */
  inUseModelText(): string;
  /** A row's tags less those every model of its agent has: they tell nothing apart. */
  tagsFor(row: ModelRow): string[];
  /** The short line: OpenRouter's, else models.dev's, else "". */
  whatFor(row: ModelRow): string;
  /** On hover: OpenRouter's full words and the knowledge cutoff, else models.dev's line. */
  hoverFor(row: ModelRow): string;
  isCheapest(row: ModelRow): boolean;
  /** The sourced line under "What it's for" (tags are shown beside it). */
  note(row: ModelRow): string;
  /** `not in <agent>'s current list` for an in-use model the agent no longer lists. */
  missingNote(row: ModelRow): string;
  use(row: ModelRow): Promise<void>;
  close(): void;
  /** Keydown on the window: Tab stays inside it. */
  onKey(e: KeyboardEvent): void;
  /** What had focus before the window opened; it gets focus back on close. */
  _opener: HTMLElement | null;
  /** Reload the page. A property so a test can count calls instead of navigating. */
  reload(): void;
}

/** What a few tier names are, from the agents' own docs (spec §12.5). */
const TIER_NOTE: Record<string, string> = {
  Auto: "qoder picks a model for each request",
  "hy4-preview": "Tencent's own model — not on models.dev",
  hy3: "Tencent's own model — not on models.dev",
};

/** The sites by name; every other source line is an agent's, so a new agent lands with the agents. */
const SITES = new Set(["models.dev", "openrouter.ai"]);

/**
 * Model ids compare without case (config and a CLI's list can differ in it),
 * and without a trailing date: `claude-haiku-4-5-20251001` is the model
 * Anthropic's list names `claude-haiku-4-5`.
 */
const undated = (id: string): string => id.toLowerCase().replace(/-\d{8}$/, "");
const sameId = (a: string, b: string): boolean => undated(a) === undated(b);

const isRole = (v: unknown): v is PickerRole => v === "chat" || v === "review" || v === "extract";

/** Sort key: priced (cheapest first), then unpriced, then tiers, then models that cannot be chosen. */
function rank(r: ModelRow): [number, number] {
  if (r.choosable === false) return [3, r.input ?? 0];
  if (r.tier) return [2, 0];
  return r.input === null ? [1, 0] : [0, r.input];
}

export function makeModelPicker(): ModelPickerData {
  return {
    open: false,
    role: "chat",
    tab: "all",
    roles: {},
    inUse: null,
    view: null,
    refreshing: false,
    saving: false,
    saved: false,
    changed: false,
    error: "",
    _opener: null,

    init(): void {
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      try {
        const parsed = JSON.parse(el?.dataset.roles ?? "{}") as Record<string, InUse>;
        for (const [k, v] of Object.entries(parsed)) if (isRole(k)) this.roles[k] = v;
      } catch {
        this.roles = {};
      }
    },

    title(): string {
      return `Choose ${ROLE_NAME[this.role]}'s agent and model`;
    },

    async openFor(role: PickerRole): Promise<void> {
      if (!isRole(role)) return;
      this.role = role;
      this.tab = "all";
      this.inUse = this.roles[role] ?? null;
      this.saved = false;
      this.error = "";
      this._opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.open = true;
      // Focus moves into the window, so a screen reader announces its name and Tab starts there.
      const self = this as unknown as { $el?: HTMLElement; $nextTick?: (fn: () => void) => void };
      self.$nextTick?.(() => self.$el?.querySelector<HTMLElement>("[role=dialog]")?.focus());
      try {
        const saved = await fetch("/api/brain/models");
        if (saved.ok) this.view = (await saved.json()) as ModelWindowView;
        this.refreshing = true;
        // The refresh runs every agent's CLI, so the daemon wants the secret for it.
        const el = (this as unknown as { $el?: HTMLElement }).$el;
        const secret = el?.closest("[data-secret]")?.getAttribute("data-secret") ?? "";
        const fresh = await fetch("/api/brain/models?refresh=1", { headers: { "X-Siltpoke-Secret": secret } });
        if (fresh.ok) this.view = (await fresh.json()) as ModelWindowView;
        else this.error = `could not refresh the lists (HTTP ${fresh.status})`;
      } catch {
        this.error = "could not load the model lists — is the daemon running?";
      } finally {
        this.refreshing = false;
      }
    },

    whatFor(row: ModelRow): string {
      return row.guide?.short ?? row.about ?? "";
    },

    hoverFor(row: ModelRow): string {
      const g = row.guide;
      if (!g) return row.about ?? "";
      return g.knowsUpTo ? `${g.text}\nKnows up to ${g.knowsUpTo}.` : g.text;
    },

    tagsFor(row: ModelRow): string[] {
      // The description's tags, then models.dev's (context size, open weights).
      const all = (r: ModelRow): string[] => [...(r.guide?.tags ?? []), ...r.tags];
      const retires = row.guide?.retiresOn ? [`retires ${row.guide.retiresOn}`] : [];
      // Peers: the same agent's listed models. Its own row and its tiers are
      // not models it lists, so they neither count nor lose tags.
      if (row.id === "" || row.tier) return [...all(row), ...retires];
      const peers = (this.view?.rows ?? []).filter((r) => r.family === row.family && r.id !== "" && !r.tier);
      const mine = all(row);
      const shown = peers.length < 2 ? mine : mine.filter((t) => !peers.every((r) => all(r).includes(t)));
      return [...shown, ...retires];
    },

    inUseModelText(): string {
      const u = this.inUse;
      if (u === null || !u.family) return "";
      if (u.model) return u.model;
      const own = (this.view?.rows ?? []).find((r) => r.family === u.family && r.id === "");
      return own?.description ?? u.modelText ?? "its own default model";
    },

    isInUse(row: ModelRow): boolean {
      const u = this.inUse;
      if (u === null || u.family !== row.family || row.choosable === false) return false;
      // An agent that cannot be handed a model (none today; codex until
      // 2026-10-16): whatever model was saved, it runs its own, so its own row
      // is the one in use.
      const ignoresModel = (this.view?.rows ?? []).some((r) => r.family === row.family && r.choosable === false);
      if (ignoresModel && row.id === "") return true;
      return sameId(u.model, row.id);
    },

    rows(): ModelRow[] {
      const all = this.view?.rows ?? [];
      const shown = all.filter((r) => this.tab === "all" || r.family === this.tab);
      const sorted = shown
        .map((r, i) => ({ r, i }))
        .sort((a, b) => {
          const [ga, pa] = rank(a.r);
          const [gb, pb] = rank(b.r);
          return ga - gb || pa - pb || a.i - b.i;
        })
        .map((x) => x.r);
      const u = this.inUse;
      if (u === null || u.family === "" || (this.tab !== "all" && this.tab !== u.family)) return sorted;
      const at = sorted.findIndex((r) => this.isInUse(r));
      if (at >= 0) return [sorted[at] as ModelRow, ...sorted.slice(0, at), ...sorted.slice(at + 1)];
      // In use but not listed: the agent's own default, or a model it dropped.
      const known = all.find((r) => r.family === u.family && sameId(r.id, u.model));
      const synth: ModelRow = known ?? {
        id: u.model,
        family: u.family as ModelRow["family"],
        description: u.model === "" ? `${u.family}'s own default model` : null,
        tier: false,
        input: null,
        output: null,
        tags: [],
        about: null,
        guide: null,
        choosable: true,
      };
      return [synth, ...sorted];
    },

    sources(kind?: "sites" | "agents"): SourceLine[] {
      const all = this.view?.sources ?? [];
      if (kind === undefined) return all;
      return all.filter((s) => (kind === "sites") === SITES.has(s.name));
    },

    isCheapest(row: ModelRow): boolean {
      if (row.tier || row.input === null || row.choosable === false || row.id === "") return false;
      const priced = (this.view?.rows ?? []).filter(
        (r) => r.family === row.family && !r.tier && r.input !== null && r.choosable !== false,
      );
      const min = Math.min(...priced.map((r) => r.input as number));
      return row.input === min && priced.find((r) => r.input === min)?.id === row.id;
    },

    note(row: ModelRow): string {
      if (row.tier) return TIER_NOTE[row.id] ?? `${row.family}'s own tier — not a public model, so no price or details`;
      if (row.choosable === false) {
        const why = `Siltpoke can't pick ${row.family}'s model yet`;
        return row.description !== null ? `${row.family}: “${row.description}” — ${why}` : why;
      }
      // The Model column already names it; say what the row means.
      if (row.family === "codex" && row.id === "") return "Siltpoke uses whatever codex's own config sets";
      if (row.description !== null) return `${row.family}: “${row.description}”`;
      // No "through qoder": the Family column already says whose model it is.
      return "";
    },

    missingNote(row: ModelRow): string {
      if (!this.isInUse(row) || row.id === "") return "";
      const listed = (this.view?.rows ?? []).some((r) => r.family === row.family && sameId(r.id, row.id));
      return listed ? "" : `not in ${row.family}'s current list`;
    },

    async use(row: ModelRow): Promise<void> {
      if (this.saving || row.choosable === false) return;
      this.saving = true;
      this.saved = false;
      this.error = "";
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      const secret = el?.closest("[data-secret]")?.getAttribute("data-secret") ?? "";
      const body = row.id === "" ? { family: row.family } : { family: row.family, model: row.id };
      try {
        const res = await fetch(`/api/brain/roles/${this.role}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": secret },
          body: JSON.stringify(body),
        });
        const reply = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !reply.ok) {
          this.error = reply.error ?? `save failed (HTTP ${res.status})`;
          return;
        }
        this.inUse = { family: row.family, model: row.id, why: "you chose it", isDefault: false };
        this.roles[this.role] = this.inUse;
        this.saved = true;
        this.changed = true;
        // The Use button just pressed is hidden by the ✓ that replaces it, which
        // drops focus to the page; hand it to the window instead (review, B1).
        const tick = (this as unknown as { $nextTick?: (fn: () => void) => void }).$nextTick;
        tick?.(() => el?.closest<HTMLElement>("[role=dialog]")?.focus());
      } catch {
        this.error = "network error — is the daemon running?";
      } finally {
        this.saving = false;
      }
    },

    onKey(e: KeyboardEvent): void {
      // The handler sits on the dialog itself; `$el` there is the dialog, not the island root.
      const dialog = e.currentTarget;
      if (this.open && dialog instanceof HTMLElement) keepTabInside(e, dialog);
    },

    close(): void {
      this.open = false;
      this._opener?.focus();
      this._opener = null;
      if (this.changed) {
        this.changed = false;
        this.reload();
      }
    },

    reload(): void {
      globalThis.location?.reload();
    },
  };
}

document.addEventListener("alpine:init", () => {
  (globalThis as { Alpine?: { data: (name: string, factory: () => unknown) => void } }).Alpine?.data(
    "modelPicker",
    () => makeModelPicker(),
  );
});

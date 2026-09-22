// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * roleRow island — one directly-selectable row of the "brains by role" table
 * on the Settings page (Brain select v2.2). Used for the `review` and `extract`
 * roles (chat stays read-only / auto-detected). Each row picks the family (and,
 * when the family is claude, the model) for that role and Saves it to
 * POST /api/brain/roles/<role> — the SAME route+config the CLI writes (one SoT).
 *
 * The secret is read from the row's OWN `data-secret` container (closest()
 * includes self). Initial
 * role/family/model come from data-* attributes (server-escaped).
 *
 * Registration: document.addEventListener("alpine:init", ...) before
 * Alpine.start(). Imported by src/web/client/index.ts. Never addEventListener
 * on island DOM (hx-boost morph drops direct listeners) — bind via x-on:* .
 */

export interface RoleRowData {
  role: string;
  family: string;
  model: string;
  modelCapable: string[];
  saving: boolean;
  saved: boolean;
  error: string;
  init(): void;
  acceptsModel(): boolean;
  save(): Promise<void>;
}

export function makeRoleRow(): RoleRowData {
  return {
    role: "",
    family: "",
    model: "",
    /** Families whose CLI actually takes a model, served by the page from the
     * registry. This used to be a literal `family === "claude"` here — a third
     * copy of a rule that was wrong for agy / qoder / codebuddy. */
    modelCapable: [],
    saving: false,
    saved: false,
    error: "",

    init(): void {
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      this.role = el?.dataset.role ?? "";
      // An unpinned role renders its resolved family; the select must still open
      // on "(follow the building agent)" or Save would silently pin what was
      // only ever a default.
      this.family = el?.dataset.pinned ? (el?.dataset.family ?? "") : "";
      this.model = (el?.dataset.model ?? "").trim();
      this.modelCapable = (el?.dataset.modelCapable ?? "")
        .split(",")
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
    },

    acceptsModel(): boolean {
      return this.modelCapable.includes(this.family);
    },

    async save(): Promise<void> {
      if (this.saving || !this.role) return;
      this.saving = true;
      this.saved = false;
      this.error = "";
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      const secret = el?.closest("[data-secret]")?.getAttribute("data-secret") ?? "";
      // Empty family = "follow the building agent" → remove the pin entirely.
      if (this.family === "") {
        try {
          const res = await fetch(`/api/brain/roles/${encodeURIComponent(this.role)}`, {
            method: "DELETE",
            headers: { "X-Siltpoke-Secret": secret },
          });
          const body = (await res.json()) as { ok?: boolean; error?: string };
          if (!res.ok || !body.ok) {
            this.error = body.error ?? "save failed";
            return;
          }
          this.saved = true;
        } catch {
          this.error = "network error — is the daemon running?";
        } finally {
          this.saving = false;
        }
        return;
      }
      // A model is only sent to a family whose argv can carry it; the server
      // refuses one for any other family, so this filter is a courtesy, not the
      // guard (the guard is runBrainSet).
      const includeModel = this.acceptsModel() && this.model.trim().length > 0;
      try {
        const res = await fetch(`/api/brain/roles/${encodeURIComponent(this.role)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": secret },
          body: JSON.stringify({
            family: this.family,
            ...(includeModel ? { model: this.model.trim() } : {}),
          }),
        });
        const body = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !body.ok) {
          this.error = body.error ?? "save failed";
          return;
        }
        this.saved = true;
      } catch {
        this.error = "network error — is the daemon running?";
      } finally {
        this.saving = false;
      }
    },
  };
}

document.addEventListener("alpine:init", () => {
  (globalThis as { Alpine?: { data: (name: string, factory: () => unknown) => void } }).Alpine?.data(
    "roleRow",
    () => makeRoleRow(),
  );
});

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
 * includes self) — memory `dashboard-write-island-secret-closest`. Initial
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
  saving: boolean;
  saved: boolean;
  error: string;
  init(): void;
  save(): Promise<void>;
}

export function makeRoleRow(): RoleRowData {
  return {
    role: "",
    family: "",
    model: "",
    saving: false,
    saved: false,
    error: "",

    init(): void {
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      this.role = el?.dataset.role ?? "";
      this.family = el?.dataset.family ?? "";
      this.model = (el?.dataset.model ?? "").trim();
    },

    async save(): Promise<void> {
      if (this.saving || !this.role || !this.family) return;
      this.saving = true;
      this.saved = false;
      this.error = "";
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      const secret = el?.closest("[data-secret]")?.getAttribute("data-secret") ?? "";
      // Model is only meaningful (and accepted) when the family is claude.
      const includeModel = this.family === "claude" && this.model.trim().length > 0;
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

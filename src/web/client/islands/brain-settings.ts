// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * builderRow island — one row of the per-builder review table on the Settings
 * page (Brain select v2). Each row picks the reviewer (and, when the reviewer
 * is claude, the model) for code built by one CLI family, and Saves it to
 * POST /api/brain/review-by-builder/<builder> — the SAME route+config the
 * `siltpoke brain set-builder` command writes (one source of truth).
 *
 * The secret is read from the row's OWN `data-secret` container (closest()
 * includes self) — FloatingChat's data-secret is a sibling, not an ancestor,
 * so a bare closest() would miss (memory `dashboard-write-island-secret-closest`).
 * Initial builder/reviewer/model come from data-* attributes (server-escaped).
 *
 * Registration: document.addEventListener("alpine:init", ...) before
 * Alpine.start(). Imported by src/web/client/index.ts. Never addEventListener
 * on island DOM (hx-boost morph drops direct listeners) — bind via x-on:* .
 */

export interface BuilderRowData {
  builder: string;
  reviewer: string;
  model: string;
  saving: boolean;
  saved: boolean;
  error: string;
  init(): void;
  save(): Promise<void>;
}

export function makeBuilderRow(): BuilderRowData {
  return {
    builder: "",
    reviewer: "",
    model: "",
    saving: false,
    saved: false,
    error: "",

    init(): void {
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      this.builder = el?.dataset.builder ?? "";
      this.reviewer = el?.dataset.reviewer ?? "";
      this.model = (el?.dataset.model ?? "").trim();
    },

    async save(): Promise<void> {
      if (this.saving || !this.builder || !this.reviewer) return;
      this.saving = true;
      this.saved = false;
      this.error = "";
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      const secret = el?.closest("[data-secret]")?.getAttribute("data-secret") ?? "";
      // Model is only meaningful (and accepted by the route) when reviewer=claude.
      const includeModel = this.reviewer === "claude" && this.model.trim().length > 0;
      try {
        const res = await fetch(`/api/brain/review-by-builder/${encodeURIComponent(this.builder)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": secret },
          body: JSON.stringify({
            reviewer: this.reviewer,
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
    "builderRow",
    () => makeBuilderRow(),
  );
});

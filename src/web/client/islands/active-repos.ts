// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * active-repos island — the per-row Alpine component for the "Active Repos"
 * card on the Memory page. Holds expand/collapse state plus an on-demand
 * "generate summary" action: POST /api/repo-summary (one gated Brain call) and
 * drop the returned blurb into the row.
 *
 * Registration: document.addEventListener("alpine:init", ...) so it fires
 * before Alpine.start() walks the DOM. Imported by src/web/client/index.ts.
 *
 * IMPORTANT: never bind handlers via addEventListener on island DOM — hx-boost
 * morph nav drops direct listeners. Use x-on:* in the template. The per-row
 * project root + initial blurb come from `data-*` attributes (HTML-escaped by
 * the server), read in init(); the secret is read from the nearest
 * [data-secret] ancestor (the memoryBook root) at call time.
 */

export interface RepoRowData {
  projectRoot: string;
  summary: string;
  open: boolean;
  generating: boolean;
  error: string;
  init(): void;
  hasSummary(): boolean;
  generate(): Promise<void>;
}

export function makeRepoRow(): RepoRowData {
  return {
    projectRoot: "",
    summary: "",
    open: false,
    generating: false,
    error: "",

    init(): void {
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      this.projectRoot = el?.dataset.projectRoot ?? "";
      this.summary = (el?.dataset.summary ?? "").trim();
    },

    hasSummary(): boolean {
      return this.summary.trim().length > 0;
    },

    async generate(): Promise<void> {
      if (this.generating) return;
      this.generating = true;
      this.error = "";
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      const secret = el?.closest("[data-secret]")?.getAttribute("data-secret") ?? "";
      try {
        const res = await fetch("/api/repo-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": secret },
          body: JSON.stringify({ project_root: this.projectRoot }),
        });
        const body = (await res.json()) as { summary_text?: string; error?: string };
        if (!res.ok) {
          this.error = body.error ?? "generation failed";
        } else if (typeof body.summary_text === "string") {
          this.summary = body.summary_text;
          this.open = true;
        }
      } catch {
        this.error = "network error — is the daemon running?";
      } finally {
        this.generating = false;
      }
    },
  };
}

document.addEventListener("alpine:init", () => {
  (globalThis as { Alpine?: { data: (name: string, factory: () => unknown) => void } }).Alpine?.data(
    "repoRow",
    () => makeRepoRow(),
  );
});

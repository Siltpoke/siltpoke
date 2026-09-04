// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
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

/**
 * The page's resolved proj_hash as a `?repo=` query suffix, read from the
 * `[data-proj-hash]` attribute Layout.tsx sets on the root `<html>` element
 * (per-request project resolution — see src/daemon/project-context.ts).
 * Appended to the generate-summary fetch below for consistency with the
 * other write islands (memory-book, chat-stream). NOTE: `POST /api/repo-summary`
 * (src/daemon/routes/repo-summary.ts) does not currently read this query param
 * or carry a write-eligibility guard — it takes `project_root` from the JSON
 * body instead — so this suffix is inert today. Wiring that route's own guard
 * is tracked as follow-up, out of this task's scope (facts/chat only).
 */
function writeRepoQuery(): string {
  const projHash =
    (typeof document !== "undefined"
      ? document.querySelector("[data-proj-hash]")?.getAttribute("data-proj-hash")
      : null) ?? "";
  return projHash ? `?repo=${projHash}` : "";
}

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
        const res = await fetch(`/api/repo-summary${writeRepoQuery()}`, {
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

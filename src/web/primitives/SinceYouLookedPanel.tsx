// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */

import { tokens } from "../tokens/tokens";

/**
 * The rules for everything the island builds at runtime.
 *
 * It lives HERE, next to the shell, rather than as inline styles inside the
 * island, for the reason the shell exists at all: the server owns how this
 * panel looks, the island owns what is in it. It ships as a `<style>` inside
 * the panel so the rules cannot be mounted without the markup that needs them
 * — which is how they came to be missing entirely. The island created seven
 * class names and the repo contained no rule for any of them; the only match
 * for `.syl-row` was a comment describing the layout it was supposed to have.
 * Four children with no box model ran together into
 * `_index_repos.tsnew to youno WHY recorded`, with the block-level disclosure
 * control on its own line under it.
 *
 * `tests/web/primitives/since-you-looked-css.test.tsx` reads the class names
 * out of the island's source and requires a rule for each, so an eighth name
 * cannot ship unstyled the way the first seven did.
 *
 * Colours go through `tokens.color.*` (which resolve to `var(--color-*)`), so
 * these rules follow the theme like every inline style on this page.
 */
export const SINCE_YOU_LOOKED_CSS = `
.syl-dir-group { display: flex; flex-direction: column; gap: 3px; }
.syl-dir-label {
  font-family: ${tokens.font.mono};
  font-size: 9px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: ${tokens.color.ink3};
  margin-bottom: 2px;
}
.syl-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding: 2px 0;
}
.syl-row-path {
  font-family: ${tokens.font.mono};
  font-size: 11px;
  color: ${tokens.color.ink};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.syl-row-tag {
  font-family: ${tokens.font.mono};
  font-size: 9px;
  color: ${tokens.color.ink3};
  border: 1px solid ${tokens.color.edge};
  border-radius: 4px;
  padding: 0 5px;
  flex-shrink: 0;
  white-space: nowrap;
}
/* Pushed to the far side by the auto margin so the disclosure control lands in
   a fixed column, whatever the filename's length. */
.syl-row-why {
  font-size: 10.5px;
  color: ${tokens.color.ink3};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}
a.syl-row-why { color: ${tokens.color.sky}; text-decoration: none; }
a.syl-row-why:hover { text-decoration: underline; }
.syl-row-disclosure {
  font-family: ${tokens.font.mono};
  font-size: 9px;
  color: ${tokens.color.ink3};
  border: 1px solid ${tokens.color.edge};
  border-radius: 4px;
  padding: 1px 6px;
  flex-shrink: 0;
  cursor: pointer;
  user-select: none;
}
.syl-row-disclosure:hover { color: ${tokens.color.ink}; }
/* Keyboard reachability is the whole point of the role=button + tabindex on
   this control; without a visible focus ring it is reachable and invisible. */
.syl-row-disclosure:focus-visible { outline: 2px solid ${tokens.color.sky}; outline-offset: 1px; }
`;

export interface SinceYouLookedPanelProps {
  /** proj_hash of the current repo — the island's `?repo=` query. Callers
   *  should only mount this panel once a repo has actually resolved (see
   *  Memory.tsx: `resolvedProject?.projHash && <SinceYouLookedPanel .../>`);
   *  the island still degrades to its error state defensively if handed "". */
  projHash: string;
}

/**
 * "Since you last looked" — slice ③ discovery panel (R5/R10, task 6).
 *
 * Renders ONLY a static skeleton with stable ids; the `sinceYouLooked`
 * Alpine island (`islands/since-you-looked.ts`) does a single lazy GET on
 * mount (`GET /api/repo-graph/seen?repo=<projHash>`) and fills every
 * dynamic node IMPERATIVELY (createElement, not x-for/x-text) — same
 * "server renders the shell, island owns live content" split as
 * {@link StalenessBadge}'s `x-show`-driven states, chosen imperative here
 * (not declarative Alpine binding) so the per-row disclosure controls can
 * carry real `addEventListener("click"/"keydown", …)` handlers that a
 * DOM-mount test can dispatch against directly, with or without a real
 * `Alpine.start()` loop running — see
 * `tests/web/client/islands/since-you-looked.test.ts`.
 *
 * Discovery framing only (binding corrections C-discovery/C-gesture): rows
 * are grouped by directory with a neutral status tag ("signature changed ·
 * body changed" / "new to you" / "deleted") — no score, no "Unseen: N"
 * badge, no red/yellow urgency coloring. `unknown_baseline` renders the
 * banner and SUPPRESSES the per-file rows entirely (never lists every file
 * as `new_to_you`), and the persisted index's own staleness headline always
 * renders alongside the delta list so "nothing changed" is never shown bare
 * over a stale index. The advance POST is bound EXCLUSIVELY to a
 * click/keydown(Enter|Space) on a row's disclosure control — never on
 * mount, scroll, or an observer.
 */
export function SinceYouLookedPanel({ projHash }: SinceYouLookedPanelProps) {
  return (
    <div
      class="since-you-looked-panel bk-card"
      x-data="sinceYouLooked"
      data-repo={projHash}
      style={{
        position: "relative",
        width: "100%",
        boxSizing: "border-box",
        background: tokens.color.cream,
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.lg,
        padding: "17px",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "10px", marginBottom: "10px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: tokens.color.ink }}>Since you last looked</div>
          <div
            id="syl-staleness"
            class="syl-staleness"
            style={{ fontFamily: tokens.font.mono, fontSize: 9.5, color: tokens.color.ink3, marginTop: "3px" }}
          />
        </div>
        {/* Repo-level "mark all seen" — click-bound in the island's init(),
            never fires on its own. Hidden until the first fetch resolves. */}
        <button
          type="button"
          id="syl-mark-all"
          class="syl-mark-all-btn"
          hidden
          style={{
            flexShrink: 0,
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink2,
            background: tokens.color.paper,
            border: `1px solid ${tokens.color.edge}`,
            borderRadius: tokens.radius.sm,
            padding: "4px 10px",
            cursor: "pointer",
          }}
        >
          mark all seen
        </button>
      </div>

      <div
        id="syl-loading"
        class="syl-loading"
        style={{ fontSize: 11.5, color: tokens.color.ink3, fontStyle: "italic" }}
      >
        checking what's changed…
      </div>

      <div
        id="syl-error"
        class="syl-error"
        hidden
        style={{ fontSize: 11.5, color: tokens.color.ink3, fontStyle: "italic" }}
      >
        couldn't check what's changed — is the daemon running?
      </div>

      {/* unknown_baseline banner — SUPPRESSES the per-file rows below it
          rather than a false wall of "every file is new to you". */}
      <div
        id="syl-banner"
        class="syl-banner"
        hidden
        style={{
          fontSize: 11.5,
          color: tokens.color.ink2,
          lineHeight: 1.5,
          background: tokens.color.paper,
          border: `1px solid ${tokens.color.edge}`,
          borderRadius: tokens.radius.sm,
          padding: "8px 10px",
        }}
      >
        We don't know what you've already looked at in this repo yet — the watermark hasn't been set. Use
        "mark all seen" once you've reviewed the current state, and future visits will show only what's new.
      </div>

      <div
        id="syl-empty"
        class="syl-empty"
        hidden
        style={{ fontSize: 11.5, color: tokens.color.ink3, fontStyle: "italic" }}
      >
        Nothing's changed since you last looked.
      </div>

      {/* Populated by the island: one .syl-dir-group per directory, each
          holding its .syl-row children (path + neutral tag + disclosure).
          Their rules ride along in the `<style>` below — see
          SINCE_YOU_LOOKED_CSS for why they live here and not in the island. */}
      <div id="syl-body" class="syl-body" style={{ display: "flex", flexDirection: "column", gap: "10px" }} />
      <style dangerouslySetInnerHTML={{ __html: SINCE_YOU_LOOKED_CSS }} />
    </div>
  );
}

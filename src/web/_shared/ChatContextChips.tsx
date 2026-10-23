// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * The chip bar above the chat composer: what a message will carry (the pinned
 * node, the page, the recalled facts) and which agent will answer it.
 *
 * Moved out of FloatingChat.tsx (which sits at its length pin) when the agent
 * chip was added. It renders inside the floatingChat island, so `contextChips()`,
 * `open` and `streaming` are that island's.
 */
export function ChatContextChips() {
  return (
    <>
      {/* ── context-transparency chip bar — mirrors the 📍
           pinned-node bar in FloatingChat.tsx for styling. Renders ABOVE the
           composer, independent of `active()`: it's a declarative Alpine
           x-text/x-show binding (no addEventListener), so it survives
           hx-boost/alpine-morph in-app nav without the listener-drop
           pitfall. INTENDED: the 🧠 facts chip shows on every page — the
           user-facts recall injects into every chat message regardless of
           page, so it is not conditioned on `node`/`page`. */}
      <div class="pt-1.5 px-4 pb-1 text-[11px] text-ink opacity-50 flex items-center gap-2.5 flex-wrap">
        <span x-show="contextChips().node" class="flex items-center gap-1 min-w-0">
          <span>📍</span>
          <span class="font-mono truncate max-w-[140px]" x-text="contextChips().node"></span>
        </span>
        <span class="flex items-center gap-1">
          <span>📄</span>
          <span x-text="contextChips().page"></span>
        </span>
        {/* Can chat open the user's files this turn (src/web/client/lib/chat-code-access.ts).
            The reason is in the tooltip and, for screen readers, in hidden text. */}
        <span
          x-show="contextChips().code"
          x-bind:title="contextChips().code?.title"
          data-chat-code-access
          class="flex items-center gap-1"
        >
          <span aria-hidden="true">📂</span>
          <span x-text="contextChips().code?.label"></span>
          <span class="sr-only" x-text="contextChips().code?.title"></span>
        </span>
        <span class="flex items-center gap-1">
          <span>🧠</span>
          <span x-text="contextChips().facts + ' facts'"></span>
        </span>
        {/* Which agent answers chat, read from the server each time the panel
            opens and each time a reply ends (the effect names both, then
            refreshes) — so a change on the Settings page shows here without a
            reload. Hidden until the read succeeds. The panel root turns
            hx-boost off; this link turns it back on, so going to Settings is an
            in-app swap: the panel collapses to its launcher as on any
            navigation, and (being hx-preserve'd) keeps its draft and a reply
            in flight — a full page load would drop both. The reason is the accessible name too: a `title`
            alone is out of reach of keyboard and touch. */}
        <a
          href="/settings"
          x-data="chatAgent"
          x-effect="open, streaming, refresh()"
          x-show="label"
          x-bind:title="title"
          x-bind:aria-label="title"
          hx-boost="true"
          data-chat-agent
          class="flex items-center gap-1 min-w-0 text-ink no-underline hover:underline"
        >
          <span aria-hidden="true">🤖</span>
          <span class="font-mono truncate max-w-[200px]" x-text="label"></span>
        </a>
      </div>
    </>
  );
}

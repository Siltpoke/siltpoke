// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { RECALL_SURFACE_ENABLED } from "../../chat/recall";
/**
 * Floating chat, rendered into
 * every dashboard page by the global Layout. `hx-preserve` keeps the element
 * (and its Alpine state + the open conversation) ALIVE across hx-boost
 * body-morph navigation.
 *
 * Layout note: x-show is on a thin WRAPPER, not on the flex column — toggling
 * display:none on a flex container made Alpine drop the flex layout. The inner
 * `.fc-panel` is always display:flex so the body fills + composer pins bottom.
 *
 * Visual: the "cream / soft" baseline (light header `● siltpoke`, 📍 path chip,
 * input pill + round send side-by-side). Static styling is Tailwind utility
 * classes (incremental adoption — so the look is editable in-class); REACTIVE
 * styling stays in Alpine `:style` bindings (state-driven bg/color/cursor that
 * a static class can't express). Tailwind's JIT only sees LITERAL class strings
 * → arbitrary values are written out in full (no `${const}` interpolation).
 *
 * A desync CTA block is rendered in the message body area when
 * `desyncCta` is not null (user sent while the view ≠ conversation's anchor).
 * The CTA presents two Alpine buttons: resolveDesync('reanchor') and
 * resolveDesync('new'). The user's choice clears the CTA.
 *
 * Behavior lives in `client/islands/floating-chat.ts` (x-data="floatingChat").
 *
 * `hx-boost="false"` on the root is load-bearing: the body is hx-boosted, so
 * without it htmx intercepts the composer's <form> submit and fires a boosted
 * navigation → the body morphs → the (non-preserved) repo-graph island re-mounts
 * to its default view while this preserved panel survives. Opting the island out
 * of boost lets Alpine's `@submit.prevent="send()"` own the submit, so sending a
 * message no longer resets the user's drilled-in graph view.
 */
export function FloatingChat() {
  return (
    <div
      id="siltpoke-floating-chat"
      hx-preserve="true"
      hx-boost="false"
      x-data="floatingChat"
      x-cloak
      data-recall-enabled={RECALL_SURFACE_ENABLED ? "1" : "0"}
      class="fixed right-5 bottom-5 z-[9999]"
    >
      {/* collapsed launcher */}
      <button
        type="button"
        x-show="!open"
        {...{ "x-on:click": "toggle()" }}
        aria-label="Open siltpoke chat"
        class="w-[52px] h-[52px] rounded-full flex items-center justify-center border-none bg-ink text-[#fff] cursor-pointer shadow-[0_8px_22px_rgba(31,27,22,0.26)]"
      >
        <svg
          width="23"
          height="23"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {/* x-show wrapper (visibility only — keeps flex layout off the toggle) */}
      <div x-show="open">
        {/* Backdrop — shown only when maximized; click restores corner panel */}
        <div
          x-show="maximized"
          {...{ "x-on:click": "toggleMaximize()" }}
          class="fixed inset-0 z-[9998] bg-[rgba(31,27,22,0.42)]"
        ></div>
        {/* Panel wrapper — switches between corner and centered-modal layouts */}
        <div
          {...{
            ":class": "maximized ? 'fixed inset-0 z-[9999] flex items-center justify-center pointer-events-none' : ''",
          }}
        >
        <div
          class="fc-panel relative flex flex-col bg-cream border border-[rgba(31,27,22,0.1)] rounded-[18px] overflow-hidden font-body shadow-[0_16px_48px_rgba(31,27,22,0.22)]"
          {...{
            ":class": "maximized ? 'pointer-events-auto w-[min(880px,92vw)] h-[min(86vh,860px)]' : 'w-96 h-[564px] max-h-[78vh]'",
          }}
        >
          {/* ── header: soft, light ── */}
          <div class="flex items-center gap-2 px-4 py-[13px] border-b border-b-[rgba(31,27,22,0.06)]">
            <span class="w-2 h-2 rounded-full bg-ink opacity-[.85]"></span>
            <span class="font-semibold text-sm text-ink">siltpoke</span>
            <button
              type="button"
              {...{ "x-on:click.stop": "toggleHistory()", ":style": "conversations.length ? 'opacity:.9;cursor:pointer' : 'opacity:.3;cursor:not-allowed'" }}
              title="Past chats"
              class="ml-auto w-[26px] h-[26px] rounded-md border border-[rgba(31,27,22,0.1)] bg-transparent text-ink inline-flex items-center justify-center"
            >
              {/* Material "history" glyph — clock face with a counter-clockwise
                  rewind arrow. fill=currentColor → inherits text-ink. */}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z" />
              </svg>
            </button>
            {/* Related-chats button — gated on RECALL_SURFACE_ENABLED; parked 2026-06-26. */}
            {RECALL_SURFACE_ENABLED && (
            <button
              type="button"
              {...{ "x-on:click.stop": "toggleRecall()", ":style": "recallMatches.length ? 'opacity:.9;cursor:pointer' : 'opacity:.3;cursor:not-allowed'" }}
              title="Related chats"
              class="w-[26px] h-[26px] rounded-md border border-[rgba(31,27,22,0.1)] bg-transparent text-ink inline-flex items-center justify-center"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
              </svg>
            </button>
            )}
            {/* Maximize / restore button */}
            <button
              type="button"
              {...{ "x-on:click": "toggleMaximize()", ":aria-label": "maximized ? 'Restore chat' : 'Expand chat'" }}
              title="Expand / restore chat"
              class="w-[26px] h-[26px] rounded-md border border-[rgba(31,27,22,0.1)] bg-transparent text-ink inline-flex items-center justify-center cursor-pointer"
            >
              {/* Expand icon (shown when not maximized) */}
              <svg x-show="!maximized" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="15 3 21 3 21 9"></polyline>
                <polyline points="9 21 3 21 3 15"></polyline>
                <line x1="21" y1="3" x2="14" y2="10"></line>
                <line x1="3" y1="21" x2="10" y2="14"></line>
              </svg>
              {/* Collapse icon (shown when maximized) */}
              <svg x-show="maximized" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="4 14 10 14 10 20"></polyline>
                <polyline points="20 10 14 10 14 4"></polyline>
                <line x1="10" y1="14" x2="3" y2="21"></line>
                <line x1="21" y1="3" x2="14" y2="10"></line>
              </svg>
            </button>
            <button
              type="button"
              {...{ "x-on:click": "newConversation()", ":disabled": "!canAddContext()", ":style": "canAddContext() ? 'opacity:.9;cursor:pointer' : 'opacity:.3;cursor:not-allowed'", ":title": "viewingNode() ? \"New chat about the node you're viewing\" : 'New chat'" }}
              class="w-[26px] h-[26px] rounded-md border border-[rgba(31,27,22,0.1)] bg-transparent text-ink text-base leading-none"
            >
              +
            </button>
            <button
              type="button"
              {...{ "x-on:click": "toggle()" }}
              aria-label="Close"
              class="w-[26px] h-[26px] border-none bg-transparent text-ink opacity-[.55] text-lg cursor-pointer leading-none"
            >
              ×
            </button>
          </div>

          {/* ── history dropdown (anchored to .fc-panel via relative) ── */}
          <div
            x-show="historyOpen"
            {...{ "x-on:click.outside": "historyOpen = false" }}
            class="absolute left-3 right-3 top-[52px] z-10 max-h-[60%] overflow-y-auto bg-cream border border-[rgba(31,27,22,0.12)] rounded-[12px] shadow-[0_8px_24px_rgba(31,27,22,0.18)]"
          >
            <template x-for="c in sortedConversations()" {...{ ":key": "c.id" }}>
              <div class="flex items-center gap-2 px-3 py-2 border-b border-b-[rgba(31,27,22,0.06)] cursor-pointer">
                <div class="flex-1 min-w-0" {...{ "x-on:click": "openConversation(c.id)" }}>
                  <div class="text-[13px] text-ink truncate" x-text="c.title || c.label"></div>
                  <div class="text-[11px] text-ink opacity-50 truncate flex items-center gap-1.5">
                    <span class="truncate" x-text="c.pin"></span>
                    <span x-show="fmtCreated(c.createdAt)" class="shrink-0 opacity-80" x-text="'· ' + fmtCreated(c.createdAt)"></span>
                  </div>
                </div>
                <button
                  type="button"
                  {...{ "x-on:click.stop": "deleteConversation(c.id)" }}
                  aria-label="Delete chat"
                  class="w-[22px] h-[22px] border-none bg-transparent text-ink opacity-50 text-sm cursor-pointer"
                >🗑</button>
              </div>
            </template>
            <div x-show="conversations.length === 0" class="px-3 py-4 text-center text-[12px] text-ink opacity-50">No past chats.</div>
          </div>

          {/* ── 🔗 related-chats dropdown — gated on RECALL_SURFACE_ENABLED; parked 2026-06-26. */}
          {RECALL_SURFACE_ENABLED && (
          <div
            x-show="recallOpen"
            {...{ "x-on:click.outside": "recallOpen = false" }}
            class="absolute left-3 right-3 top-[52px] z-10 max-h-[60%] overflow-y-auto bg-cream border border-[rgba(31,27,22,0.12)] rounded-[12px] shadow-[0_8px_24px_rgba(31,27,22,0.18)]"
          >
            <template x-for="m in recallMatches" {...{ ":key": "m.session_id" }}>
              <div
                {...{ ":data-recall-open": "m.session_id" }}
                role="button"
                tabindex={0}
                class="flex items-start gap-2 px-3 py-2 border-b border-b-[rgba(31,27,22,0.06)] cursor-pointer hover:bg-[rgba(31,27,22,0.03)] last:border-b-0"
              >
                <span class="shrink-0 text-[#9d86c2] text-[10px] pt-[2px]">↳</span>
                <span x-text="m.summary" class="text-[13px] text-ink opacity-75 leading-snug truncate"></span>
              </div>
            </template>
            <div x-show="recallMatches.length === 0" class="px-3 py-4 text-center text-[12px] text-ink opacity-50">No related chats.</div>
          </div>
          )}

          {/* ── 📍 pinned-node bar + return-to-node button ── */}
          <div x-show="active()" class="pt-1.5 px-4 pb-2.5 text-[11.5px] text-ink opacity-60 flex items-center gap-2">
            <span>📍</span>
            <span class="font-mono flex-1 min-w-0 truncate" x-text="active() ? active().pin : ''"></span>
            <button
              type="button"
              {...{ "x-show": "canReturnToNode()", "x-on:click": "returnToNode()", ":title": "'Return to ' + (active() ? active().pin : 'node')" }}
              aria-label="Return to source node in graph"
              class="shrink-0 border-none bg-transparent cursor-pointer text-[13px] opacity-70 hover:opacity-100 leading-none"
            >
              ↩
            </button>
          </div>

          {/* ── message body (flex:1, dominant, scrolls) ──
              x-ref="scrollBody" is the auto-scroll target. The x-effect re-runs
              whenever the active conversation's message count or the streaming
              flag changes (sent message, arriving reply, conversation switch),
              scrolling to the bottom after the DOM has rendered ($nextTick).
              Works identically in corner + maximized layouts (same element). */}
          <div
            x-ref="scrollBody"
            role="log"
            aria-label="Chat messages"
            {...{ "x-effect": "active()?.messages.length; streaming; activeId; $nextTick(() => scrollToBottom())" }}
            class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2.5 pt-1.5 px-[14px] pb-[14px]"
          >
            <div x-show="!active()" class="m-auto text-center text-[13px] opacity-[.55] leading-[1.6] max-w-[248px]">
              <span x-text="viewingNode() ? 'Press + to start a chat about the node you are viewing.' : 'Press + to start a chat — I know which page you are on.'"></span>
            </div>
            <div x-show="active() && active().messages.length === 0 && !desyncCta" class="m-auto text-center text-[13px] opacity-[.45]">
              <span x-text="active() && active().anchor ? 'Ask anything about ' + active().label + '.' : 'Ask anything.'"></span>
            </div>

            {/* ── starter-prompt chips — fresh conversation only (zero messages,
                 no CTA pending). Clicking a chip sends that opening message via
                 the normal send() path; the chips then hide (conv has a message).
                 Works identically in corner + maximized layouts. ── */}
            <div x-show="showStarters()" class="mt-auto mb-1 flex flex-wrap gap-1.5 justify-end px-1">
              <template x-for="(p, pi) in starterPrompts" {...{ ":key": "pi" }}>
                <button
                  type="button"
                  {...{ "x-on:click": "sendStarter(p)", "x-text": "p", ":disabled": "streaming" }}
                  class="rounded-full py-[6px] px-3 text-[12px] text-ink border border-[rgba(31,27,22,0.15)] bg-transparent cursor-pointer opacity-80 hover:opacity-100 hover:bg-[rgba(31,27,22,0.04)] transition-colors duration-150"
                ></button>
              </template>
            </div>

            {/* Entry kinds: normal user/assistant bubble · failed → full-width
                muted error card (visually distinct from bubbles) · cancelled →
                quiet centered marker. The island stores FIXED display copy in
                m.text for status entries, so both status branches render plain
                text (x-text). NOTE: x-show only gates DISPLAY of the markdown
                branch — renderMd still EVALUATES on hidden status rows, so the
                XSS defense is renderMd's escape-first contract, not the gate. */}
            <template x-for="(m, i) in (active() ? active().messages : [])" {...{ ":key": "i" }}>
              <div
                {...{ ":style": "m.status === 'failed' ? 'align-self:stretch;max-width:100%;background:rgba(176,60,20,0.05);border:1px solid rgba(176,60,20,0.18);border-radius:12px' : m.status === 'cancelled' ? 'align-self:center;opacity:.45;font-size:11px;padding:2px 0' : m.role === 'user' ? 'align-self:flex-end;background:var(--color-ink);color:var(--color-cream);border-bottom-right-radius:5px' : 'align-self:flex-start;background:#fff;box-shadow:0 1px 3px rgba(31,27,22,.08);border-bottom-left-radius:5px'" }}
                class="max-w-[82%] py-[9px] px-3 rounded-[15px] text-[13px] leading-[1.5] break-words text-ink"
              >
                {/* User messages: plain text (x-text handles XSS automatically). */}
                <span x-show="m.role === 'user'" x-text="m.text"></span>
                {/* Assistant messages: rendered markdown (x-html). The content is
                    XSS-safe: renderMd() HTML-escapes the raw text FIRST before
                    applying Markdown transforms, so model-injected HTML is inert.
                    Status entries are excluded — their copy renders below. */}
                <div x-show="m.role === 'assistant' && !m.status" {...{ "x-html": "renderMd(m.text)" }} class="fc-md"></div>
                {/* Failed turn → error card content: status glyph + fixed copy. */}
                <div x-show="m.status === 'failed'" class="flex items-start gap-1.5">
                  <span aria-hidden="true" class="shrink-0 opacity-70">⚠</span>
                  <span x-text="m.text"></span>
                </div>
                {/* Cancelled turn → quiet stopped marker. */}
                <span x-show="m.status === 'cancelled'" x-text="m.text"></span>
              </div>
            </template>
            {/* Typing dots — gated on isActiveStreaming() so they show ONLY on
                the conversation that originated the in-flight request. A conv
                the user switched to (or a freshly-created one) never inherits
                another conversation's dots. */}
            <div
              x-show="isActiveStreaming()"
              class="self-start flex items-center gap-1 max-w-[82%] py-[11px] px-3 rounded-[15px] rounded-bl-[5px] bg-white shadow-[0_1px_3px_rgba(31,27,22,.08)]"
            >
              <span class="w-[7px] h-[7px] rounded-full bg-ink2 animate-pulse"></span>
              <span class="w-[7px] h-[7px] rounded-full bg-ink2 animate-pulse [animation-delay:200ms]"></span>
              <span class="w-[7px] h-[7px] rounded-full bg-ink2 animate-pulse [animation-delay:400ms]"></span>
            </div>
            <div x-show="error" class="self-center text-xs text-[#b00] opacity-[.85]" x-text="error"></div>

            {/* ── desync CTA — fires only when desyncCta is set ── */}
            <div
              x-show="desyncCta !== null"
              class="self-stretch mt-1 p-3 rounded-[12px] border border-[rgba(31,27,22,0.12)] bg-white text-[12.5px] text-ink"
            >
              <p class="mb-2 opacity-70">
                You're viewing <strong x-text="desyncCta?.targetLabel ?? ''"></strong>, but this chat is about a different node.
              </p>
              <div class="flex flex-col gap-1.5">
                <button
                  type="button"
                  {...{ "x-on:click": "resolveDesync('reanchor')" }}
                  class="w-full rounded-[8px] py-[7px] px-3 text-left text-[12px] border border-[rgba(31,27,22,0.15)] bg-transparent cursor-pointer hover:bg-[rgba(31,27,22,0.04)]"
                >
                  Re-anchor this chat to <strong x-text="desyncCta?.targetLabel ?? ''"></strong>
                </button>
                <button
                  type="button"
                  {...{ "x-on:click": "resolveDesync('new')" }}
                  class="w-full rounded-[8px] py-[7px] px-3 text-left text-[12px] border border-[rgba(31,27,22,0.15)] bg-transparent cursor-pointer hover:bg-[rgba(31,27,22,0.04)]"
                >
                  New chat about <strong x-text="desyncCta?.targetLabel ?? ''"></strong>
                </button>
                <button
                  type="button"
                  {...{ "x-on:click": "desyncCta = null" }}
                  class="self-end text-[11px] opacity-40 border-none bg-transparent cursor-pointer mt-0.5"
                >
                  Cancel
                </button>
              </div>
            </div>

            {/* ── stale CTA — fires only when staleCta is set ── */}
            {/*
             * V4 note: detection is file-level only — a change to any sibling
             * symbol in the same file also triggers this. The copy makes this
             * granularity explicit so the user understands what "current version" means.
             */}
            <div
              x-show="staleCta !== null"
              class="self-stretch mt-1 p-3 rounded-[12px] border border-[rgba(31,27,22,0.12)] bg-white text-[12.5px] text-ink"
            >
              <p class="mb-2 opacity-70">
                The file containing <strong x-text="staleCta?.nodeName ?? ''"></strong> has changed since this chat was pinned
                (<span x-text="staleCta?.pinnedAt ? new Date(staleCta.pinnedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : ''"></span>).
                The detection is file-level — sibling symbols in the same file also trigger this.
              </p>
              <div class="flex flex-col gap-1.5">
                <button
                  type="button"
                  {...{ "x-on:click": "resolveStale('freeze')" }}
                  class="w-full rounded-[8px] py-[7px] px-3 text-left text-[12px] border border-[rgba(31,27,22,0.15)] bg-transparent cursor-pointer hover:bg-[rgba(31,27,22,0.04)]"
                >
                  Keep discussing the version pinned at <span x-text="staleCta?.pinnedAt ? new Date(staleCta.pinnedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : ''"></span>
                </button>
                <button
                  type="button"
                  {...{ "x-on:click": "resolveStale('continue')" }}
                  class="w-full rounded-[8px] py-[7px] px-3 text-left text-[12px] border border-[rgba(31,27,22,0.15)] bg-transparent cursor-pointer hover:bg-[rgba(31,27,22,0.04)]"
                >
                  Use the current version
                </button>
              </div>
            </div>

            {/* ── terminal CTA — fires when terminalCta is set ── */}
            {/*
             * Dead anchor: the pinned node was renamed or removed after a re-index.
             * This is a TERMINAL read-only state — no override, no re-send.
             * The only forward action is to start a new conversation ("+" path).
             */}
            <div
              x-show="terminalCta != null"
              class="self-stretch mt-1 p-3 rounded-[12px] border border-[rgba(31,27,22,0.18)] bg-[rgba(176,0,0,0.04)] text-[12.5px] text-ink"
            >
              <p class="mb-2 opacity-80">
                <strong x-text="terminalCta?.nodeName ?? ''"></strong> was renamed or removed — this chat is now read-only.
              </p>
              <p class="mb-2 text-[11.5px] opacity-55">
                Start a new chat to continue exploring the current version of this code.
              </p>
              <button
                type="button"
                {...{
                  "x-on:click": "newConversation()",
                  ":disabled": "!canAddContext()",
                  ":style": "canAddContext() ? 'cursor:pointer;opacity:.9' : 'cursor:not-allowed;opacity:.4'",
                  "x-text": "viewingNode() ? \"+ Start a new chat about the node you're viewing\" : '+ Start a new chat'",
                }}
                class="w-full rounded-[8px] py-[7px] px-3 text-left text-[12px] border border-[rgba(31,27,22,0.15)] bg-transparent"
              ></button>
            </div>

            {/* ── blocked notice — fires when blockedCta is set ── */}
            {/*
             * Budget hard-stop or quiet-hours active. Informational, dismissible.
             * The draft is already restored inside send() when the signal fires, so
             * dismissing clears the notice and the user can retry when the block lifts.
             */}
            <div
              x-show="blockedCta !== null"
              class="self-stretch mt-1 p-3 rounded-[12px] border border-[rgba(31,27,22,0.12)] bg-[rgba(255,248,220,0.6)] text-[12.5px] text-ink"
            >
              <p class="mb-2 opacity-80" x-text="blockedCta?.message ?? ''"></p>
              <button
                type="button"
                {...{ "x-on:click": "dismissBlockedCta()" }}
                class="self-end text-[11px] opacity-50 border-none bg-transparent cursor-pointer hover:opacity-80"
              >
                Dismiss
              </button>
            </div>
          </div>

          {/* ── context-transparency chip bar — mirrors the 📍
               pinned-node bar above (~line 206) for styling. Renders ABOVE the
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
            <span class="flex items-center gap-1">
              <span>🧠</span>
              <span x-text="contextChips().facts + ' facts'"></span>
            </span>
          </div>

          {/* ── composer: input pill + escape-hatch recall icon + send button ── */}
          <form
            x-show="active()"
            {...{ "x-on:submit.prevent": "send()" }}
            class="flex gap-2 items-center pt-[14px] px-4"
          >
            <input
              type="text"
              x-model="draft"
              {...{ ":disabled": "streaming || desyncCta !== null || staleCta !== null || blockedCta !== null || terminalCta != null" }}
              {...{ ":placeholder": "streaming ? 'Siltpoke is replying — one question at a time…' : (viewingNode() ? 'Ask about this node…' : 'Ask anything…')" }}
              class="flex-1 min-w-0 border border-[rgba(31,27,22,0.1)] rounded-full py-[11px] px-[18px] text-[13px] bg-white outline-none text-ink"
            />
            {/* Escape-hatch recall icon — gated on RECALL_SURFACE_ENABLED; parked 2026-06-26. */}
            {RECALL_SURFACE_ENABLED && (
            <button
              type="button"
              data-recall-from-draft
              {...{ ":disabled": "!draft.trim() || streaming" }}
              title="Find related past chats for this query"
              aria-label="Find related past chats"
              {...{ ":style": "(!draft.trim() || streaming) ? 'opacity:.2;cursor:not-allowed' : 'opacity:.5;cursor:pointer'" }}
              class="w-8 h-8 rounded-full border border-[rgba(31,27,22,0.1)] bg-transparent text-[13px] shrink-0 flex items-center justify-center transition-opacity duration-150"
            >
              🔗
            </button>
            )}
            {/* While streaming the round send button IS the stop
                control — type swaps to plain button (a stop click must never
                re-submit the form), it stays enabled, shows the stop glyph,
                and fires stopStreaming(). Otherwise it is the submit button
                with the standard disabled/dimmed behavior. */}
            <button
              type="submit"
              {...{
                ":type": "streaming ? 'button' : 'submit'",
                "x-on:click": "streaming && stopStreaming()",
                ":disabled": "streaming ? false : (!draft.trim() || desyncCta !== null || staleCta !== null || blockedCta !== null || terminalCta != null)",
                ":style": "(!streaming && (!draft.trim() || desyncCta !== null || staleCta !== null || blockedCta !== null || terminalCta != null)) ? 'border-radius:50%;background:rgba(31,27,22,.07);color:rgba(31,27,22,.35);cursor:default' : 'border-radius:50%;background:var(--color-ink);color:var(--color-cream);cursor:pointer'",
                ":aria-label": "streaming ? 'Stop' : 'Send'",
                "x-text": "streaming ? '■' : '↑'",
              }}
              aria-label="Send"
              class="w-10 h-10 rounded-full border-none text-base shrink-0 flex items-center justify-center transition-colors duration-150"
            >
              ↑
            </button>
          </form>
        </div>
        {/* end panel wrapper (corner ↔ centered-modal layout switcher) */}
        </div>
      </div>
    </div>
  );
}

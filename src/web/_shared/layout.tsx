// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Global HTML wrapper used by every SSR page route.
 *
 * Loads tokens.css + tailwind.css (utilities, no preflight) + HTMX +
 * alpine-morph + the client bundle.
 * Sets hx-boost on <body> so top-level nav is body-swap (script in <head>
 * parses once for the session). alpine-morph + hx-preserve discipline is
 * enforced at the shell / island level — this wrapper only sets the
 * extension up.
 */
import type { PropsWithChildren } from "hono/jsx";
import { BrandIcons } from "./brand-icons";
import { FloatingChat } from "./FloatingChat";
import {
  isPerfTraceEnabled,
  PERF_TRACE_BODY_SCRIPT,
  PERF_TRACE_HEAD_SCRIPT,
} from "./perf-trace";
import { THEME_BOOTSTRAP_SCRIPT } from "./theme-bootstrap";

const HTMX_VERSION = "2.0.4";
const ALPINE_MORPH_VERSION = "2.0.4";

export interface LayoutProps {
  title?: string;
  bodyClass?: string;
  /**
   * URLs of additional island chunks to load BEFORE the main client bundle.
   * Each is rendered as <script defer src={url}> in <head>, placed ahead of
   * /static/index.js so the chunk registers its Alpine.data() factory before
   * Alpine.start() walks the DOM. Use this for routes that ship a route-only
   * island chunk. Replaces the earlier lazy `import()` approach which raced
   * Alpine.start().
   */
  preloadIslands?: readonly string[];
  /**
   * Daemon secret. Two consumers:
   *   1. Forwarded to `<FloatingChat secret>` → projected as `data-secret` on
   *      the panel root, read by floating-chat.ts for `POST /api/chat`.
   *   2. Set as `hx-headers` on `<body>` so every htmx request issued from
   *      ANYWHERE under body — including hx-boosted plain `<form>` posts —
   *      automatically carries `X-Siltpoke-Secret`. This is what lets
   *      `ActionChip`'s `hx-post="/api/action"` and the repo-memory build
   *      form's boosted `POST /api/repo-memory/build` reach their
   *      newly-gated routes without each component threading the secret
   *      individually (daemon-hardening security audit, finding 2).
   * Absent → no hx-headers attribute is rendered (unauthenticated gated
   * POSTs 401 exactly as before hardening — same fail-closed default as
   * every other `secret ?? ""` caller).
   */
  secret?: string;
  /**
   * The page's resolved proj_hash (per-request project resolution — see
   * `src/daemon/project-context.ts`), projected as `data-proj-hash` on the
   * root `<html>` element. Client islands with a write `fetch` (memory-book,
   * chat-stream, active-repos) read it via `document.querySelector("[data-proj-hash]")`
   * and append `?repo=<hash>` so the write targets the same project the page
   * resolved — the server-side write-guard (`isWriteEligible`) checks that hash
   * against the SAME resolution. Absent → "" (no query param appended; the
   * write-guard then falls back to the server-side sticky pin, same as an
   * omitted `?repo=` on any other route).
   */
  resolvedProjHash?: string | null;
}

export function Layout(props: PropsWithChildren<LayoutProps>) {
  const title = props.title ?? "siltpoke";
  const preloads = props.preloadIslands ?? [];
  return (
    <html lang="en" data-proj-hash={props.resolvedProjHash ?? ""}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Both schemes are real now. The ACTIVE one is declared per-block in
            tokens.css (`color-scheme: light|dark` inside each of the four
            blocks) so native scrollbars, dropdowns and form controls follow a
            FORCED theme, not just the system one. This meta is the pre-CSS
            default. */}
        <meta name="color-scheme" content="light dark" />
        {/* ⚡ startup trace — OFF unless SILTPOKE_PERF_TRACE=1. Placed ahead of
            every external <link>/<script> (and ahead of the theme bootstrap)
            because its whole job is to stamp t=0 before anything the page
            fetches or evaluates. Kept after <meta charset> so the charset stays
            inside the first 1024 bytes. */}
        {isPerfTraceEnabled() ? (
          <script dangerouslySetInnerHTML={{ __html: PERF_TRACE_HEAD_SCRIPT }} />
        ) : null}
        <title>{title}</title>
        {/* Brand mark — see src/web/_shared/brand-icons.tsx for why this is a
            component and not two literal <link>s. */}
        <BrandIcons />
        {/* Google Fonts — Pixelify Sans (display) + JetBrains Mono (labels/code)
            + Geist (body), matching the 记忆之书 design system. tokens.font
            references these families; without this link they fall back to
            system-ui. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossorigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Geist:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="/static/tokens.css" />
        {/* Tailwind v4 utilities (incremental adoption). After tokens.css so
            utility classes win over token-var defaults at equal specificity.
            No Preflight is imported (see src/web/tokens/tailwind.css) → existing
            inline-styled screens are untouched. */}
        <link rel="stylesheet" href="/static/tailwind.css" />
        {/* Pre-paint theme application. Mirrors the sidebar-collapse script
            below: reading localStorage in <head> before <body> parses means the
            correct theme is on <html> at first paint, so there is no light
            flash before hydration. Theme goes FIRST because it governs paint.
            `system` deliberately sets NO attribute — the media query in
            tokens.css governs. The else-branch REMOVES the attribute rather
            than leaving a stale one, which is what makes the multi-tab storage
            listener (theme-toggle.ts, Task 6) correct when another tab resets
            to `system`. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
        {/* Pre-Alpine sidebar collapse persistence.
            Reading localStorage in <head> before <body> parses lets the
            sidebar render at the correct width on initial paint — no FOUC
            from 220px → 52px after Alpine hydrates. The class persists on
            <html> across hx-boost body swaps (only <body> is morphed). */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(localStorage.getItem('siltpokeSidebarCollapsed')==='1')document.documentElement.classList.add('sidebar-collapsed-init')}catch(e){}",
          }}
        />
        <style
          dangerouslySetInnerHTML={{
            __html:
              "html.sidebar-collapsed-init [data-sidebar]{width:52px!important}html.sidebar-collapsed-init [data-sidebar] [x-show=\"!collapsed\"]{display:none!important}" +
              // Narrow windows get the same 52px rail, whatever the stored
              // preference says. MEASURED at a 480px window before this rule:
              // the sidebar held 221px and `<main>` was left 259px on ALL five
              // screens (/, /timeline, /memory, /repo-graph, /knowledge), which
              // is less than half the window spent on navigation. Each screen's
              // own grid had already collapsed as far as it could; the width
              // was never theirs to reclaim.
              //
              // `!important` and a media query rather than a width the sidebar
              // island computes: the island binds `width` INLINE
              // (`x-bind:style`), and an inline declaration outranks any
              // stylesheet rule — the same collision that made the collapsed
              // preference above need `!important` in the first place, and the
              // same one the /knowledge grid hit this week.
              //
              // 640px is where the arithmetic turns: 640 - 221 leaves 419px of
              // `main`, about the narrowest column this corpus still reads at.
              // Below that the rail buys back 169px.
              //
              // The toggle goes with it. Leaving it visible would leave a
              // button that flips a state nothing can show — a control that
              // does nothing, which is a shape this project has shipped twice
              // and does not want a third time.
              "@media (max-width:640px){[data-sidebar]{width:52px!important}[data-sidebar] [x-show=\"!collapsed\"]{display:none!important}[data-sidebar-collapse]{display:none!important}}" +
              "@keyframes siltpokeFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-18px)}}" +
              ".pet-float{animation:siltpokeFloat 2.6s ease-in-out infinite;will-change:transform}" +
              ".home-center__creature[data-mood=\"sleepy\"] .pet-float{animation:none;transform:translateY(0)}" +
              ".home-center__creature[data-mood=\"sleepy\"] .pet-shadow{animation:none;transform:scaleX(1);opacity:.22}" +
              "@keyframes siltpokeShadow{0%,100%{transform:scaleX(1);opacity:.26}50%{transform:scaleX(.6);opacity:.08}}" +
              ".pet-shadow{animation:siltpokeShadow 3.2s ease-in-out infinite;will-change:transform,opacity;transform-origin:center}" +
              "@keyframes siltpokeBump{0%{transform:scale(1)}30%{transform:scale(1.18) translateY(-6px)}60%{transform:scale(0.92) translateY(3px)}100%{transform:scale(1)}}" +
              ".pet-bump{animation:siltpokeBump 520ms cubic-bezier(.34,1.56,.64,1);animation-fill-mode:both}" +
              "@keyframes siltpokeScatter{0%{opacity:0;transform:translate(-50%,0) scale(0.6) rotate(0)}15%{opacity:1;transform:translate(-50%,-14px) scale(1.1) rotate(calc(var(--scatter-rot,0deg) / 2))}100%{opacity:0;transform:translate(-50%,-90px) scale(0.8) rotate(var(--scatter-rot,0deg))}}" +
              ".action-scatter{will-change:transform,opacity}" +
              "@keyframes siltpokeBanner{0%{opacity:0;transform:translate(-50%,-16px)}10%{opacity:1;transform:translate(-50%,0)}85%{opacity:1;transform:translate(-50%,0)}100%{opacity:0;transform:translate(-50%,-8px)}}" +
              ".action-banner{will-change:transform,opacity}" +
              ".action-chip:hover{filter:brightness(1.04);transform:translateY(-1px);transition:transform .12s ease,filter .12s ease}" +
              ".action-chip{transition:transform .12s ease,filter .12s ease}" +
              "[x-cloak]{display:none!important}" +
              // Memory Book (记忆之书) animations.
              "@keyframes bkPulse{0%,100%{opacity:.35;transform:scale(1)}50%{opacity:1;transform:scale(1.25)}}" +
              "@keyframes bkRise{from{transform:translateY(8px);opacity:.4}to{transform:none;opacity:1}}" +
              // jumpToFact highlight — a brief inset ring flash that self-clears after 1.5 s
              // (the JS removes the class; animation:forwards keeps the end state until then).
              "@keyframes bkJumpHighlight{0%{box-shadow:inset 0 0 0 2px color-mix(in srgb, var(--color-sky) 85%, transparent)}60%{box-shadow:inset 0 0 0 3px color-mix(in srgb, var(--color-sky) 35%, transparent)}100%{box-shadow:inset 0 0 0 0 color-mix(in srgb, var(--color-sky) 0%, transparent)}}" +
              ".memory-row-highlight{animation:bkJumpHighlight 1.5s ease-out forwards}" +
              ".bk-pulse{animation:bkPulse 1.8s ease-in-out infinite}" +
              ".bk-rise{animation:bkRise .22s ease both}" +
              ".bk-card{transition:box-shadow .15s,transform .15s}" +
              ".bk-card:hover{box-shadow:var(--shadow-lg);transform:translateY(-2px)}" +
              // display lives in a class (not inline) so Alpine x-show's
              // removeProperty('display') restores flex, not the block default.
              ".memory-modal-backdrop{display:flex;align-items:center;justify-content:center}" +
              // Same reason: the pending 确认/拒绝 action row toggles via x-show,
              // so its flex layout lives in a class — not inline — or Alpine's
              // removeProperty('display') would drop it back to block on show.
              // gap:6px matches the two-button pill spacing; no margin-top so
              // alignItems:center in the parent stack centers it flush with the
              // status badge (margin-top was the root cause of the ~4px offset).
              ".memory-pending-actions{display:flex;gap:6px}" +
              // (The repo-graph detail drawer now slides in from the LEFT, and
              // the floating chat lives bottom-right — they no longer overlap, so
              // the earlier :has() chat-shift hack was removed 2026-06-23.)
              ".critic-recent__scroll::-webkit-scrollbar{width:8px}" +
              ".critic-recent__scroll::-webkit-scrollbar-track{background:transparent}" +
              ".critic-recent__scroll::-webkit-scrollbar-thumb{background:var(--color-edge);border-radius:4px}" +
              ".critic-recent__scroll::-webkit-scrollbar-thumb:hover{background:var(--color-ink3)}" +
              ".critic-recent__scroll{scrollbar-width:thin;scrollbar-color:var(--color-edge) transparent}" +
              // fc-md: styles for renderMarkdown output inside assistant bubbles.
              // Scoped to .fc-md so they don't bleed into the rest of the dashboard.
              ".fc-md{font-size:13px;line-height:1.55;word-break:break-words}" +
              ".fc-md p.fc-md-p{margin:0 0 .55em}" +
              ".fc-md p.fc-md-p:last-child{margin-bottom:0}" +
              ".fc-md code.fc-md-ic{background:color-mix(in srgb, var(--color-ink) 7%, transparent);border-radius:3px;padding:.1em .3em;font-family:ui-monospace,monospace;font-size:.92em}" +
              ".fc-md pre.fc-md-pre{background:color-mix(in srgb, var(--color-ink) 6%, transparent);border-radius:6px;padding:.6em .75em;margin:.45em 0;overflow-x:auto;max-width:100%}" +
              ".fc-md pre.fc-md-pre code.fc-md-code{background:none;padding:0;font-family:ui-monospace,monospace;font-size:.88em;white-space:pre;display:block}" +
              ".fc-md h2.fc-md-h,.fc-md h3.fc-md-h,.fc-md h4.fc-md-h{font-weight:600;margin:.6em 0 .25em}" +
              ".fc-md h2.fc-md-h{font-size:1.05em}" +
              ".fc-md h3.fc-md-h{font-size:.98em}" +
              ".fc-md h4.fc-md-h{font-size:.93em}" +
              ".fc-md ul.fc-md-ul,.fc-md ol.fc-md-ol{margin:.35em 0 .35em 1.3em;padding:0}" +
              ".fc-md ul.fc-md-ul{list-style:disc}" +
              ".fc-md ol.fc-md-ol{list-style:decimal}" +
              ".fc-md li{margin:.12em 0}" +
              ".fc-md a.fc-md-a{color:var(--color-ink);text-decoration:underline;opacity:.8}" +
              ".fc-md a.fc-md-a:hover{opacity:1}",
          }}
        />
        <script src={`https://unpkg.com/htmx.org@${HTMX_VERSION}`} defer></script>
        <script
          src={`https://unpkg.com/htmx-ext-alpine-morph@${ALPINE_MORPH_VERSION}`}
          defer
        ></script>
        {/* Preload island chunks as type=module so ESM `export { ... }`
            syntax parses (classic defer would silently
            reject and skip evaluation → the island's registration never
            runs). Module scripts have implicit defer + interleave with
            classic defer scripts in document order, so a preloaded island
            still registers BEFORE index.js calls Alpine.start(). */}
        {preloads.map((url) => (
          <script type="module" src={url}></script>
        ))}
        <script src="/static/index.js" defer></script>
      </head>
      <body
        class={props.bodyClass}
        hx-boost="true"
        hx-ext="alpine-morph"
        hx-headers={props.secret ? JSON.stringify({ "X-Siltpoke-Secret": props.secret }) : undefined}
        style={{
          margin: 0,
          background: "var(--color-cream)",
          color: "var(--color-ink)",
          fontFamily: "var(--font-body)",
        }}
      >
        {props.children}
        <FloatingChat secret={props.secret} />
        {/* Last element in <body>: `bodyEnd - headStart` is the document's own
            parse cost. OFF unless SILTPOKE_PERF_TRACE=1. */}
        {isPerfTraceEnabled() ? (
          <script dangerouslySetInnerHTML={{ __html: PERF_TRACE_BODY_SCRIPT }} />
        ) : null}
      </body>
    </html>
  );
}

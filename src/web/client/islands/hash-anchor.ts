// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Make `#fragment` links work again after an hx-boost navigation.
 *
 * ── THE DEFECT THIS EXISTS FOR ─────────────────────────────────────────────
 * `<body hx-boost="true">` (`src/web/_shared/layout.tsx`) turns every same-origin
 * link click into an XHR plus a `pushState` swap. The URL that lands in the
 * address bar carries the fragment, but the browser never performs a fragment
 * NAVIGATION — so it does not scroll, and `:target` does not match. Any feature
 * that relies on `#anchor` therefore works on a hard reload and silently does
 * nothing on a click, which is the only way a reader ever reaches it.
 *
 * Measured on `/knowledge` before this file existed: opening a document from a
 * row 2614px down a 958px-tall viewport left the row exactly where it was,
 * `window.scrollY` 0, `:target` unmatched. The e2e that was supposed to cover
 * this ran with `javaScriptEnabled: false` — where there is no htmx, the click
 * IS a real navigation, and the anchor works natively. The check passed in a
 * configuration no user runs. That is the shape this whole slice was written to
 * catch, so it is worth naming plainly rather than burying in a fix.
 *
 * ── WHY `block: "nearest"` ─────────────────────────────────────────────────
 * The scroll container on every dashboard page is `<main>`
 * (`src/web/shells/Dashboard.tsx:353`, `overflow: auto`) — NOT the window. That
 * matters twice over: `window.scrollY` is always 0 here and says nothing, and a
 * scroll has to be delegated to the element rather than computed against the
 * viewport. `scrollIntoView` walks its own ancestors and handles that; `nearest`
 * additionally makes the call a NO-OP when the target is already visible, so a
 * fragment pointing at a row that is already on screen does not yank the page.
 *
 * ── WHY THIS DOES NOT WEAKEN THE JAVASCRIPT-OFF STORY ──────────────────────
 * With JavaScript disabled there is no htmx, the click is a real navigation,
 * and the browser does this natively. This handler is the COMPLEMENT of that
 * path, never a replacement for it: if it were deleted, the JS-off behaviour
 * would be unchanged and only the boosted path would regress. Do not let it
 * become the only mechanism — an href must always carry the fragment itself.
 */

/**
 * The element a fragment names, or null.
 *
 * Tries the raw fragment first and the percent-decoded form second, because
 * ids in this app are built with `encodeURIComponent` (`rowAnchorId` in
 * `src/knowledge/filter-params.ts`) — a document key carries `:` and `/`, so
 * the id legitimately contains `%3A` and `%2F` as LITERAL characters. Chrome
 * hands `location.hash` back in the encoded form, which matches the id
 * directly; other engines (and anything that has round-tripped the URL) may
 * hand back the decoded form, which does not. Trying both costs one lookup and
 * removes a whole class of "works in one browser" bug.
 */
function targetOf(hash: string): HTMLElement | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length === 0) return null;
  const direct = document.getElementById(raw);
  if (direct) return direct;
  try {
    return document.getElementById(decodeURIComponent(raw));
  } catch {
    // A malformed escape (`%zz`) throws rather than returning the input.
    return null;
  }
}

function scrollToHash(): void {
  const el = targetOf(window.location.hash);
  if (!el) return;
  el.scrollIntoView({ block: "nearest" });
}

// `htmx:afterSettle` rather than `afterSwap`: the swap puts the new nodes in
// the DOM, but settling is when htmx has finished its own class/attribute
// passes, so measuring before it can scroll to a position that then moves.
document.addEventListener("htmx:afterSettle", scrollToHash);

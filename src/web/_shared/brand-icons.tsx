// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * The `<link>`s that put the Siltpoke mark in the browser tab, plus the script
 * that keeps it the opposite colour from the tab bar behind it.
 *
 * This is a component rather than markup copied into each `<head>` because the
 * daemon renders SIX standalone heads, not one: `Layout` covers every
 * dashboard screen, and `src/daemon/routes/explain.tsx` builds four of its
 * own. Hand-copying shipped the icon on two of them and silently missed the
 * other two — including `/explain/:id`, the page a real explanation opens at.
 *
 * ## Why a script and not an SVG media query
 *
 * The mark is a single-colour glyph on a transparent ground, so it needs black
 * ink on a light tab bar and white ink on a dark one. The usual trick is one
 * SVG favicon carrying its own `@media (prefers-color-scheme: dark)` rule.
 *
 * **That was built, shipped, and observed to fail in Chrome.** Chrome
 * rasterises a favicon SVG without applying its stylesheet, so a document
 * holding a black `<image>` and a white one drew BOTH, and the last one won:
 * a white cat on a white tab bar, in light mode, permanently. Nothing in the
 * page, the network log, or any assertion we can write about the file sees
 * this — the icon is painted in browser chrome, which no screenshot and no
 * automated check we have can read. It took looking at the tab.
 *
 * So the choice is made in JavaScript, against `matchMedia`, which every
 * browser answers the same way. Two single-variant PNGs, no conditional
 * rendering inside an asset, nothing that depends on how a favicon rasteriser
 * treats CSS.
 *
 * ## What it follows
 *
 * `prefers-color-scheme` — the OS/browser appearance, NOT the dashboard's own
 * theme toggle. The icon sits in browser chrome, so the tab bar is the
 * background it has to stay legible against; forcing the site to light on a
 * dark OS must not turn the icon black.
 *
 * With scripting off, the static `<link>` below leaves the light-mode (black)
 * glyph in place. That is the honest fallback, not a fix.
 *
 * `apple-touch-icon` is deliberately the ROUND, dark-backed logo rather than
 * the bare glyph: iOS composites a home-screen icon over an opaque tile and
 * discards transparency, which would leave a black glyph invisible.
 *
 * All three assets live in `src/web/assets/` (tracked) and are served by
 * `src/web/routes/static.ts` — NOT `public/static/`, which is gitignored and
 * whose contents `scripts/pack-dist.sh` (a `git archive`) would leave out of
 * the release tarball.
 */

/** Black ink — for a LIGHT tab bar. The no-script default. */
export const FAVICON_LIGHT_HREF = "/static/favicon-light.png";
/** White ink — for a DARK tab bar. */
export const FAVICON_DARK_HREF = "/static/favicon-dark.png";
export const APPLE_TOUCH_ICON_HREF = "/static/apple-touch-icon.png";

/**
 * Points `<link rel="icon">` at whichever variant contrasts with the current
 * scheme, and keeps doing so when the scheme changes underneath a live tab.
 *
 * The link element is REPLACED rather than having its `href` reassigned:
 * browsers cache the favicon per element and an in-place href change is
 * unreliably picked up. Wrapped in try/catch because a dead favicon must never
 * take a page's `<head>` down with it.
 *
 * Behaviour is covered in tests/web/_shared/brand-icons.test.ts against a
 * stubbed `matchMedia`, which is the only part of this that a test can reach —
 * whether the browser then PAINTS the chosen file is not observable to us.
 */
export const FAVICON_SCHEME_SCRIPT = `(function(){try{
var L=${JSON.stringify(FAVICON_LIGHT_HREF)},D=${JSON.stringify(FAVICON_DARK_HREF)};
var mq=window.matchMedia("(prefers-color-scheme: dark)");
function apply(){
var old=document.querySelector('link[rel="icon"]');
var next=document.createElement("link");
next.rel="icon";next.type="image/png";next.setAttribute("sizes","64x64");
next.href=mq.matches?D:L;
if(old&&old.parentNode)old.parentNode.removeChild(old);
document.head.appendChild(next);
}
apply();
if(mq.addEventListener)mq.addEventListener("change",apply);else if(mq.addListener)mq.addListener(apply);
}catch(e){}})();`;

export function BrandIcons() {
  return (
    <>
      <link rel="icon" type="image/png" sizes="64x64" href={FAVICON_LIGHT_HREF} />
      <link rel="apple-touch-icon" sizes="180x180" href={APPLE_TOUCH_ICON_HREF} />
      {/* After the <link> above, so the script's querySelector finds it. */}
      <script dangerouslySetInnerHTML={{ __html: FAVICON_SCHEME_SCRIPT }} />
    </>
  );
}

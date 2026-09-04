// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The pre-paint theme-application script, as a single exported string.
 *
 * Every SSR page that wants "no light flash before hydration" needs this
 * exact script in `<head>`, BEFORE any theme-dependent styling — reading
 * localStorage and stamping `data-theme` on `<html>` before the browser
 * paints. It used to be re-authored as an inline string literal at each call
 * site (`layout.tsx` once, `explain.tsx` four times, fix round 1 found) —
 * five byte-identical copies with nothing pinning them together. That is
 * exactly the duplicated-source-of-truth shape this same task deleted from
 * `explain.tsx`'s old `:root` color blocks, one layer up: a future change to
 * the storage key, or to what `system` means, updates the literal string in
 * one file and silently leaves every other copy on the old behavior.
 *
 * Built FROM `THEME_KEY` (not a second hardcoded `'siltpokeTheme'` string) so
 * a key rename is a one-line change here, not a find-and-replace across every
 * call site. `system` deliberately sets NO attribute — the media query in
 * tokens.css governs — and the else-branch REMOVES the attribute rather than
 * leaving a stale one, which is what makes the multi-tab storage listener
 * (`theme-toggle.ts`, Task 6) correct when another tab resets to `system`.
 *
 * Purely a string constant: no DOM, no listeners, safe to import from SSR
 * route modules (`src/daemon/routes/*.tsx`) as well as `src/web/_shared`,
 * the same reasoning `theme-state.ts` documents for keeping ITS exports pure.
 *
 * The valid-state check embedded in the script (`ATTR_STATES` below) is
 * DERIVED from `normalizeTheme` rather than re-hardcoded as a second
 * `t==='dark'||t==='light'` literal (final dark-mode branch review, Minor):
 * the earlier version of this file wrote that condition out by hand, so a
 * fourth theme state added to `normalizeTheme`/`THEME_ORDER` would apply
 * everywhere in the app EXCEPT at this first-paint script — the one place
 * "no flash before hydration" actually matters. `ATTR_STATES` is computed by
 * asking `normalizeTheme` itself which of `THEME_ORDER`'s states survive
 * unchanged (i.e., are NOT coerced to `system`), so extending `normalizeTheme`
 * to accept a new state keeps this script correct with no matching edit here.
 */
import { normalizeTheme, THEME_KEY, THEME_ORDER } from "./theme-state";

// `system` is deliberately excluded even though `normalizeTheme("system")`
// is also its own identity — it's the one state that sets NO attribute (the
// tokens.css media query governs instead), not merely "some other state
// normalizeTheme didn't recognize".
const ATTR_STATES = THEME_ORDER.filter((s) => s !== "system" && normalizeTheme(s) === s);
const ATTR_STATE_CHECK = ATTR_STATES.map((s) => `t==='${s}'`).join("||");

export const THEME_BOOTSTRAP_SCRIPT =
  `try{var t=localStorage.getItem('${THEME_KEY}');` +
  `if(${ATTR_STATE_CHECK})document.documentElement.setAttribute('data-theme',t);` +
  "else document.documentElement.removeAttribute('data-theme')}catch(e){}";

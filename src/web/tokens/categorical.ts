// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Categorical (non-brand) color namespaces — kind-coded identity palettes
 * that are NOT part of the 16 brand tokens in `palette.ts`. Split out of
 * `palette.ts` in Task 10b batch 2's fix round 1 (review round 1, directed
 * item B): `palette.ts` had grown to 703 lines against the repo's 400 soft /
 * 800 hard file-LOC cap, and batch 3 (the largest remaining family set)
 * would have pushed it past 800. This module holds the SAME kind of content
 * `palette.ts` does (a raw color literal, only allowed in an EXEMPT module —
 * see `scripts/lint-no-hardcoded-color.ts`'s `EXEMPT` set, which lists this
 * file alongside `palette.ts`), just under a name that groups the
 * "categorical identity" namespaces separately from the brand palette.
 *
 * Both exports are re-exported from `palette.ts` (and, transitively,
 * `tokens.ts`), so no call site anywhere in the codebase needed to change —
 * this is a pure file-organization split, not an API change.
 */

/**
 * The graph screen's own semantic palette (RepoGraph.tsx / repo-graph.ts) —
 * "confidence" ink for the Path-Highlight trace feature's node/edge kinds.
 * Distinct from the 16 brand tokens in `palette.ts` on purpose (spec: adding
 * a namespace that just relocates 85 literals under one name would preserve
 * the original problem). Only the three canvas-facing marks live here — each
 * is drawn directly on the `cream` canvas (an edge stroke, an icon, a node
 * border) and is tested against it below. Everything else RepoGraph.tsx
 * needed (tint washes, borders, text-on-tint, text-on-fill) is DERIVED from
 * these three (or from the 16 brand tokens) via CSS `color-mix()` at the
 * call site — see RepoGraph.tsx — rather than minted as more literals here,
 * for the same anti-parking-lot reason. A "text/icon legible when painted ON
 * one of these three fills" token was considered and rejected: its dark-theme
 * value is necessarily near-black (to read on the light fill Step 4 requires
 * for the 3:1-on-canvas floor below), which collides with `dark.cream`
 * (also near-black) and can never itself clear the below test — so it can't
 * be a `GraphToken`. `var(--color-onAccent)` covers this need instead — see
 * the comment below the dark-value derivation for why a bespoke token was
 * tried, then found unnecessary.
 *
 * Light values: the source prototype's `resolved` gold (`#c9871f`, carried
 * verbatim from the pre-token `.rg-host` block) measures 2.79:1 on
 * `light.cream` — under the 3:1 floor this file now enforces on every graph
 * token, unlike the 16 brand tokens in `palette.ts` (which have a written,
 * dated exemption for six pre-existing light-mode gaps, deferred 🌗
 * 2026-08-01). There is no such exemption for a token that didn't exist
 * before this commit against THE 3:1 FLOOR THIS FILE ENFORCES, so `resolved`
 * is darkened the smallest HSL-lightness step that clears THAT floor with a
 * working margin (−0.05 L → 3.46:1); `unresolved` and `unresolvable` already
 * cleared it (4.33:1 / 6.98:1) and are untouched. (This specific light-value
 * change is under separate human review per the 2026-08-01 decisions log —
 * kept as-is here, not to be assumed final.)
 *
 * KNOWN, NOT closed (final dark-mode branch review, Minor): 3.46:1 clears
 * the 3:1 floor above but not the SEPARATE 4.5:1 body-text floor — and
 * `resolved` also gets painted as literal body text at one site
 * (RepoGraph.tsx `.ph-tree-fn .ph-tlabel`, 11.5px, not WCAG "large text"),
 * where 3.46:1 falls short. This file's own module-level test only asserts
 * the 3:1 graphical floor for every graphPalette entry (see
 * `unresolvable`'s SEPARATE, additional 4.5:1 body-text assertion further
 * below for the established pattern that closes this same class of gap for
 * a different token) — `resolved` has no matching 4.5:1 assertion, so this
 * is a live, unasserted gap, not merely a documentation nit. Left as-is
 * rather than force-lifted here: the light value is already under the
 * separate human review named above, and lifting it further specifically to
 * chase 4.5:1 would be relitigating that pending call rather than reporting
 * it, and would also narrow `resolved`'s hue-distinctness margin against
 * `unresolved` beyond what that review has considered. Recording it here,
 * next to the value it concerns, is the fix — not a numeric change.
 *
 * Dark values: Step 4 says "start from the light hue with lightness raised
 * until the 3:1 assertion passes" — each was raised the SMALLEST HSL-lightness
 * step that clears 3:1 against `dark.cream` (#151515) with a comfortable
 * margin, keeping the hue/saturation (and therefore the "which state is
 * this" identity) as close to the light value as the floor allows:
 *   resolved:     +0.10 L → 8.08:1 vs cream (vs the 3:1 floor)
 *   unresolved:   +0.12 L → 5.77:1 vs cream
 *   unresolvable: +0.22 L → 5.00:1 vs cream, 4.57:1 vs paper — NOT +0.15
 *     (which only cleared 4.09:1/3.74:1). `unresolvable` is also rendered as
 *     BODY TEXT at several sites (RepoGraph.tsx `.rm-add-err`, `.ph-unres
 *     .nname`, `.ph-err b`, `#rg-ph-fallback b`, `.ph-class.unresolvable`),
 *     none of which is WCAG "large text" — those need the 4.5:1 body floor,
 *     not the 3:1 graphical floor the mandated graphPalette test alone
 *     checks. `unresolvable` had 1.36x headroom over the 3:1 floor at the
 *     smaller step, so the lift was free room, not a forced trade-off; the
 *     margin against `unresolved` (still hue-distinct — orange vs red-orange)
 *     narrows from 1.41:1 to 1.15:1 luminance-contrast but the two remain
 *     distinct hex values (see the graph-palette distinctness test).
 */
export const graphPalette = {
  light: {
    resolved: "#b3781c",
    unresolved: "#c0531a",
    unresolvable: "#9b2d1f",
  },
  dark: {
    resolved: "#e1a03a",
    unresolved: "#e37034",
    unresolvable: "#dc5e4e",
  },
} as const;

export type GraphToken = keyof typeof graphPalette.light;

/**
 * TraceWaterfall's span-"kind" identity palette (Task 10b, migration batch
 * 2, the maintainer's 2026-08-02 decision) — a 3rd standalone categorical
 * namespace, built the same way `graphPalette` was in Task 9: light+dark
 * pairs, a contrast gate against the surface each color actually paints on,
 * and a within-theme distinctness assertion. NOT a downgrade to the 5 brand
 * accents — TraceWaterfall.tsx's own docstring is explicit that the brand
 * palette is "too pastel for differentiating phases at a glance" and these
 * hexes deliberately push toward saturated primaries.
 *
 * Surface verified before choosing the floor: every KIND_COLORS value is a
 * GRAPHICAL bar fill only — the duration text (`{ms}ms`) renders in a
 * SEPARATE sibling div using `tokens.color.ink`, not on top of the bar; the
 * only text-shaped use of a bar color is the `title` attribute (a native
 * browser tooltip, not rendered DOM text). So the floor is 3:1 against
 * `TRACK_BG` (`tokens.color.edge`, itself already theme-aware), not 4.5:1 —
 * confirmed by reading TraceWaterfall.tsx's JSX, not assumed from the name.
 *
 * `siltpoke.summarizer.haiku` and `siltpoke.brain.verify` share ONE literal
 * (`#2d6b22`) in the pre-migration KIND_COLORS record — a pre-existing
 * design choice (not a typo the classification flagged for collapsing), so
 * both keys reference the SAME token (`summarizerHaiku`) here rather than
 * two independently-tunable slots that happen to start equal — that is
 * exactly the shape that produces an accidental collision after a re-tune,
 * which this file's whole design is trying to prevent.
 *
 * `DEFAULT_BAR_COLOR` (the fallback for an unmapped span name) is NOT a
 * `KindToken` — it folds into `tokens.color.ink` instead (near-exact match
 * to its own literal, `#2a241c` vs `#1f1b16`) as a deliberate "this is not a
 * recognized kind, render it neutral" signal, not a 10th competing hue.
 *
 * Light values are the literals already live in the app today, held
 * unchanged (same precedent as the 16 brand tokens) — `rubricTier1` is a
 * pre-existing sub-3:1 gap against `light.edge` (2.711:1), pinned rather
 * than fixed, same "held not improved" treatment Task 10b batch 1 gave the
 * memory-palette's pre-existing gaps.
 *
 * Dark values: independently HSL-lightness-lifted (hue/saturation held)
 * until 3:1 against `dark.edge` clears — EXCEPT `rubricTier2` and
 * `critiquePersist`, where an independent per-key lift converges onto a
 * visually-indistinguishable neighbor (measured, not assumed — see the
 * palette test's RED evidence): `rubricTier1`/`rubricTier2` share the same
 * light-mode HUE (26.17° / 26.42°, same family, different lightness only —
 * the pre-existing design is "one hue, two intensities"), so lifting both to
 * the SAME 3:1 target lightness converges them to RGB distance 3.6 (of a
 * ~440 max) — collapsed in all but name. `promptBuild`/`critiquePersist`
 * have the same problem for the same reason (both near-black/near-neutral
 * hues in light mode). Fixed by rotating ONLY the harder-to-place member of
 * each pair by a fixed hue offset during its own lift search
 * (`rubricTier2` −16°, `critiquePersist` +150°) rather than relaxing the
 * 3:1 floor or picking an arbitrary unverified hex — re-verified after the
 * rotation that the 3:1 floor still clears AND the RGB-distance
 * distinctness check (>= 40 pairwise, the palette test's own threshold)
 * passes against every other dark kind color, not just the one it collided
 * with — review round 1 (Important 3) found the closest SURVIVING dark pair
 * is actually `rubricTier1`/`rubricTier2` itself at 54.36 (real headroom
 * above the 40 floor is 14.36, not the 30+ a looser reading might suggest),
 * with `intentClassify`/`brainFind` next at 64.66 — both live-computed and
 * asserted in the palette test, not just claimed here. `critiquePersist`'s
 * light value is untouched (10.86:1 vs `light.edge`, no lift needed there)
 * — only its dark derivation needed the redesign, since the collision is
 * dark-mode-only (a genuinely new design problem this task surfaces, not a
 * pre-existing one to hold).
 */
export const kindPalette = {
  light: {
    turn: "#9c1c1c",
    summarizerHaiku: "#2d6b22",
    rubricTier1: "#c45a08",
    rubricTier2: "#8a3f04",
    intentClassify: "#1e6a6a",
    promptBuild: "#3a2e22",
    brainFind: "#1c5a8a",
    responseParse: "#a8267a",
    critiquePersist: "#1a1a14",
  },
  dark: {
    turn: "#e05555", // 3.033:1 vs dark.edge
    summarizerHaiku: "#3f9630", // 3.042:1 vs dark.edge
    rubricTier1: "#d56209", // 3.023:1 vs dark.edge
    rubricTier2: "#f83910", // hue -16deg during lift (see docstring); 3.025:1 vs dark.edge
    intentClassify: "#299292", // 3.045:1 vs dark.edge
    promptBuild: "#9e7d5c", // 3.002:1 vs dark.edge
    brainFind: "#2b89d2", // 3.040:1 vs dark.edge
    responseParse: "#d750a7", // 3.030:1 vs dark.edge
    critiquePersist: "#758595", // hue +150deg during lift (see docstring); 3.004:1 vs dark.edge
  },
} as const;

export type KindToken = keyof typeof kindPalette.light;

// A dedicated "text/icon on a graph fill" token (a light/dark white/black
// pair) was built and then removed here. History, since the near-miss is not
// obvious from the numbers alone: `var(--color-onAccent)` under-contrasted on
// `.rc-yes` (RepoGraph.tsx, background:var(--unresolvable)) in dark theme —
// 4.09:1 against `unresolvable`'s ORIGINAL +0.15 dark lift, under the 4.5:1
// text floor (independent-review finding). Raising `unresolvable`'s dark
// lift to +0.22 above (a change independently required by the body-text
// finding right above this comment) moved `onAccent`'s own dark value
// (#151515) to 5.00:1 against the new `unresolvable` — clearing the floor as
// a side effect, with onAccent's light value already at 7.53:1. Once the
// existing, already-tested `onAccent` covers all three call sites
// (`.ph-flag` on `resolved` 3.74/8.08:1, `.ph-genbtn:hover` on `moss`
// 3.18/8.97:1, `.rc-yes` on `unresolvable` 7.53/5.00:1 — light/dark each),
// a second bespoke token duplicating its job was unjustified complexity.

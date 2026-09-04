// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The raw color palettes. THIS IS THE ONLY MODULE ALLOWED TO CONTAIN A COLOR
 * LITERAL (see scripts/lint-no-hardcoded-color.ts).
 *
 * KEY NAMES ARE ROLE NAMES, NOT COLOR NAMES. `cream` means "page background";
 * in the dark palette it is #151515, which is not cream. Renaming them to
 * semantic names was considered and rejected in the design (spec §4) because
 * it means a 1723-site migration for no functional gain.
 */
export const palette = {
  light: {
    cream: "#faf6ec",
    paper: "#f4eedf",
    paperD: "#e8dec7",
    edge: "#d8cbab",
    ink: "#1f1b16",
    ink2: "#5a4f3f",
    ink3: "#8a7c64",
    terra: "#d96b6b",
    amber: "#e8a85c",
    moss: "#7a9a5e",
    sky: "#7fb0c8",
    violet: "#9d86c2",
    lcd: "#b8c2a4",
    lcdInk: "#2a3a26",
    egg: "#f6c8c8",
    egg2: "#e89c9c",
    onAccent: "#ffffff",
    // Per-accent text-on-fill tokens (Task 10, decided item 2). `onAccent`
    // covers non-text marks (icons, borders — the 3:1 floor) but is NOT
    // legible AS TEXT on every accent in every theme: it is literally white
    // here, and terra/amber/moss/sky/violet are themselves light-to-mid tones
    // in light mode, so white-on-accent measures 2.06-3.35:1 (see the
    // contrastRatio table in the commit report) — under the 4.5:1 text floor.
    // `ink` (near-black) is what actually clears 4.5:1 against every LIGHT
    // accent fill, so these four reuse `ink`'s value here rather than invent
    // new hex — same reasoning as `onAccent` reusing a value across accents,
    // just the other polarity. Four keys, not one shared token, so a future
    // per-accent fill re-tune can move one without touching the others.
    onTerra: "#1f1b16",
    onAmber: "#1f1b16",
    onMoss: "#1f1b16",
    onSky: "#1f1b16",

    // ---- Task 10b, migration batch 1 (memory palette + chat/notice bubble
    // palette). Every dark value below was chosen by lifting the light hue's
    // HSL lightness (script-driven, see tests/web/tokens/palette.test.ts and
    // the task-10b2 report) until `contrastRatio` clears the floor written
    // next to it — never eyeballed. Light values are the literals already
    // live in the app today; per the "held at today's level" precedent
    // above, a pre-existing light-mode gap is not fixed here (several of
    // these DO fall under 4.5:1 on `paper` in light mode already — that is
    // not new, and out of this task's scope) — only the dark value is a
    // fresh floor requirement, since dark mode has no "today" baseline.

    // A 6th brand accent — teal, "informational/active" identity. Shared by
    // ActiveReposPanel's REPO_THEME and Chat.tsx's notice bubble (Task 10's
    // own worked example named these `bubbleNotice*`; the classification
    // found REPO_THEME and the worked example share 3 of 4 values byte-for-
    // byte — same design intent invented twice, collapsed here into one
    // family instead of two near-duplicate token sets).
    teal: "#5e9ca3",
    // teal's "ink" companion — small-caps subtitle text / notice-bubble body
    // copy painted on `tealWash`, NOT on the full `teal` fill (that role is
    // `onAccent`, already proven at 3.11:1 light / 5.88:1 dark against
    // `teal` for the icon stroke). Deliberately NOT named `onTeal` — the
    // onX naming in this file means "text on a FULL saturated accent fill,"
    // and this token's actual binding surface is the pale `tealWash`
    // background, a different role (parallel to `memTypeInk*` below, not to
    // `onSky`/`onMoss`). Dark value lifted vs `tealWash`'s own dark value
    // (#202524 harder than paper) to 4.51:1, clearing the 4.5:1 TEXT floor
    // (Chat.tsx's notice copy is real body text — the classification flagged
    // this exact confusion as the Task 9 floor-violation shape to avoid).
    tealInk: "#4f878d",
    // Notice/active wash — opaque pale bg+edge, not alpha-derived (mixing
    // teal into paper cannot reproduce this hex: paper's G channel is
    // already lower than the target's, so an opaque-to-opaque color-mix
    // guess would silently pick a different, unverified color — minted as a
    // literal pair instead, per the same reasoning MessagesView's ROLE_BG
    // below uses).
    tealWash: "#edf3f2",
    tealWashEdge: "#cdddd9",

    // Memory type identity "ink" — the small-caps subtitle / pill-text
    // companion of each type's brand-accent color (sky/violet/moss), a
    // DIFFERENT role from Task 10a's onSky/onMoss (those are text on the
    // FULL accent fill; these are text on `memCardBg` or a pale type-tint).
    // `memTypeInkProcedural` consolidates a 3-way latent inconsistency the
    // classification found: memory-book-helpers.ts had `#5e7048`,
    // MemoryByTypeCards.tsx and MemoryFilterBar.tsx each independently had
    // `#6f8a54` — three files, three slightly different "procedural ink"
    // shades for the same role. memory-book-helpers.ts is TYPE_META's
    // canonical source (per the classification), so its value wins; the
    // other two call sites migrate to match, not stay literal.
    memTypeInkSemantic: "#5a86a0",
    memTypeInkEpisodic: "#8a72a8",
    memTypeInkProcedural: "#5e7048",

    // Memory status ink — the confirmed/awaiting/retired label + chip color.
    memStatusActiveInk: "#5a7a3e",
    memStatusPendingInk: "#a06a1e",
    memStatusRetiredInk: "#b84a4a",

    // Memory kind badge ink (style / profile / untagged fact classification).
    memKindStyle: "#c2783a",
    memKindProfile: "#6b7a9a",
    memKindUntagged: "#a89a86",

    // Memory-row card surface. The single most-repeated literal in the whole
    // sweep (memory-book-helpers.ts, MemoryByTypeCards.tsx ×3 gradients,
    // MemoryAlpineRow.tsx, MemoryModal.tsx, ActiveReposPanel.tsx,
    // WorkingMemoryPanel.tsx). MemoryByTypeCards.tsx's episodic gradient used
    // `#fffdf9` (one hex unit off `#fffdf8`) — a typo, not a design decision
    // — folded into this one value rather than kept as a second token.
    memCardBg: "#fffdf8",
    memCardBgRetired: "#f6f1e6",

    // Working-memory's own "ink" companion (not a `MemoryType`, so it has no
    // TYPE_META entry to draw from) — used as the WORKING subtitle + card
    // accent text in both MemoryByTypeCards.tsx and WorkingMemoryPanel.tsx.
    memWorkingInk: "#c06a64",
    // Working-type card border + gradient 2nd stop, shared by
    // MemoryByTypeCards.tsx and WorkingMemoryPanel.tsx. The panel's gradient
    // 2nd stop was `#f7edea`, one hex unit off MemoryByTypeCards' `#f6edea`
    // — same typo shape as memCardBg above, folded into one value.
    memWorkingBorder: "#e6cfc9",
    memWorkingGradient2: "#f6edea",
    memWorkingDivider: "#eedcd6",
    // Per-type card gradient 2nd stop (semantic/episodic/procedural — working
    // has its own `memWorkingGradient2` above, already shared with
    // WorkingMemoryPanel.tsx). Tried `color-mix(accent, paper)` first per the
    // classification's recommendation; the best-fit search (see task-10b2
    // report) lands at 0% for all three — these were hand-tuned independent
    // of the accent, not derived from it, so an opaque-to-opaque color-mix
    // guess would silently render a different pale tint than what's live
    // today. Minted as literal pairs instead, same reasoning as
    // MessagesView's `roleBg*` and teal's `tealWash` above.
    memTypeGradient2Semantic: "#f5eee2",
    memTypeGradient2Episodic: "#f4eef2",
    memTypeGradient2Procedural: "#f1f3ea",
    // Per-type card border (semantic/episodic/procedural). Review round 1,
    // Important 6: an earlier version of this file replaced these three with
    // `color-mix(accent, paper)`, described in the call site as "the
    // best-fit weight." Recomputed with 8-bit rounding, the best fits were
    // NOT close: episodic in particular loses its lavender cast for a grey
    // one (`#ddd2d7` vs the real `#ddd0e2` — B −11, G +2). That is a live
    // light-mode color change this diff was not supposed to make (every
    // OTHER opaque-to-opaque pale wash in this batch — `roleBg*`,
    // `tealWash`, `memTypeGradient2*`, `memProposalBg`/`memProposalBorder`
    // — was minted as a literal specifically to avoid this). Minted here
    // for the same reason, at smaller errors than any of those.
    memTypeBorderSemantic: "#cdd9e0",
    memTypeBorderEpisodic: "#ddd0e2",
    memTypeBorderProcedural: "#d2dcc6",

    // MemoryByTypeCards' `SampleItems` row text (chat/event preview lines).
    // Not a brand-token match — warmer/lighter than `ink`, a real one-off.
    memSampleInk: "#3d3630",
    // MemoryAlpineRow's inline `code` text (a monospace-inline accent, no
    // brand match — genuinely new, indigo-ish).
    codeInk: "#6366b8",
    // MemoryAlpineRow's "why" fallback text (italic, no source recorded) —
    // deliberately paler than `ink3` to read as "this is a filled gap, not
    // real data," a real design intent per the classification, not a typo.
    whyFallbackInk: "#a8997d",
    // "not written to the Memory Book" caveat — byte-identical duplicate
    // literal in MemoryModal.tsx and WorkingMemoryPanel.tsx (×2 sites there:
    // the same caveat line + the "Cross-chat recall" label + the legend's
    // `sub` text), consolidated into one role.
    mutedCaveat: "#9a8c74",
    // WorkingMemoryPanel's legend-card background.
    memLegendBg: "#fbf8f0",

    // ActiveReposPanel's area-chip and component-chip text/bg/border are two
    // near-identical "tag pill" palettes that drifted apart (`#6a5a48` vs
    // `#5a6a48` ink, `#f1ece2`/`#e2d8c8` vs `#eef1e7`/`#dde4d0` bg/border) —
    // the classification calls this a latent inconsistency to collapse, not
    // a deliberate distinction (both sections already have their own "N
    // areas" / "N components" header labeling them, so no information is
    // lost by using one shared visual role). Canonical value = the
    // component-chip's (arbitrary pick between two near-equal options,
    // recorded here since the classification didn't declare a winner).
    tagChipInk: "#5a6a48",
    tagChipBg: "#eef1e7",
    tagChipBorder: "#dde4d0",

    // MessagesView's per-role message-card background. Each is a pale tint
    // of that role's already-tokenized `ROLE_COLOR` (sky/moss/amber) — but
    // NOT reproducible via `color-mix(accent, paper)`: solving for the mix
    // weight on the R channel and checking it against G shows the two
    // channels disagree (e.g. user: R solves to ~13% but G is off by 7
    // points at that weight) — these were hand-tuned independently of the
    // accent, not derived from it. Minted as literal pairs rather than
    // forcing an unverified color-mix guess that would render a visibly
    // different color than what's live today.
    roleBgUser: "#eaf4fb",
    roleBgAssistant: "#eef6e9",
    roleBgTool: "#fdf5e8",

    // Chat.tsx message-status bubble palette — the brief's own worked
    // example. `bubbleFail`/`bubbleFailEdge` = "this turn failed, retriable"
    // (soft peach). `bubbleNotice*` was the brief's proposed name for the
    // teal-coded info card; merged into `tealWash`/`tealWashEdge`/`tealInk`
    // above instead of minting a near-duplicate second name for the same 3
    // values (see the cross-family finding). `bubbleUser`/`bubbleAssistant`/
    // `bubbleAssistantEdge` are exact matches to `paperD`/`cream`/`edge` —
    // no new tokens for those, the call site swaps to the existing token.
    bubbleFail: "#f7ede4",
    bubbleFailEdge: "#dcb49e",

    // FloatingChat.tsx's OWN, harder-red failure family — the maintainer's
    // 2026-08-02 decision: this stays a deliberate severity gradient against
    // Chat.tsx's soft `bubbleFail`, not collapsed into one token. Two
    // distinct hues inside FloatingChat itself, both harder than
    // `bubbleFail`, at two different severities:
    //   `bubbleFailUrgent` (rust, rgb(176,60,20)) — a turn failed, in the
    //     floating panel (same `m.status === 'failed'` event as Chat.tsx's
    //     bubbleFail, rendered harder here — kept as its OWN token per the
    //     decision's "each gets its own light+dark pair," not reused).
    //     Consumed via `color-mix(…, transparent)` (exact reproduction of
    //     the original `rgba(176,60,20,X)`) for its 5% background AND 18%
    //     border. The 5% background composite DOES carry real text on top
    //     (`FloatingChat.tsx`'s failed-turn wrapper div also carries
    //     `text-ink`) — `ink` on the 5%-mix composite clears 14.77:1 light /
    //     14.06:1 dark, asserted in the palette test (review round 1,
    //     Minor 2 — an earlier version of this comment claimed "no real X-on-Y
    //     pairing to test," which was wrong; the pairing exists, it was just
    //     ungated). The 18% BORDER genuinely has no floor: it measures
    //     1.30:1 against `cream` in both themes, near-invisible, but that is
    //     UNCHANGED from today's live `rgba(176,60,20,0.18)` at the same
    //     18%-over-cream composite — held, not regressed, not asserted.
    //     Full-strength (never actually rendered, since this token is only
    //     ever alpha-mixed) clears 6.22:1 vs dark cream / 5.68:1 vs dark
    //     paper — the dark lift from light's muddy `#b03c14` is for visual
    //     survival at low alpha over a near-black background, not gated by
    //     any assertion of its own.
    //   `bubbleTerminalRed` (true red, rgb(176,0,0)) — the conversation is
    //     dead (terminalCta read-only state) AND the general chat-error
    //     banner text (`#b00` = `#bb0000`, rgb 187,0,0 — 11 points off
    //     176,0,0 on the R channel only; consolidated into ONE base per the
    //     same typo-shaped-drift precedent as memCardBg's `#fffdf9` above,
    //     not kept as a second near-duplicate token). THIS one IS real body
    //     text (the error banner) so it gets a genuine 4.5:1 floor
    //     assertion, not just a decorative pass.
    bubbleFailUrgent: "#b03c14",
    bubbleTerminalRed: "#b00000",
    // FloatingChat's budget/quiet-hours blocked-notice wash. Alpha-derived
    // from `rgb(255,248,220)` (`rgba(255,248,220,0.6)` today) — straw-yellow,
    // not a tint of `amber` (which is more orange). `ink` IS painted
    // directly on the composited wash (the blocked-notice copy is real
    // body text), so the dark value is chosen against the actual 60%-mix
    // composite, not the base color alone — see the palette test for the
    // mix arithmetic.
    blockedYellow: "#fff8dc",

    // MemoryComposer's proposal-card wash — amber-adjacent but not a clean
    // `color-mix(amber, paper)` derivation: the best-fit search (task-10b2
    // report) lands at 0% for the background (a near-white with no real
    // amber signal) and only ~65% for the border with real per-channel
    // error — hand-tuned independently of `amber`, not derived from it.
    memProposalBg: "#fffaf0",
    memProposalBorder: "#e8c98a",

    // ---- Task 10b, migration batch 2 (repo-graph C4 accents, diff-viewer
    // wash, false-positive-adjacent tidy-ups). See the dark side for the
    // per-token arithmetic; light values are the literals already live in
    // the app today (same "held at today's level" precedent as above).

    // repo-graph-c4-derive.ts's BAND_TINT.lc — the layer-band LABEL text,
    // painted on a ~9-11%-alpha wash of the matching accent (sky/terra/moss/
    // amber) that is visually indistinguishable from the plain canvas at
    // that opacity — so this is measured directly against `cream` (and
    // `paper`, the harder of the two), not against a synthesized wash
    // composite. A distinct role from `onSky`/`onMoss`/etc. (Task 10a): those
    // are text on the FULL-strength accent fill; this is text on the accent's
    // own near-transparent tint.
    bandLabelInkSky: "#5f8499",
    bandLabelInkTerra: "#b15555",
    bandLabelInkMoss: "#5f7a48",
    bandLabelInkAmber: "#b07d2e",

    // repo-graph.ts's search-match `<mark>` highlight (`hlMatch`). The mark's
    // own text is `color:inherit` — whatever ink is already rendering
    // (`.rg-host .res .nm{color:var(--ink)}`) — so THIS token is the only
    // thing that needs a dark counterpart, chosen so `ink` stays legible on
    // it in both themes. Unlike a wash tint, this needs an OPAQUE flip (pale
    // gold in light, dark amber in dark) because `ink` itself flips polarity
    // between themes (near-black -> near-white) — the same shape `cream`/
    // `paper` already have, not the ink-derivation shape.
    searchHighlight: "#f3e0a8",

    // SpanTree.tsx's `rubric` kind color — a genuine new tan hue, no brand
    // match (classification: also byte-identical to JsonView.tsx's
    // `syntaxColor("boolean")`, out of this batch's file list but a real
    // future reuse — named as a reusable brand-adjacent tone, not
    // `kindRubric`, for that reason).
    tan: "#c8a87f",

    // ---- Task 10b, migration batch 4 (a retired board bug/idea washes + hero row,
    // stat/action mini-palette, Memory.tsx date-group inks). Same "held at
    // today's level" precedent — light values are the literals already live.

    // a retired component's bug/idea badge washes (Family 6b) — SideDetail's
    // isBug ternary paints tokens.color.terra/moss directly ON TOP of these
    // as real badge text ("🐛 BUG"/"✨ IDEA", 10px bold — not WCAG large), the
    // SAME "brand accent as real text on a newly-minted wash" shape Task 10b
    // batch 2's diffDelBg/diffAddBg already established (their dark values
    // also stayed rich/saturated, not pastel, for the identical reason: the
    // wash exists to hold legible text, not to look pale). Best-fit color-mix
    // was checked and rejected — badge bg R(253) exceeds both terra(217) and
    // paper(244)'s R channels, outside the range a terra/paper mix can reach.
    questBugBg: "#fdf2f0",
    questIdeaBg: "#f1f6ea",
    // Badge borders — graphical, 3:1 floor vs paper.
    questBugEdge: "#ecc9c4",
    questIdeaEdge: "#cfe0bd",
    // a row's hero-state (an active entry) row background — ink/ink3/terra
    // are the three text colors actually painted on top (title, pr/note
    // labels, frac counter).
    questHeroBg: "#fff8f4",

    // action-result.ts's STAT_COLOR/ACTION_COLOR mini-palette (Family 7) —
    // four hues shared verbatim between the two maps (hp/mood/pet/tease =
    // vitality, hunger/feed = hunger, energy/play = energy, bond/clean =
    // bond). Real text (banner title chip, stat-delta chips, XP chip),
    // painted directly on the action-banner's `cream` background.
    statVitalityInk: "#c75c5c",
    statHungerInk: "#d97a3a",
    statEnergyInk: "#7aa757",
    statBondInk: "#5a96c8",

    // Memory.tsx's date-group divider row (Family 11).
    dateGroupSubInk: "#bcae92", // "N cleared/pending" sub-label, 10px mono TEXT
    bookPendingBorder: "#cbbda0", // dashed empty-state marker, graphical
    // Fix round 1, Minor finding: the original batch-4 diff aliased this
    // call site to `edge` (#d8cbab) instead of pinning the ORIGINAL live
    // literal (#ece3d0) — a real R-20/G-24/B-37 shift, a visibly darker
    // divider line in light mode, the one place this batch changed a
    // light-mode value rather than holding it. Minted as its own token
    // instead, matching every other new token in this batch: light =
    // unchanged. No strict floor (a 1px decorative divider, same treatment
    // `memWorkingDivider` already gets) — dark side note below.
    dateGroupDivider: "#ece3d0",

    // critic/diff/render.tsx's SIDE_BG del/add washes — hand-tuned near-terra/
    // near-moss diff colors (Family 4). Per-channel deltas from the real
    // accents are small for del (terra +/-3..7) but larger for add (moss
    // +14..18 on two channels) — computed via a best-fit check before minting
    // these as their own literals rather than a `color-mix(terra/moss, …)`
    // derivation (same "don't force a derivation the numbers don't support"
    // reasoning as `memProposalBg`/`roleBg*` in Family 1/2). `sideFg()`
    // already paints tokens.color.terra/moss (unchanged, out of this file's
    // scope) directly on top of these as real diff-line text.
    diffDelBg: "#d66464",
    diffAddBg: "#8ca864",
    // SIDE_BG.empty — pure neutral gray, no brand match, no text ever
    // renders on it (`SideRow.kind === "empty"` always carries `text: ""`,
    // verified in src/web/screens/critic/diff/parse.ts) — alignment padding
    // only, so it carries no contrast floor in either theme.
    diffEmptyBg: "#787878",

    // `/progress`'s north-star header — a dark green band carrying pale text,
    // in BOTH themes. Minted rather than reused: the existing `lcd`/`lcdInk`
    // pair is "the LCD screen and the ink on it", and the two SWAP roles
    // across themes (light `lcd` #b8c2a4 is the pale screen, dark `lcd`
    // #2f3a2c is a dark one). The header is inverted relative to that in light
    // mode — it wants lcdInk AS THE BACKGROUND — so no single existing token
    // holds "dark green band" on both sides, and spelling it as
    // `light ? lcdInk : lcd` at the call site would be a theme conditional in
    // SSR, which is exactly what `var(--color-*)` exists to avoid.
    headerBg: "#2a3a26",
    headerInk: "#b8c2a4",
    // The header's emphasis color — vision line, repo name, the strong half of
    // "where we are". Reads on `headerBg`, not on the page background.
    headerStrong: "#faf6ec",

    // A card lifted off `paper` — the a selected card. Distinct from
    // `memCardBg`, whose DARK value (#2e2816) is warm/olive: the 🌙 track's
    // zero-color-cast rule for dark surfaces is the reason this is its own
    // token rather than a reuse (the prototype's first pass made exactly that
    // mistake and the olive-tinted selected card was rejected on sight).
    raised: "#fffdf8",
    // A card whose work is finished — recedes without going gray-on-gray.
    surfaceDone: "#f6f1e6",
  },
  dark: {
    cream: "#151515",
    paper: "#1e1e1e",
    paperD: "#272727",
    edge: "#3a3a3a",
    ink: "#e8e8e8",
    ink2: "#adadad",
    ink3: "#909090",
    terra: "#e88484",
    amber: "#e6b36a",
    moss: "#8cc47f",
    sky: "#7bb4d6",
    violet: "#ab96d4",
    lcd: "#2f3a2c",
    lcdInk: "#c2d9b0",
    // The egg-stage creature. Muted rather than inverted: it renders a
    // character, not chrome, and a bright pink egg on #151515 glares.
    egg: "#5a4040",
    egg2: "#7a5555",
    // Icon strokes and text drawn ON a saturated accent fill. White fails the
    // 3:1 non-text floor on ALL FIVE dark accents (measured 1.91-2.61);
    // near-black scores 7.00-9.58. See spec §6.3.
    onAccent: "#151515",
    // Per-accent text-on-fill (Task 10, decided item 2) — dark counterpart of
    // the four keys above. `onAccent`'s own dark value already clears the
    // STRONGER 4.5:1 text floor on every dark accent (7.01-9.58:1, see the
    // contrastRatio table in the commit report), unlike its light value
    // (which needed the split above), so these four reuse it rather than
    // invent a second near-black. Kept as separate keys — not a `= onAccent`
    // alias — for the same reason as the light side: independent movement
    // room if a future accent fill re-tune needs it.
    onTerra: "#151515",
    onAmber: "#151515",
    onMoss: "#151515",
    onSky: "#151515",

    // ---- Task 10b, migration batch 1 — dark counterparts. See the light
    // side's comments for role/provenance; this side documents only the
    // dark-specific arithmetic (each value chosen so the palette test's
    // `contrastRatio` assertion clears, per file tests/web/tokens/palette.test.ts).
    teal: "#5e9ca3", // unchanged — already 5.37:1 vs dark.paper (3:1 floor), no lift needed
    tealInk: "#56949a", // lifted vs dark tealWash (#202524, the harder of its two surfaces): 4.51:1
    tealWash: "#202524",
    tealWashEdge: "#51766d", // lifted vs dark.paper (the card's outer boundary): 3.30:1

    memTypeInkSemantic: "#6c95ac", // lifted vs dark memCardBg (#2e2816, the lightest/hardest surface these inks sit on): 4.56:1
    memTypeInkEpisodic: "#9b87b5", // 4.56:1 vs dark memCardBg
    memTypeInkProcedural: "#7f9761", // 4.54:1 vs dark memCardBg

    memStatusActiveInk: "#729a4e", // 4.50:1 vs dark memCardBg
    memStatusPendingInk: "#c28124", // 4.51:1 vs dark memCardBg
    memStatusRetiredInk: "#ca7878", // 4.52:1 vs dark memCardBg

    memKindStyle: "#c77f42", // 4.57:1 vs dark memCardBg
    memKindProfile: "#8390ab", // 4.57:1 vs dark memCardBg
    memKindUntagged: "#a89a86", // unchanged — already 5.33:1 vs dark memCardBg

    memCardBg: "#2e2816",
    memCardBgRetired: "#221f18",

    memWorkingInk: "#c77a74", // 4.52:1 vs dark memCardBg
    memWorkingBorder: "#a7604d", // lifted vs dark.paper (card outer boundary): 3.51:1
    memWorkingGradient2: "#27201e",
    memWorkingDivider: "#2f2623", // decorative dashed line — same no-strict-floor treatment as `edge` itself (edge-on-paper is 1.47:1 in this palette; a divider is not a text/control-boundary floor case)
    memTypeGradient2Semantic: "#28241d",
    memTypeGradient2Episodic: "#252023",
    memTypeGradient2Procedural: "#24261f",
    memTypeBorderSemantic: "#4f6e80", // lifted vs dark.paper: 3.08:1
    memTypeBorderEpisodic: "#825a91", // lifted vs dark.paper: 3.03:1
    memTypeBorderProcedural: "#5b6f44", // lifted vs dark.paper: 3.02:1

    memSampleInk: "#9b8c80", // 4.51:1 vs dark memCardBg
    codeInk: "#888ac9", // 4.56:1 vs dark memCardBg
    whyFallbackInk: "#a8997d", // unchanged — already 5.25:1 vs dark memCardBg
    mutedCaveat: "#9b8d75", // 4.51:1 vs dark memCardBg
    memLegendBg: "#262319",

    tagChipInk: "#7d9364", // lifted vs dark tagChipBg (#24261f, its own actual surface): 4.54:1
    tagChipBg: "#24261f",
    tagChipBorder: "#637543", // lifted vs dark.paper: 3.30:1

    roleBgUser: "#1a242b",
    roleBgAssistant: "#21271d",
    roleBgTool: "#2d2518",

    bubbleFail: "#29221c",
    bubbleFailEdge: "#9d5c39", // lifted vs dark.paper: 3.19:1 (also 3.00:1 vs its own dark bubbleFail bg)

    bubbleFailUrgent: "#e37a4a", // ink-on-5%-mix asserted (see light-side comment + palette test); the 18% border composite has no floor (held at today's 1.30:1, not regressed) — lifted for the 5% background's visual survival
    bubbleTerminalRed: "#e2604a", // TEXT floor: 5.22:1 vs dark.cream, 4.77:1 vs dark.paper (the error banner renders in the `.fc-panel` bg-cream context)
    blockedYellow: "#8a7a3a", // `ink` painted on the 60%-mix composite (`mix8bit(this, dark.cream, 60)` = #5b522b) clears 6.38:1 — see the palette test for the reproducible mix arithmetic

    memProposalBg: "#2e2616",
    memProposalBorder: "#88641b", // lifted vs dark.paper: 3.08:1

    // ---- Task 10b, migration batch 2 — dark counterparts. Method: same
    // HSL-lightness-lift search as batch 1 (hue/saturation held, lightness
    // raised in 0.005 steps until contrastRatio clears the floor), computed
    // live from this file's own contrastRatio/relativeLuminance — see the
    // palette test for the reproducible script and the RED evidence.

    // Lifted vs the HARDER of dark.cream (#151515) and dark.paper (#1e1e1e)
    // — paper is lighter, so it is the binding constraint for a light-toned
    // ink token, the same "measure against the actual surface" lesson batch
    // 1 already applied to memCardBg.
    bandLabelInkSky: "#658aa0", // 4.953:1 vs cream, 4.522:1 vs paper
    bandLabelInkTerra: "#be7171", // 5.035:1 vs cream, 4.596:1 vs paper
    bandLabelInkMoss: "#6f8f54", // 4.985:1 vs cream, 4.551:1 vs paper
    bandLabelInkAmber: "#b07d2e", // unchanged — already 5.060:1 vs cream, 4.619:1 vs paper

    // Darkened (not lightened — `ink` is what's painted ON this token, and
    // dark.ink is near-white, the opposite direction from every ink-lift
    // above) until dark.ink clears 4.5:1 against it: 4.571:1.
    searchHighlight: "#806412",

    // unchanged — already 7.433:1 vs dark.paper / 8.142:1 vs dark.cream as
    // TEXT, no lift needed (a rare case where the light literal already
    // clears the dark floor at the same hex).
    tan: "#c8a87f",

    // ---- Task 10b, migration batch 4 — dark counterparts. Method: same
    // HSL-lightness search as earlier batches, but DARKENING (not lifting) —
    // the wash is the BACKGROUND and the already-lightened dark accent/ink
    // tokens (terra/moss/ink3, all light-toned in dark mode) are what paints
    // ON it, so the wash must move DARKER, hue/saturation held, until the
    // real text token clears 4.5:1 against it. Computed live via this file's
    // own contrastRatio; pins in the palette test are truncated, not rounded.

    // Darkened until dark.terra clears 4.5:1 on it: 4.517:1 (146 steps of
    // 0.005 lightness). At today's light hue/saturation held, the near-white
    // source (L~0.97) becomes a genuinely saturated maroon at the darker L
    // needed to seat visible text — same shape as diffDelBg/diffAddBg
    // staying rich rather than pastel in dark mode.
    questBugBg: "#6a1c0e",
    // Darkened until dark.moss clears 4.5:1 on it: 4.546:1 (145 steps).
    questIdeaBg: "#3b4d21",
    // Unchanged — the pale badge borders already clear the 3:1 graphical
    // floor against dark.paper at their light hex (10.89:1 / 11.95:1); no
    // lift needed, same "already clears, held" outcome as `teal`/`tan` above.
    questBugEdge: "#ecc9c4",
    questIdeaEdge: "#cfe0bd",
    // Darkened until the HARDEST of the three real text tokens painted on
    // it — dark.ink3 (#909090, the palest of the three) — clears 4.5:1: at
    // #491b00, ink3 measures 4.568:1, with dark.terra (5.600:1) and
    // dark.ink (11.902:1) clearing it with more room, confirming ink3 (not
    // terra or ink) is the binding constraint, not assumed.
    questHeroBg: "#491b00",

    // Real text (banner chips), painted directly on dark.cream. Three of
    // four needed zero lift (the pale-pastel light hex, unchanged, already
    // clears 4.5:1 against the much-darker dark.cream); statVitalityInk
    // needed one 0.005-lightness step (light #c75c5c measures 4.30:1
    // against dark.cream, one hair under the floor).
    statVitalityInk: "#c85e5e", // 4.538:1 vs dark.cream (1 lift step)
    statHungerInk: "#d97a3a", // unchanged — 5.909:1 vs dark.cream
    statEnergyInk: "#7aa757", // unchanged — 6.515:1 vs dark.cream
    statBondInk: "#5a96c8", // unchanged — 5.766:1 vs dark.cream

    // Unchanged — both already clear their floor against the dark surface
    // at the light hex (dateGroupSubInk 7.627:1 vs dark.paper as TEXT;
    // bookPendingBorder 8.991:1 vs dark.paper as a 3:1 graphical border).
    dateGroupSubInk: "#bcae92",
    bookPendingBorder: "#cbbda0",
    // Darkened (hue/sat held) until this token is as subtle against
    // dark.paper as `edge`'s OWN dark value is against the same surface —
    // matched to 1.457:1 (edge dark vs dark.paper measures 1.466:1) rather
    // than to any strict floor, since a 1px decorative divider carries no
    // floor. Hue preserved (a muted dark tan) rather than neutralized to
    // gray, so it reads as the SAME divider that lightened, not a
    // different-colored one.
    dateGroupDivider: "#45381c", // 1.457:1 vs dark.paper (edge itself: 1.466:1)

    // diffDelBg/diffAddBg: unchanged — the SAME light literal, alpha-
    // composited at its established 18%/20% over dark.cream, already clears
    // the 4.5:1 text floor for the real terra/moss text painted on top
    // (5.629:1 / 6.471:1) because the composite is dominated by dark.cream's
    // near-black at that low alpha. No independent dark hue was needed —
    // verified by computing the actual 8-bit color-mix composite with this
    // file's own contrastRatio, not assumed.
    diffDelBg: "#d66464",
    diffAddBg: "#8ca864",
    // unchanged — no text ever renders on it in either theme (see the light
    // side's comment); the alpha-composite itself reads correctly against
    // both dark.cream and light.cream without a hue change.
    diffEmptyBg: "#787878",

    // See the light side. The band stays dark green; the ink lightens with the
    // rest of the dark palette.
    headerBg: "#2f3a2c",
    headerInk: "#c2d9b0",
    headerStrong: "#e8e8e8",

    // Neutral charcoal, NOT a tinted lift — the 🌙 track's rule for dark
    // surfaces (color appears only on status accents, never on card faces).
    //
    // `#282828` and not the prototype's `#2e2e2e`: this is a surface that
    // carries real body text (a selected card's title, summary and meta row),
    // and at `#2e2e2e` `ink3` measures 4.25:1 — under the 4.5:1 floor this
    // repo enforces on every other dark surface. `#282828` measures 4.62:1
    // with headroom, and still separates from `paper` by 1.13:1, the same
    // separation `paperD` already has. Both are now IN the gated surface set
    // (`tests/web/tokens/palette.test.ts`), which is why the sub-floor value
    // could ship unnoticed the first time.
    raised: "#282828",
    // Sunk toward the PAGE rather than lifted off it — that is what "this work
    // is finished" looks like in dark mode. It sits between `cream` (the page)
    // and `paper` (a live card), nearly merging with the page, and the card's
    // own 1px `edge` border is what keeps it a card. `ink3` on it is 5.45:1.
    surfaceDone: "#1a1a1a",
  },
} as const;

export type ColorToken = keyof typeof palette.light;
export type ThemeName = keyof typeof palette;

// The categorical (non-brand) namespaces — `graphPalette` (Task 9) and
// `kindPalette` (Task 10b batch 2) — live in `./categorical` (review round 1,
// directed item B: this file was 703 lines against the 400 soft / 800 hard
// LOC cap, and batch 3 would have pushed it past 800). Re-exported here so
// every existing call site (`tokens.ts`, `palette.test.ts`,
// `generated-css.test.ts`) keeps importing from "./palette" unchanged — a
// pure file-organization split, not an API change.
export { graphPalette, kindPalette, type GraphToken, type KindToken } from "./categorical";

/**
 * Shadow palette. Shadows have a light and a dark form and contain `rgba(…)`
 * literals, so they live beside the colors rather than in tokens.ts (which
 * would make tokens.ts a second file holding literals).
 */
export const shadowPalette = {
  light: {
    sm: "0 1px 2px rgba(31,27,22,0.06)",
    md: "0 2px 6px rgba(31,27,22,0.10)",
    lg: "0 8px 24px rgba(31,27,22,0.14)",
    // Modal/maximize-panel scrim — the translucent backdrop behind an
    // overlay. Lives here, not as a `ColorToken`, for the EXACT reason
    // `sm`/`md`/`lg` do: it's an `rgba(…)` value that needs an ASYMMETRIC
    // light/dark treatment, not a simple flip. (Task 10b review round 1,
    // Important 3 — `color-mix(in srgb, var(--color-ink) 42%, transparent)`
    // was WRONG here: `ink` flips to near-white in dark mode, turning the
    // scrim into a veil that brightens the page it exists to dim.)
    scrim: "rgba(31,27,22,0.42)",
  },
  dark: {
    // Dark UIs need near-black shadows; a shadow derived from the light ink is
    // invisible on #151515 and reads as a halo where it is visible at all.
    sm: "0 1px 2px rgba(0,0,0,0.40)",
    md: "0 2px 6px rgba(0,0,0,0.50)",
    lg: "0 8px 24px rgba(0,0,0,0.60)",
    // Fixed near-black, NOT derived from `dark.ink` (near-white) — same
    // reasoning as the shadows above. Higher alpha than the light value
    // (.42 -> .55), matching how sm/md/lg also raise dark's alpha well
    // beyond light's (.06->.40, .10->.50, .14->.60): a translucent overlay
    // needs more opacity to still read as a distinct dimming layer against
    // an already-dark page. Family 7's later 3-way backdrop consolidation
    // (confirm-modal.ts's own `.45`, out of this batch) may retune this;
    // scoped here to the two sites Family 1/2 touch.
    scrim: "rgba(0,0,0,0.55)",
  },
} as const;

export type ShadowToken = keyof typeof shadowPalette.light;

/**
 * CSS keyword colors Tailwind's utilities rely on (bg-white, text-black,
 * bg-transparent). Deliberately NOT part of `palette` / `ColorToken`: they are
 * theme-independent constants, and adding them to the token map would emit
 * pointless `--color-white` overrides into all four theme blocks in tokens.css.
 * They live here because palette.ts is the one file permitted to hold a color
 * literal (see the plan's Global Constraints).
 */
export const keywordColors = {
  transparent: "transparent",
  current: "currentColor",
  white: "#ffffff",
  black: "#000000",
} as const;

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 relative luminance of a `#rrggbb` string. */
export function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** WCAG 2.1 contrast ratio between two `#rrggbb` strings. Always >= 1. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

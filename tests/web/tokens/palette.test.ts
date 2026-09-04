import { describe, expect, test } from "bun:test";
import {
  palette,
  contrastRatio,
  graphPalette,
  kindPalette,
  type ColorToken,
  type GraphToken,
  type KindToken,
} from "../../../src/web/tokens/palette";
import { tokens } from "../../../src/web/tokens/tokens";

describe("palette", () => {
  test("light and dark define exactly the same keys", () => {
    expect(Object.keys(palette.dark).sort()).toEqual(Object.keys(palette.light).sort());
  });

  test("every palette value is a literal hex, never a var()", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const [key, value] of Object.entries(palette[theme])) {
        expect(value, `${theme}.${key}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  test("tokens.color is pure indirection — no hex survives", () => {
    for (const [key, value] of Object.entries(tokens.color)) {
      expect(value).toBe(`var(--color-${key})`);
    }
  });

  test("tokens.color covers every palette key", () => {
    expect(Object.keys(tokens.color).sort()).toEqual(Object.keys(palette.light).sort());
  });
});

describe("dark palette contrast floors", () => {
  // `raised` and `surfaceDone` joined this list with `/progress`'s a retired map:
  // both are CARD FACES carrying a title, a summary and a meta row, i.e. real
  // body text, and neither was gated when it was minted. `raised` shipped at
  // `#2e2e2e` (ink3 = 4.25:1) and nothing failed — this list is why.
  const surfaces: ColorToken[] = ["cream", "paper", "paperD", "raised", "surfaceDone"];
  const bodyText: ColorToken[] = ["ink", "ink2", "ink3"];
  const accents: ColorToken[] = ["terra", "amber", "moss", "sky", "violet"];

  for (const fg of bodyText) {
    for (const bg of surfaces) {
      test(`dark ${fg} on ${bg} meets the 4.5:1 body floor`, () => {
        expect(contrastRatio(palette.dark[fg], palette.dark[bg])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  for (const fg of accents) {
    for (const bg of surfaces) {
      test(`dark ${fg} on ${bg} meets the 3:1 graphical floor`, () => {
        expect(contrastRatio(palette.dark[fg], palette.dark[bg])).toBeGreaterThanOrEqual(3);
      });
    }
  }

  test("onAccent is legible on every dark accent fill", () => {
    for (const accent of accents) {
      expect(
        contrastRatio(palette.dark.onAccent, palette.dark[accent]),
        `onAccent on ${accent}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("per-accent ink tokens (Task 10, decided item 2)", () => {
  // Task 7's review measured `ink` on the three light dark-theme accents at
  // 1.66 (moss) / 1.85 (sky) / 1.57 (amber) against the 4.5:1 text floor —
  // live, unreadable chips on /rubric and /preference-log. The fix is a
  // dedicated text-on-fill token per accent (not a swap to `onAccent`, which
  // is white in light mode where the same fills are also light — see the
  // failing-onAccent numbers this test's RED run captured). `violet` is
  // checked here too, per the brief's "check terra and violet before
  // assuming three is the full set" — it does NOT get a token because it is
  // never used as a background fill with text on it anywhere in src/web
  // (grepped; only ever a plain foreground/stroke color), so there is no
  // "onViolet" call site for this decided item to fix.
  const onTokens: Record<string, ColorToken> = {
    terra: "onTerra",
    amber: "onAmber",
    moss: "onMoss",
    sky: "onSky",
  };

  for (const [accent, onKey] of Object.entries(onTokens)) {
    for (const theme of ["light", "dark"] as const) {
      test(`${onKey} on ${theme} ${accent} clears the 4.5:1 text floor`, () => {
        const fg = palette[theme][onKey as ColorToken];
        const bg = palette[theme][accent as ColorToken];
        expect(contrastRatio(fg, bg), `${theme}.${onKey} on ${theme}.${accent}`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("explain.tsx .banner — derived from tokens via color-mix, not a new palette token", () => {
  // The banner background is `color-mix(in srgb, var(--color-amber) 18%,
  // var(--color-paper))` (src/daemon/routes/explain.tsx), computed here from
  // the LIVE palette values with the same formula CSS `color-mix in srgb`
  // uses (weighted average of the sRGB channel bytes, 8-bit quantized by
  // rounding to the nearest integer — matching how a browser serializes/
  // renders the mixed color) so this assertion can never go stale relative
  // to a palette edit the way a hardcoded expected-hex comment could.
  function mix8bit(hexA: string, hexB: string, pctA: number): string {
    const toRgb = (h: string): [number, number, number] => [
      Number.parseInt(h.slice(1, 3), 16),
      Number.parseInt(h.slice(3, 5), 16),
      Number.parseInt(h.slice(5, 7), 16),
    ];
    const a = toRgb(hexA);
    const b = toRgb(hexB);
    const w = pctA / 100;
    const mixCh = (i: number) => Math.round(a[i] * w + b[i] * (1 - w));
    return `#${[mixCh(0), mixCh(1), mixCh(2)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  test("ink2 on the 18%-amber/82%-paper mix clears the 4.5:1 text floor in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const bg = mix8bit(palette[theme].amber, palette[theme].paper, 18);
      expect(contrastRatio(palette[theme].ink2, bg), `${theme} ink2 on ${theme} amber/paper 18% mix (${bg})`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("light palette — held at today's level, not improved here", () => {
  // The light palette has six pre-existing AA failures (deferred 🌗
  // 2026-08-01). Fixing them is out of scope. These assertions exist so this
  // track cannot make light mode WORSE while it is not making it better.
  test("light ink and ink2 still clear the body floor on paper", () => {
    expect(contrastRatio(palette.light.ink, palette.light.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.light.ink2, palette.light.paper)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("graph palette", () => {
  test("light and dark define the same keys", () => {
    expect(Object.keys(graphPalette.dark).sort()).toEqual(Object.keys(graphPalette.light).sort());
  });

  test("every graph color clears the 3:1 graphical floor on its own theme's canvas", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const key of Object.keys(graphPalette[theme]) as GraphToken[]) {
        const ratio = contrastRatio(graphPalette[theme][key], palette[theme].cream);
        expect(ratio, `${theme}.${key} on ${theme} canvas`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  // Review round 1 finding (Important 2): the 3:1-vs-cream test above is the
  // graphical floor, but RepoGraph.tsx also paints `unresolvable` as small
  // BODY TEXT (.rm-add-err, .ph-unres .nname, .ph-err b, #rg-ph-fallback b,
  // .ph-class.unresolvable) — none of it is WCAG "large text" — so it needs
  // the 4.5:1 body floor, on the surfaces it actually sits on (cream AND
  // paper; paper is the binding constraint, being the lighter of the two).
  test("dark unresolvable meets the 4.5:1 body-text floor on cream and paper (it renders as body text, not just a graphical mark)", () => {
    expect(contrastRatio(graphPalette.dark.unresolvable, palette.dark.cream)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(graphPalette.dark.unresolvable, palette.dark.paper)).toBeGreaterThanOrEqual(4.5);
  });

  // Final dark-mode branch review (Minor): `resolved` is ALSO painted as
  // literal body text — RepoGraph.tsx `.ph-tree-fn .ph-tlabel`, 11.5px
  // mono, not WCAG "large text" — directly on `cream`, same as the
  // `unresolvable` case above. Unlike `unresolvable`, light `resolved`
  // does NOT clear the 4.5:1 body floor (3.46:1 — it only clears the 3:1
  // GRAPHICAL floor the light-value derivation above targeted). This is a
  // KNOWN, NOT-closed gap (see categorical.ts's graphPalette docstring) —
  // deliberately not force-lifted here because the light value is under a
  // separate, already-flagged human review. Pinned as a floor+ceiling pair
  // (same "document, don't silently fix" idiom the lint guard's M2 test
  // uses) so a future re-tune of `resolved` is FORCED to notice this
  // specific gap either way: dropping under 3.46:1 regresses further;
  // clearing 4.5:1 means the docstring's "KNOWN, NOT closed" paragraph is
  // stale and should be deleted, not left describing a fixed bug.
  test("light resolved as body text (.ph-tree-fn .ph-tlabel) is a known, unclosed sub-4.5 gap — pinned so it can't drift silently", () => {
    const ratio = contrastRatio(graphPalette.light.resolved, palette.light.cream);
    expect(ratio).toBeGreaterThanOrEqual(3.46);
    expect(ratio).toBeLessThan(4.5);
  });

  // Review round 1 finding (Important 4a): the brief's Step 6 asks for a
  // visual check that node/edge kinds stay distinguishable in both themes —
  // satisfied mechanically here instead of in a browser. Driven RED once
  // (see fix report) by forcing two theme values equal.
  test("no two graph tokens collapse to the same value within a theme", () => {
    for (const theme of ["light", "dark"] as const) {
      const keys = Object.keys(graphPalette[theme]) as GraphToken[];
      const values = keys.map((k) => graphPalette[theme][k]);
      const seen = new Map<string, GraphToken>();
      for (let i = 0; i < keys.length; i++) {
        const v = values[i]!;
        const k = keys[i]!;
        const prior = seen.get(v);
        expect(prior, `${theme}.${k} collapses onto ${theme}.${prior} (both = ${v})`).toBeUndefined();
        seen.set(v, k);
      }
    }
  });
});

describe("onAccent on graph fills — text/icon painted on a saturated graph fill", () => {
  // `var(--color-onAccent)` is RepoGraph.tsx's mechanism for "text on a
  // saturated fill" wherever the fill is `resolved` (.ph-flag) or
  // `unresolvable` (.rc-yes) — not a new graphPalette-adjacent token; see the
  // "text/icon on a graph fill" comment below graphPalette's dark-value
  // derivation in palette.ts for why a bespoke token was tried and then found
  // unnecessary. Same pattern as "onAccent is legible on every dark accent
  // fill" above, extended to the graph fills it's actually used on.
  // `unresolved` carries no contained text on a solid fill anywhere, so it's
  // excluded (nothing to test).

  // .rc-yes: real body text (11.5px, not WCAG "large text") painted on
  // background:var(--unresolvable) — the site round-1 review found under the
  // 4.5:1 text floor in dark theme (4.09:1, against unresolvable's pre-lift
  // dark value). Raising unresolvable's dark lift (the 4.5:1 body-text test
  // above) fixed this as a side effect; asserted directly here so a future
  // re-tune of either token can't silently reopen it.
  test("onAccent on unresolvable clears the 4.5:1 text floor in both themes", () => {
    expect(contrastRatio(palette.light.onAccent, graphPalette.light.unresolvable)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.dark.onAccent, graphPalette.dark.unresolvable)).toBeGreaterThanOrEqual(4.5);
  });

  // .ph-flag: small (9px bold) badge text painted on background:var(--resolved).
  // Light theme is a pre-existing sub-4.5 condition (3.74:1) — IMPROVED by
  // this track (was 3.01:1 against the prototype's original literal
  // `resolved` hue) but not fully fixed, same shape as the deferred-and-documented
  // light-mode accent gaps; held at "not worse than before this track", not
  // "AA", pending the same human call on the light `resolved` value flagged
  // in graphPalette's own docstring. Dark theme clears the floor outright.
  test("onAccent on resolved does not regress below its pre-track baseline in light, and clears 4.5:1 in dark", () => {
    expect(contrastRatio(palette.light.onAccent, graphPalette.light.resolved)).toBeGreaterThanOrEqual(3.01);
    expect(contrastRatio(palette.dark.onAccent, graphPalette.dark.resolved)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("Task 10b memory palette — text inks vs their actual binding surface", () => {
  // Every one of these renders as small-caps subtitle / pill / badge text
  // INSIDE a memory-type card, whose background is `memCardBg` — the
  // lightest (hardest-to-contrast-against) opaque dark surface any of them
  // sit on, lighter than `dark.paper` (#1e1e1e) and `dark.cream` (#151515).
  // Testing against `memCardBg` is therefore the binding constraint; passing
  // it means paper/cream are cleared too (asserted below as a cheap
  // corroborating check, not the primary claim).
  const inkTokens: ColorToken[] = [
    "memTypeInkSemantic",
    "memTypeInkEpisodic",
    "memTypeInkProcedural",
    "memStatusActiveInk",
    "memStatusPendingInk",
    "memStatusRetiredInk",
    "memKindStyle",
    "memKindProfile",
    "memKindUntagged",
    "memWorkingInk",
    "memSampleInk",
    "codeInk",
    "whyFallbackInk",
    "mutedCaveat",
  ];

  for (const token of inkTokens) {
    test(`dark ${token} on dark memCardBg clears the 4.5:1 text floor`, () => {
      expect(
        contrastRatio(palette.dark[token], palette.dark.memCardBg),
        `dark.${token} on dark.memCardBg`,
      ).toBeGreaterThanOrEqual(4.5);
    });
    test(`dark ${token} also clears 4.5:1 on the easier dark.paper / dark.cream surfaces`, () => {
      expect(contrastRatio(palette.dark[token], palette.dark.paper)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.dark[token], palette.dark.cream)).toBeGreaterThanOrEqual(4.5);
    });
  }

  // RED evidence (per the task's evidence bar — an assertion that has never
  // failed is not evidence): temporarily set dark.memStatusPendingInk to its
  // LIGHT value (#a06a1e) and re-ran `bun test tests/web/tokens/palette.test.ts`.
  // Actual captured failing output:
  //
  //   error: dark.memStatusPendingInk on dark.memCardBg
  //   Expected: >= 4.5
  //   Received: 3.1965147686325808
  //   (fail) Task 10b memory palette — text inks vs their actual binding surface > dark memStatusPendingInk on dark memCardBg clears the 4.5:1 text floor [0.11ms]
  //   85 pass / 2 fail (the paired paper/cream test failed alongside it)
  //
  // Reverted immediately after capturing this — the real value (#c28124) is
  // restored above and re-passes (verified: 87 pass / 0 fail).

  // tealInk's binding surface is `tealWash` (Chat.tsx's notice-bubble body
  // copy is painted directly on it), not memCardBg — teal cards never nest
  // inside a memory-type card, so it gets its own pairing rather than
  // reusing the loop above.
  test("dark tealInk on dark tealWash clears the 4.5:1 text floor (Chat.tsx notice-bubble body copy)", () => {
    expect(contrastRatio(palette.dark.tealInk, palette.dark.tealWash)).toBeGreaterThanOrEqual(4.5);
  });

  // tagChipInk's binding surface is `tagChipBg` (ActiveReposPanel's area/
  // component chip text painted directly on its own pill fill).
  test("dark tagChipInk on dark tagChipBg clears the 4.5:1 text floor", () => {
    expect(contrastRatio(palette.dark.tagChipInk, palette.dark.tagChipBg)).toBeGreaterThanOrEqual(4.5);
  });

  // `teal` itself is graphical only (left accent bar, icon-avatar fill) —
  // 3:1 floor, and `onAccent` (the icon-stroke ink already proven on the 5
  // brand accents) must also clear 3:1 against this NEW 6th accent since
  // ActiveReposPanel's REPO_ICON uses onAccent on a teal-filled circle.
  // Light `teal` (#5e9ca3) does NOT clear 3:1 against paper/cream (2.68 /
  // 2.88) — but that is the SAME pre-existing condition as the other 5
  // brand accents' documented light-mode gaps (deferred 🌗 2026-08-01):
  // `teal`'s light value is the literal already live today in
  // ActiveReposPanel's REPO_THEME, not a new value this task invents.
  // Fixing it is out of scope (same "held at today's level" precedent the
  // 16 brand tokens use above) — pinned at its measured value so it can't
  // silently regress further, not asserted against the 3:1 floor it
  // already misses. Dark mode has no such baseline to be "held at," so it
  // gets the real floor.
  test("light teal does not regress below its pre-track measured value on paper/cream (held, not improved, per the dated deferral 🌗)", () => {
    expect(contrastRatio(palette.light.teal, palette.light.paper)).toBeGreaterThanOrEqual(2.68);
    // 2.878, not 2.87 or 2.88 — review round 1, Minor 3: the true value is
    // 2.8783695…, so 2.87 (floor to 2dp) left an unexplained extra hair of
    // slack, and 2.88 (round to 2dp) would be ABOVE the true value and
    // silently fail. Pinning one more decimal gets a genuinely tight floor
    // without either problem.
    expect(contrastRatio(palette.light.teal, palette.light.cream)).toBeGreaterThanOrEqual(2.878);
  });
  test("dark teal clears the 3:1 graphical floor against paper/cream", () => {
    expect(contrastRatio(palette.dark.teal, palette.dark.paper)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(palette.dark.teal, palette.dark.cream)).toBeGreaterThanOrEqual(3);
  });
  test("onAccent is legible on teal in both themes (icon stroke, 3:1 floor)", () => {
    expect(contrastRatio(palette.light.onAccent, palette.light.teal)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(palette.dark.onAccent, palette.dark.teal)).toBeGreaterThanOrEqual(3);
  });

  // Card/wash borders — 3:1 graphical floor against the page background they
  // actually sit on top of (`paper`), matching how `edge` itself functions
  // as a card-boundary color elsewhere in this file.
  const borderPairs: Array<[ColorToken, string]> = [
    ["tealWashEdge", "teal-coded notice/active card border"],
    ["tagChipBorder", "ActiveReposPanel tag-chip border"],
    ["memWorkingBorder", "working-type card border"],
    ["bubbleFailEdge", "Chat.tsx failed-turn card border"],
    ["memProposalBorder", "MemoryComposer proposal-card border"],
    ["memTypeBorderSemantic", "semantic memory-type card border"],
    ["memTypeBorderEpisodic", "episodic memory-type card border"],
    ["memTypeBorderProcedural", "procedural memory-type card border"],
  ];
  for (const [token, desc] of borderPairs) {
    test(`dark ${token} (${desc}) clears the 3:1 graphical floor vs dark.paper`, () => {
      expect(contrastRatio(palette.dark[token], palette.dark.paper)).toBeGreaterThanOrEqual(3);
    });
  }
});

describe("Task 10b review round 1, Important 4 — surfaces that carry text but had no gate", () => {
  // The classification named `ink`-on-`bubbleFail` explicitly (§320) as the
  // one assertion this family required; it was missing. `roleBgUser`/
  // `roleBgAssistant`/`roleBgTool` (MessagesView role cards) and
  // `memProposalBg` (MemoryComposer's proposal card) also carry real text
  // (`ink`/`ink2`) and had no gate either. All four clear their floor
  // comfortably in both themes — this closes the gate, it does not fix a
  // live defect.
  test("ink on bubbleFail clears the 4.5:1 text floor in both themes", () => {
    expect(contrastRatio(palette.light.ink, palette.light.bubbleFail)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.dark.ink, palette.dark.bubbleFail)).toBeGreaterThanOrEqual(4.5);
  });

  const roleBgTokens: ColorToken[] = ["roleBgUser", "roleBgAssistant", "roleBgTool"];
  for (const token of roleBgTokens) {
    test(`ink2 on ${token} clears the 4.5:1 text floor in both themes`, () => {
      expect(contrastRatio(palette.light.ink2, palette.light[token])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.dark.ink2, palette.dark[token])).toBeGreaterThanOrEqual(4.5);
    });
  }

  // `/progress`'s north-star band is its own surface — a dark green bar in
  // BOTH themes, carrying only `headerInk`/`headerStrong`. It is deliberately
  // NOT in the `surfaces` list above: no `ink*` token ever paints on it, so
  // gating it against `ink3` would pin a pairing that never renders.
  test("headerInk on headerBg clears the 4.5:1 text floor in both themes", () => {
    expect(contrastRatio(palette.light.headerInk, palette.light.headerBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.dark.headerInk, palette.dark.headerBg)).toBeGreaterThanOrEqual(4.5);
  });

  test("headerStrong on headerBg clears the 4.5:1 text floor in both themes", () => {
    expect(contrastRatio(palette.light.headerStrong, palette.light.headerBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.dark.headerStrong, palette.dark.headerBg)).toBeGreaterThanOrEqual(4.5);
  });

  test("ink2 on memProposalBg clears the 4.5:1 text floor in both themes", () => {
    expect(contrastRatio(palette.light.ink2, palette.light.memProposalBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.dark.ink2, palette.dark.memProposalBg)).toBeGreaterThanOrEqual(4.5);
  });

  // ink on the 5%-bubbleFailUrgent-mix composite (FloatingChat's failed-turn
  // wrapper carries `text-ink`, so this pairing is real — Minor 2's fix: an
  // earlier comment claimed no such pairing existed).
  function mix8bit(hexA: string, hexB: string, pctA: number): string {
    const toRgb = (h: string): [number, number, number] => [
      Number.parseInt(h.slice(1, 3), 16),
      Number.parseInt(h.slice(3, 5), 16),
      Number.parseInt(h.slice(5, 7), 16),
    ];
    const a = toRgb(hexA);
    const b = toRgb(hexB);
    const w = pctA / 100;
    const mixCh = (i: number) => Math.round(a[i] * w + b[i] * (1 - w));
    return `#${[mixCh(0), mixCh(1), mixCh(2)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  test("ink on the 5%-bubbleFailUrgent/95%-cream mix clears the 4.5:1 text floor in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const bg = mix8bit(palette[theme].bubbleFailUrgent, palette[theme].cream, 5);
      expect(contrastRatio(palette[theme].ink, bg), `${theme} ink on ${theme} bubbleFailUrgent/cream 5% mix (${bg})`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("Task 10b review round 1, Important 5 — pre-existing light-mode sub-floor values, pinned not fixed", () => {
  // Every value below is a literal already live in the app today, now
  // carrying a name for the first time in this batch — none of them are new
  // colors this task invented, and per the "held at today's level" precedent
  // (see the top-level light-palette describe block), fixing a pre-existing
  // light-mode AA gap is out of scope. What was missing (review round 1,
  // Important 5) was the PIN: with no assertion at all, any of these could
  // silently drift even further below the floor and nothing would catch it.
  // Each is measured against `memCardBg` (the surface it actually renders
  // on inside a memory-type card), except `tealInk` (measured against its
  // own `tealWash`, already covered by "does NOT clear 4.5" reasoning
  // above) and `mutedCaveat` (also renders on `memLegendBg`, pinned
  // separately since the two surfaces give different ratios).
  const pins: Array<[ColorToken, ColorToken, number]> = [
    ["memKindUntagged", "memCardBg", 2.706],
    ["whyFallbackInk", "memCardBg", 2.747],
    ["mutedCaveat", "memCardBg", 3.239],
    ["memKindStyle", "memCardBg", 3.419],
    ["memWorkingInk", "memCardBg", 3.764],
    ["memTypeInkSemantic", "memCardBg", 3.859],
    ["memTypeInkEpisodic", "memCardBg", 4.088],
    ["memKindProfile", "memCardBg", 4.236],
  ];
  for (const [fg, bg, floor] of pins) {
    test(`light ${fg} on light ${bg} does not regress below its pre-track measured value (held pre-existing gap, not a target)`, () => {
      expect(contrastRatio(palette.light[fg], palette.light[bg])).toBeGreaterThanOrEqual(floor);
    });
  }

  test("light mutedCaveat on light memLegendBg does not regress below its pre-track measured value (held pre-existing gap, not a target)", () => {
    expect(contrastRatio(palette.light.mutedCaveat, palette.light.memLegendBg)).toBeGreaterThanOrEqual(3.102);
  });

  test("light tealInk on light tealWash does not regress below its pre-track measured value (held pre-existing gap, not a target — classification §316 requires 4.5:1 here, which the DARK side already clears at 4.51:1; the LIGHT side is a pre-existing gap, same as teal's own light-mode gap above)", () => {
    expect(contrastRatio(palette.light.tealInk, palette.light.tealWash)).toBeGreaterThanOrEqual(3.608);
  });
});

describe("Task 10b — FloatingChat's own harder-red failure family", () => {
  // `bubbleTerminalRed` IS real text (the general chat-error banner, `#b00`
  // consolidated into this token) — genuine 4.5:1 floor, checked against
  // both surfaces it can render on (`.fc-panel` is bg-cream; the message
  // list itself can also sit directly on `paper` in the maximized layout).
  test("dark bubbleTerminalRed clears the 4.5:1 text floor vs dark.cream and dark.paper", () => {
    expect(contrastRatio(palette.dark.bubbleTerminalRed, palette.dark.cream)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.dark.bubbleTerminalRed, palette.dark.paper)).toBeGreaterThanOrEqual(4.5);
  });

  // `bubbleFailUrgent` is consumed ONLY via `color-mix(…, transparent)` at
  // 5%/18% (an exact rewrite of the original `rgba(176,60,20,X)` — alpha
  // compositing and color-mix-with-transparent are mathematically
  // identical), so it is decorative wash chrome with no independent floor —
  // the same treatment every `rgba(31,27,22,X)` "ink at N%" site in this
  // codebase already gets. This test asserts only that the dark value is
  // NOT the unlifted light value (i.e. the lift in palette.ts is real, not
  // a no-op), so a future accidental revert is caught even though no WCAG
  // floor applies here.
  test("dark bubbleFailUrgent is lifted from its light value (visual survival on a near-black wash, not a floor requirement)", () => {
    expect(palette.dark.bubbleFailUrgent).not.toBe(palette.light.bubbleFailUrgent);
    expect(contrastRatio(palette.dark.bubbleFailUrgent, palette.dark.paper)).toBeGreaterThan(
      contrastRatio(palette.light.bubbleFailUrgent, palette.dark.paper),
    );
  });

  // `#b00` (bb0000, rgb 187,0,0) and the terminal-CTA's `rgba(176,0,0,0.04)`
  // were two near-identical reds (11 points apart on the R channel only) —
  // consolidated into one `bubbleTerminalRed` base. This pins that the
  // collapse doesn't silently drift: the base equals the canonical
  // rgb(176,0,0), not the slightly-brighter bb0000.
  test("bubbleTerminalRed's light value is the canonical rgb(176,0,0), not bb0000's rgb(187,0,0)", () => {
    expect(palette.light.bubbleTerminalRed).toBe("#b00000");
  });
});

describe("Task 10b — blockedYellow, an alpha-composited wash with real text on top", () => {
  // FloatingChat's budget/quiet-hours notice paints `ink` directly on
  // `color-mix(in srgb, var(--color-blockedYellow) 60%, var(--color-cream))`
  // (an exact rewrite of the original `rgba(255,248,220,0.6)` over the
  // panel's cream background). Computed here from the LIVE palette with the
  // same weighted-average-of-sRGB-bytes formula `color-mix in srgb` uses
  // (8-bit quantized by rounding), mirroring the explain.tsx `.banner` test
  // above — never a hardcoded expected-hex.
  function mix8bit(hexA: string, hexB: string, pctA: number): string {
    const toRgb = (h: string): [number, number, number] => [
      Number.parseInt(h.slice(1, 3), 16),
      Number.parseInt(h.slice(3, 5), 16),
      Number.parseInt(h.slice(5, 7), 16),
    ];
    const a = toRgb(hexA);
    const b = toRgb(hexB);
    const w = pctA / 100;
    const mixCh = (i: number) => Math.round(a[i] * w + b[i] * (1 - w));
    return `#${[mixCh(0), mixCh(1), mixCh(2)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  test("dark ink on the 60%-blockedYellow/40%-cream mix clears the 4.5:1 text floor", () => {
    const bg = mix8bit(palette.dark.blockedYellow, palette.dark.cream, 60);
    expect(contrastRatio(palette.dark.ink, bg), `dark ink on dark blockedYellow/cream 60% mix (${bg})`).toBeGreaterThanOrEqual(4.5);
  });

  test("light ink on the 60%-blockedYellow/40%-cream mix clears the 4.5:1 text floor (not a regression check — light already passes with the literal today, pinned so it can't silently break)", () => {
    const bg = mix8bit(palette.light.blockedYellow, palette.light.cream, 60);
    expect(contrastRatio(palette.light.ink, bg), `light ink on light blockedYellow/cream 60% mix (${bg})`).toBeGreaterThanOrEqual(4.5);
  });
});

describe("Task 10b batch 2 — repo-graph-c4-derive.ts bandLabelInk* (TEXT painted on a near-transparent accent wash, measured directly against cream/paper)", () => {
  // `BAND_TINT[accent].lc` is text painted on a ~9-11%-alpha wash of the
  // matching accent — at that opacity the wash is visually indistinguishable
  // from the plain canvas, so this is measured directly against
  // `cream`/`paper` rather than a synthesized composite (classification's own
  // framing: "effectively on cream/paper").
  const bandInkTokens: ColorToken[] = [
    "bandLabelInkSky",
    "bandLabelInkTerra",
    "bandLabelInkMoss",
    "bandLabelInkAmber",
  ];
  for (const token of bandInkTokens) {
    test(`dark ${token} clears the 4.5:1 text floor on both dark.cream and dark.paper`, () => {
      expect(contrastRatio(palette.dark[token], palette.dark.cream), `dark.${token} vs dark.cream`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.dark[token], palette.dark.paper), `dark.${token} vs dark.paper`).toBeGreaterThanOrEqual(4.5);
    });
  }

  // Light values are the literals already live in the app today (unchanged).
  // `bandLabelInkTerra` clears 4.5:1 against `cream` (4.525:1, real floor,
  // asserted directly) but NOT against `paper` (4.219:1) — the harder of the
  // two surfaces, per the same "measure against the surface it actually
  // paints on" lesson as everywhere else in this file; caught by running the
  // numbers rather than assuming "close to 4.5 on one surface" meant both.
  // `bandLabelInkSky`/`Moss`/`Amber` are pre-existing sub-4.5 gaps on BOTH
  // surfaces — held-gap pins on BOTH `cream` and `paper` (review round 1
  // finding: an earlier version of this file only pinned the paper side,
  // leaving the cream side of these three unasserted). All pins below are
  // truncated (not rounded) to 3 decimals from the live computed value, so
  // the pin is always strictly BELOW the true measurement — Task 10b batch
  // 1's Minor 3 finding: a rounded-up pin can fail against its own target.
  test("light bandLabelInkTerra clears the 4.5:1 text floor on cream (the easier surface)", () => {
    expect(contrastRatio(palette.light.bandLabelInkTerra, palette.light.cream)).toBeGreaterThanOrEqual(4.5);
  });
  test("light bandLabelInkSky/Moss/Amber do not regress below their pre-track measured value against light.cream (held pre-existing gap, not a target)", () => {
    expect(contrastRatio(palette.light.bandLabelInkSky, palette.light.cream)).toBeGreaterThanOrEqual(3.708);
    expect(contrastRatio(palette.light.bandLabelInkMoss, palette.light.cream)).toBeGreaterThanOrEqual(4.458);
    expect(contrastRatio(palette.light.bandLabelInkAmber, palette.light.cream)).toBeGreaterThanOrEqual(3.343);
  });
  test("light bandLabelInkSky/Terra/Moss/Amber do not regress below their pre-track measured value against light.paper (held pre-existing gap, not a target)", () => {
    expect(contrastRatio(palette.light.bandLabelInkSky, palette.light.paper)).toBeGreaterThanOrEqual(3.457);
    expect(contrastRatio(palette.light.bandLabelInkTerra, palette.light.paper)).toBeGreaterThanOrEqual(4.219);
    expect(contrastRatio(palette.light.bandLabelInkMoss, palette.light.paper)).toBeGreaterThanOrEqual(4.157);
    expect(contrastRatio(palette.light.bandLabelInkAmber, palette.light.paper)).toBeGreaterThanOrEqual(3.117);
  });
});

describe("Task 10b batch 2 — repo-graph.ts search-match highlight (searchHighlight)", () => {
  // hlMatch()'s <mark> text is `color:inherit` — whatever ink is already
  // rendering (`.rg-host .res .nm{color:var(--ink)}`) — so the requirement
  // is `ink` legible ON this token, in both themes. Light needs no change
  // (already generous); dark needed the background DARKENED (not
  // lightened — the opposite direction from the ink-derived text tokens
  // above) because dark.ink is near-white.
  //
  // RED evidence (evidence bar: an assertion that has never failed is not
  // evidence). Temporarily set dark.searchHighlight to its LIGHT value
  // (#f3e0a8, i.e. simulate "forgot to darken for dark mode") and ran
  // `bun test tests/web/tokens/palette.test.ts`. Actual captured output:
  //
  //   error: dark ink on dark searchHighlight (mark bg)
  //   Expected: >= 4.5
  //   Received: 1.0686103119812793
  //   (fail) Task 10b batch 2 — repo-graph.ts search-match highlight (searchHighlight) > dark ink stays legible on dark searchHighlight [0.28ms]
  //
  // Reverted immediately (dark.searchHighlight restored to #806412); re-ran:
  // all tests in this describe block pass.
  test("light ink stays legible on light searchHighlight (generous, no lift needed)", () => {
    expect(contrastRatio(palette.light.ink, palette.light.searchHighlight)).toBeGreaterThanOrEqual(4.5);
  });
  test("dark ink stays legible on dark searchHighlight", () => {
    expect(contrastRatio(palette.dark.ink, palette.dark.searchHighlight), "dark ink on dark searchHighlight (mark bg)").toBeGreaterThanOrEqual(4.5);
  });
});

describe("Task 10b batch 2 — tan (SpanTree.tsx rubric kind, byte-identical to JsonView.tsx's boolean syntax color)", () => {
  // TEXT role (kind-badge label + JsonView boolean literal). Light value is
  // the literal already live today — a pre-existing sub-4.5 gap (same
  // "held, not improved" precedent used throughout this file), pinned.
  // Dark clears the SAME hex unchanged — a rare case where no lift was
  // needed at all, verified rather than assumed.
  // Pins truncated (not rounded) to 3 decimals — always strictly below the
  // live measured value (1.9375444... / 2.0781297...), same anti-slack
  // reasoning as the bandLabelInk pins above.
  test("light tan does not regress below its pre-track measured value on paper/cream (held pre-existing gap, not a target)", () => {
    expect(contrastRatio(palette.light.tan, palette.light.paper)).toBeGreaterThanOrEqual(1.937);
    expect(contrastRatio(palette.light.tan, palette.light.cream)).toBeGreaterThanOrEqual(2.078);
  });
  test("dark tan clears the 4.5:1 text floor on paper/cream at its unlifted hex", () => {
    expect(contrastRatio(palette.dark.tan, palette.dark.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.dark.tan, palette.dark.cream)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("Task 10b batch 2 — critic/diff/render.tsx SIDE_BG (diffDelBg/diffAddBg/diffEmptyBg)", () => {
  // Alpha-composited washes with real diff-line text (tokens.color.terra /
  // tokens.color.moss, unchanged, out of this file's scope) painted directly
  // on top — same mix8bit method as the explain.tsx `.banner` /
  // `blockedYellow` tests above, reused verbatim rather than reimplemented.
  function mix8bit(hexA: string, hexB: string, pctA: number): string {
    const toRgb = (h: string): [number, number, number] => [
      Number.parseInt(h.slice(1, 3), 16),
      Number.parseInt(h.slice(3, 5), 16),
      Number.parseInt(h.slice(5, 7), 16),
    ];
    const a = toRgb(hexA);
    const b = toRgb(hexB);
    const w = pctA / 100;
    const mixCh = (i: number) => Math.round(a[i] * w + b[i] * (1 - w));
    return `#${[mixCh(0), mixCh(1), mixCh(2)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  // Light: the composite is already live today (unchanged literal + alpha) —
  // terra/moss on it are a pre-existing sub-4.5 gap, pinned not fixed. Pins
  // truncated (not rounded) to 3 decimals from the live measured value
  // (2.55909... / 2.50147...), same anti-slack reasoning as above.
  test("light terra on the 18%-diffDelBg/82%-cream mix does not regress below its pre-track measured value (held pre-existing gap)", () => {
    const bg = mix8bit(palette.light.diffDelBg, palette.light.cream, 18);
    expect(contrastRatio(palette.light.terra, bg), `light terra on light diffDelBg/cream 18% mix (${bg})`).toBeGreaterThanOrEqual(2.559);
  });
  test("light moss on the 20%-diffAddBg/80%-cream mix does not regress below its pre-track measured value (held pre-existing gap)", () => {
    const bg = mix8bit(palette.light.diffAddBg, palette.light.cream, 20);
    expect(contrastRatio(palette.light.moss, bg), `light moss on light diffAddBg/cream 20% mix (${bg})`).toBeGreaterThanOrEqual(2.501);
  });

  // Dark: the SAME base hex (unchanged) alpha-composited over dark.cream
  // clears the real 4.5:1 floor because the composite is dominated by
  // dark.cream's near-black at this low alpha — verified, not assumed.
  test("dark terra on the 18%-diffDelBg/82%-dark.cream mix clears the 4.5:1 text floor", () => {
    const bg = mix8bit(palette.dark.diffDelBg, palette.dark.cream, 18);
    expect(contrastRatio(palette.dark.terra, bg), `dark terra on dark diffDelBg/cream 18% mix (${bg})`).toBeGreaterThanOrEqual(4.5);
  });
  test("dark moss on the 20%-diffAddBg/80%-dark.cream mix clears the 4.5:1 text floor", () => {
    const bg = mix8bit(palette.dark.diffAddBg, palette.dark.cream, 20);
    expect(contrastRatio(palette.dark.moss, bg), `dark moss on dark diffAddBg/cream 20% mix (${bg})`).toBeGreaterThanOrEqual(4.5);
  });
});

// Task 10b batch 4's own describe blocks (a retired component washes,
// action-result.ts stat inks, Memory.tsx date-group row, and the fix
// round 1 Critical-fix HUD pairing test) now live in
// tests/web/tokens/palette-batch4.test.ts — split out in fix round 1,
// Important 2: this file was ~785 LOC before batch 4's +130, landing at
// 915, past the repo's 800 LOC hard cap. Same file-organization-only split
// precedent as Task 10b batch 2's fix round (palette.ts -> palette.ts +
// categorical.ts) — a pure move, no assertions changed.

describe("kindPalette — TraceWaterfall's 10-color span-kind identity (Task 10b batch 2, the maintainer's 2026-08-02 decision)", () => {
  const kindTokens = Object.keys(kindPalette.light) as KindToken[];

  test("light and dark define exactly the same keys", () => {
    expect(Object.keys(kindPalette.dark).sort()).toEqual(Object.keys(kindPalette.light).sort());
  });

  // Graphical bar fill — verified in TraceWaterfall.tsx's own JSX that the
  // duration text renders in a SEPARATE sibling div (not on top of the bar);
  // the only text-shaped use of a bar color is a native `title` tooltip, not
  // rendered DOM text — so the floor is 3:1 against TRACK_BG (`edge`), not
  // 4.5:1. Light values are literals already live today; `rubricTier1` is
  // the one pre-existing sub-3:1 gap (held, pinned), every other light value
  // already clears the real floor.
  test("light kind colors clear the 3:1 graphical floor against light.edge, except the pre-existing rubricTier1 gap (held, pinned)", () => {
    const floors: Record<KindToken, number> = {
      turn: 3,
      summarizerHaiku: 3,
      rubricTier1: 2.711,
      rubricTier2: 3,
      intentClassify: 3,
      promptBuild: 3,
      brainFind: 3,
      responseParse: 3,
      critiquePersist: 3,
    };
    for (const key of kindTokens) {
      expect(contrastRatio(kindPalette.light[key], palette.light.edge), `light.${key} vs light.edge`).toBeGreaterThanOrEqual(floors[key]);
    }
  });

  // RED evidence (evidence bar: an assertion that has never failed is not
  // evidence). Temporarily set dark.rubricTier1 to its LIGHT value (#c45a08,
  // i.e. simulate "forgot to lift for dark mode") and ran
  // `bun test tests/web/tokens/palette.test.ts`. Actual captured output:
  //
  //   error: dark.rubricTier1 vs dark.edge
  //   Expected: >= 3
  //   Received: 2.607004129102845
  //   (fail) kindPalette — TraceWaterfall's 10-color span-kind identity (Task 10b batch 2, the maintainer's 2026-08-02 decision) > dark kind colors clear the 3:1 graphical floor against dark.edge (TRACK_BG) [0.56ms]
  //
  // Reverted immediately (dark.rubricTier1 restored to #d56209); re-ran: all
  // tests in this describe block pass.
  test("dark kind colors clear the 3:1 graphical floor against dark.edge (TRACK_BG)", () => {
    for (const key of kindTokens) {
      expect(contrastRatio(kindPalette.dark[key], palette.dark.edge), `dark.${key} vs dark.edge`).toBeGreaterThanOrEqual(3);
    }
  });

  // Distinctness — "two kinds cannot collapse to the same apparent color
  // after re-tuning" (the task's own decision text). An EXACT-hex-equality
  // check (graphPalette's own precedent) is too weak here: the independent
  // per-key HSL lift genuinely converged `rubricTier1`/`rubricTier2` to RGB
  // distance 3.6 (of a ~440 max) before the hue-rotation fix below — two
  // DIFFERENT hex strings that are visually indistinguishable, which a
  // string-uniqueness check cannot see (review round 1, Important 4).
  //
  // Dark gets the real >=40 floor: the hue-rotation fix was designed against
  // it. Light does NOT get the same floor — light values are today's
  // literals, unchanged by this task (same "held not improved" precedent as
  // every contrast pin in this file), and light's closest pair
  // (`intentClassify`/`brainFind`, computed live below) is 35.83 apart,
  // already under 40 — asserting >=40 on light would be asserting a target
  // this task never set out to meet. Pinned instead at a truncated (never
  // rounded) reading of the live measured minimum, so light can only get
  // better, never silently drift closer (review round 1, Important 2).
  function rgbDistance(hexA: string, hexB: string): number {
    const toRgb = (h: string): [number, number, number] => [
      Number.parseInt(h.slice(1, 3), 16),
      Number.parseInt(h.slice(3, 5), 16),
      Number.parseInt(h.slice(5, 7), 16),
    ];
    const [r1, g1, b1] = toRgb(hexA);
    const [r2, g2, b2] = toRgb(hexB);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  }
  const DARK_DISTINCT_THRESHOLD = 40;
  // Truncated from the live measured minimum (intentClassify/brainFind,
  // 35.832945734337834...) — 3 decimals, truncated not rounded, so the pin
  // is always strictly below the true value (Task 10b batch 1's Minor 3 /
  // this batch's own earlier pin-rounding mistake, both the same shape).
  const LIGHT_HELD_MIN_DISTANCE = 35.832;

  // RED evidence, driven per the task's explicit instruction ("collapse two
  // kinds, watch it fail, revert") — AND per review round 1, Important 4:
  // the first capture set dark.rubricTier2 EQUAL to dark.rubricTier1
  // (dist 0.0), which a plain string-inequality check also catches — it did
  // not discriminate this distance check from the worthless check it
  // replaced. Re-captured against the actual case the distance check exists
  // for: two DIFFERENT, DISTINCT hex strings that are still perceptually
  // collided. Temporarily set dark.rubricTier2 to "#d76206" — the real
  // PRE-ROTATION converged value this fix's own lift search produced before
  // the -16deg hue offset was applied (not equal to dark.rubricTier1's
  // "#d56209", a genuinely different string) — and ran
  // `bun test tests/web/tokens/palette.test.ts`. Actual captured output:
  //
  //   error: dark.rubricTier1 vs dark.rubricTier2 (dist 3.6, threshold 40)
  //   Expected: >= 40
  //   Received: 3.605551275463989
  //   (fail) kindPalette — TraceWaterfall's 10-color span-kind identity (Task 10b batch 2, the maintainer's 2026-08-02 decision) > no two dark kind colors collapse to a visually-indistinguishable value (RGB distance >= 40) [0.45ms]
  //
  // A parallel run of `expect(new Set([...]).size).toBe(...)` against the
  // SAME mutation (two distinct strings "#d56209"/"#d76206") passes — proving
  // this distance check catches what the string check misses, not just what
  // it also catches. Reverted immediately (dark.rubricTier2 restored to
  // "#f83910"); re-ran: all tests in this describe block pass.
  test("no two dark kind colors collapse to a visually-indistinguishable value (RGB distance >= 40)", () => {
    for (let i = 0; i < kindTokens.length; i++) {
      for (let j = i + 1; j < kindTokens.length; j++) {
        const a = kindTokens[i]!;
        const b = kindTokens[j]!;
        const dist = rgbDistance(kindPalette.dark[a], kindPalette.dark[b]);
        expect(dist, `dark.${a} vs dark.${b} (dist ${dist.toFixed(1)}, threshold ${DARK_DISTINCT_THRESHOLD})`).toBeGreaterThanOrEqual(
          DARK_DISTINCT_THRESHOLD,
        );
      }
    }
  });

  // Closest surviving DARK pair is `rubricTier1`/`rubricTier2` at 54.36 (the
  // very pair the hue rotation exists to separate — real headroom above the
  // 40 floor is 14.36, not the 30+ a looser reading might suggest); next is
  // `intentClassify`/`brainFind` at 64.66. Live-computed, not copied from an
  // earlier draft (review round 1, Important 3 — an earlier version of this
  // comment named the wrong pair, `promptBuild`/`critiquePersist` at 70.7,
  // which is real but not the closest).
  test("closest surviving dark pair is rubricTier1/rubricTier2 (54.36), not a coincidence of the hue-rotation fix", () => {
    const dist = rgbDistance(kindPalette.dark.rubricTier1, kindPalette.dark.rubricTier2);
    expect(dist).toBeGreaterThanOrEqual(54.359);
    expect(dist).toBeLessThan(55);
  });

  test("light kind colors do not regress below their pre-track measured minimum pairwise distance (held pre-existing gap — light literals are unchanged by this task, not a new 40-floor target)", () => {
    for (let i = 0; i < kindTokens.length; i++) {
      for (let j = i + 1; j < kindTokens.length; j++) {
        const a = kindTokens[i]!;
        const b = kindTokens[j]!;
        const dist = rgbDistance(kindPalette.light[a], kindPalette.light[b]);
        expect(dist, `light.${a} vs light.${b} (dist ${dist.toFixed(1)}, held minimum ${LIGHT_HELD_MIN_DISTANCE})`).toBeGreaterThanOrEqual(
          LIGHT_HELD_MIN_DISTANCE,
        );
      }
    }
  });

  // `siltpoke.summarizer.haiku`/`siltpoke.brain.verify` share ONE token
  // (`summarizerHaiku`) at the KIND_COLORS call site in TraceWaterfall.tsx —
  // that duplication lives at the call-site-key level (two string keys, one
  // token), NOT inside kindPalette itself, so the 9-member token set has no
  // duplicate values by construction. Asserted here so a future edit adding
  // a genuinely new kind can't silently collide with an existing token.
  test("kindPalette.light has no duplicate values (the summarizerHaiku/brainVerify share lives at the KIND_COLORS call site, not in this token set)", () => {
    const values = kindTokens.map((k) => kindPalette.light[k]);
    expect(new Set(values).size).toBe(kindTokens.length);
  });
});

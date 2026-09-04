// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Every foreground drawn on an accent fill resolves through a token.
 *
 * Task 7 migrated 24 white icon strokes / chip labels to `tokens.color.onAccent`
 * because white on the dark accents measures 1.91-2.61 against a 3:1 floor. The
 * test Task 7 pinned for itself (`palette.test.ts`, "onAccent is legible on
 * every dark accent fill") is pure palette arithmetic: it passed BEFORE the
 * migration and would pass if the whole migration were reverted. That is a
 * guard that cannot fire on the work it exists to protect — the shape this
 * repo keeps getting bitten by.
 *
 * This asserts the RENDERED SSR output instead: components that paint on an
 * accent must emit `var(--color-onAccent)` and must not emit a raw white. Task
 * 11 generalises this over the whole rendered surface; until it lands, these
 * are the sites that would otherwise regress in silence.
 *
 * RubricList and PreferenceLogScreen moved OUT of the `onAccent` group in
 * Task 10 (decided item 2): their chips paint real small-bold TEXT on an
 * accent fill, which needs the 4.5:1 text floor, not `onAccent`'s 3:1
 * non-text floor — `onAccent` is white in light mode (where these same fills
 * are light too) and was already failing in dark for most of these fills
 * (see the two screens' own docstrings for the exact measured numbers). They
 * now have their own dedicated assertions below, for the
 * `onTerra`/`onAmber`/`onMoss`/`onSky` tokens that replaced `onAccent`/`ink`
 * (contrast-gated by tests/web/tokens/palette.test.ts "per-accent ink
 * tokens") — kept OUT of this file's shared CASES loop so a future
 * regression back to `onAccent`/`ink` here still fails loud, rather than
 * this test silently re-passing because these screens happen to satisfy a
 * check meant for a different set of components.
 */
import { describe, expect, test } from "bun:test";
import { MemoryByTypeCards } from "../../../src/web/primitives/MemoryByTypeCards";
import { ActiveReposPanel, type ActiveRepoView } from "../../../src/web/primitives/ActiveReposPanel";
import { WorkingMemoryPanel } from "../../../src/web/primitives/WorkingMemoryPanel";
import { RubricList } from "../../../src/web/screens/RubricList";
import { ALL_RUBRIC_RULES } from "../../../src/critic/rubric/rules";
import { PreferenceLogScreen } from "../../../src/web/screens/PreferenceLogScreen";
import { FewShotScreen } from "../../../src/web/screens/FewShotScreen";
import { RepoMemoryScreen } from "../../../src/web/screens/RepoMemoryScreen";
import pillStories from "../../../src/web/atoms/Pill.preview";
import emptyPlaceholderStories from "../../../src/web/primitives/EmptyPlaceholder.preview";

/** Any literal white, in every form the color guard recognises. */
const RAW_WHITE = /#fff\b|#ffffff\b|\bbg-white\b|\btext-white\b|(?<![-\w])white(?![-\w])/i;

const NOW = new Date("2026-06-27T12:00:00Z");

const repoView: ActiveRepoView = {
  project_id: "p1",
  project_root: "/Users/x/code/app",
  display_name: "app",
  last_active_at: "2026-06-27T09:00:00Z",
  chat_count: 2,
  latest_summary: "",
  fact_count: 3,
  repo: undefined,
};

const renderRubricList = () => String(<RubricList rules={ALL_RUBRIC_RULES} calibration={{}} />);

const EMPTY_SIGNAL_COUNTS = { ack: 0, dismiss: 0, forward: 0, feedback: 0 };
// The summary-chip row renders all four signals unconditionally (see
// PreferenceLogScreen.tsx), so an empty entries/counts render already
// exercises every SIGNAL_CHIP fill+token pairing.
const renderPreferenceLogScreen = () => String(<PreferenceLogScreen entries={[]} counts={EMPTY_SIGNAL_COUNTS} />);

// FewShotScreen / RepoMemoryScreen: fix-round-1 finds (2026-08-01). Both had
// `background: tokens.color.sky` paired with `color: tokens.color.ink` on a
// submit button — literally the Task 7 finding's "sky" number (1.83:1 in
// dark, real 12px button text, under the 4.5:1 floor). The token existed
// (onSky) and was simply unapplied at these two call sites; nothing else on
// this branch would have caught it (no color literal for the allowlist
// sweep to visit, and Task 12's CONTRAST_ROUTES doesn't exist yet).
const renderFewShotScreen = () =>
  String(
    <FewShotScreen
      totalEntries={0}
      embeddingDim={0}
      oldestTs={null}
      newestTs={null}
      query={null}
      neighbors={[]}
    />,
  );

// index=null renders the "Build now" button branch (see RepoMemoryScreen.tsx).
const renderRepoMemoryScreen = () => String(<RepoMemoryScreen index={null} />);

const CASES: Array<[string, () => string]> = [
  ["MemoryByTypeCards", () => String(<MemoryByTypeCards />)],
  [
    "ActiveReposPanel",
    () =>
      String(
        <ActiveReposPanel activeProjects={[repoView]} currentProjectId="p1" homeDir="/Users/x" now={NOW} />,
      ),
  ],
  ["WorkingMemoryPanel", () => String(<WorkingMemoryPanel recentChats={[]} />)],
];

describe("accent foregrounds resolve through a token", () => {
  for (const [name, renderIt] of CASES) {
    test(`${name} emits onAccent`, () => {
      expect(renderIt()).toContain("var(--color-onAccent)");
    });

    test(`${name} emits no raw white`, () => {
      // Split from the assertion above on purpose: "still uses the token" and
      // "no literal crept back" fail for different reasons and a single test
      // would hide which one broke.
      expect(renderIt()).not.toMatch(RAW_WHITE);
    });
  }

  // RubricList: see the docstring at the top of this file for why it is not
  // in CASES above. All three tier badges must resolve through their own
  // per-accent token, none through `onAccent`, and none through raw white.
  test("RubricList emits onMoss, onAmber, and onSky (one per tier, not onAccent)", () => {
    const html = renderRubricList();
    expect(html).toContain("var(--color-onMoss)");
    expect(html).toContain("var(--color-onAmber)");
    expect(html).toContain("var(--color-onSky)");
    expect(html).not.toContain("var(--color-onAccent)");
  });

  test("RubricList emits no raw white", () => {
    expect(renderRubricList()).not.toMatch(RAW_WHITE);
  });

  // PreferenceLogScreen: same reasoning as RubricList above. All four signal
  // chips must resolve through their own per-accent token, none through
  // `onAccent` (the pre-fix `dismiss`/terra pairing) or `ink` (the pre-fix
  // `ack`/`forward`/`feedback` pairing), and none through raw white.
  test("PreferenceLogScreen emits onTerra, onAmber, onMoss, and onSky (one per signal, not onAccent)", () => {
    const html = renderPreferenceLogScreen();
    expect(html).toContain("var(--color-onTerra)");
    expect(html).toContain("var(--color-onAmber)");
    expect(html).toContain("var(--color-onMoss)");
    expect(html).toContain("var(--color-onSky)");
    expect(html).not.toContain("var(--color-onAccent)");
  });

  test("PreferenceLogScreen emits no raw white", () => {
    expect(renderPreferenceLogScreen()).not.toMatch(RAW_WHITE);
  });

  // FewShotScreen / RepoMemoryScreen: see the renderers' comments above.
  test("FewShotScreen's Search button emits onSky, not ink", () => {
    const html = renderFewShotScreen();
    expect(html).toContain("var(--color-onSky)");
    expect(html).not.toContain("background:var(--color-sky);color:var(--color-ink)");
  });

  test("RepoMemoryScreen's Build now button emits onSky, not ink", () => {
    const html = renderRepoMemoryScreen();
    expect(html).toContain("var(--color-onSky)");
    expect(html).not.toContain("background:var(--color-sky);color:var(--color-ink)");
  });

  // Pill.preview.tsx / EmptyPlaceholder.preview.tsx: fix-round-1 finds, dev-only
  // component-preview gallery (src/web/routes/preview.tsx, SILTPOKE_ENV!==
  // production), but the SAME defect shape — flagged by the independent
  // reviewer as a real "nothing catches a silent regression" gap even though
  // today's blast radius is dev-tooling-only. `render()` returns a JSX node
  // (`PreviewStory.render: () => unknown`), so it's stringified the same way
  // every other component here is.
  // forbidden = the SPECIFIC wrong token that story used before the fix
  // (terra/moss used `onAccent`; amber used plain `ink` — not the same bug,
  // so not the same forbidden string).
  const pillCases: Array<[string, string, string]> = [
    ["terra background", "var(--color-onTerra)", "var(--color-onAccent)"],
    ["moss background", "var(--color-onMoss)", "var(--color-onAccent)"],
    ["amber background", "var(--color-onAmber)", "var(--color-ink)"],
  ];
  for (const [storyName, expectedToken, forbidden] of pillCases) {
    test(`Pill.preview "${storyName}" emits ${expectedToken}, not ${forbidden}`, () => {
      const story = pillStories.find((s) => s.name === storyName);
      if (!story) throw new Error(`Pill.preview.tsx story "${storyName}" not found`);
      const html = String(story.render());
      expect(html).toContain(expectedToken);
      expect(html).not.toContain(forbidden);
    });
  }

  test('EmptyPlaceholder.preview "with Creature art slot" action button emits onTerra, not onAccent', () => {
    const story = emptyPlaceholderStories.find((s) => s.name === "with Creature art slot");
    if (!story) throw new Error('EmptyPlaceholder.preview.tsx story "with Creature art slot" not found');
    const html = String(story.render());
    expect(html).toContain("var(--color-onTerra)");
    expect(html).not.toContain("var(--color-onAccent)");
  });
});

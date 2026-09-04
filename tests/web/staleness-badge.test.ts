// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * staleness badge — SSR render/state test + wire-contract guard + fresh
 * negative test.
 *
 * The badge's four states (loading / not_indexed / verdict / check_failed)
 * are Alpine `x-show`-gated spans; the client-side reactivity itself is
 * covered by `tests/web/client/islands/staleness-badge.test.ts` (the pure
 * `makeStalenessBadge` factory, fetch injected — no DOM/Alpine runtime).
 * This file proves the SSR markup: the island is wired to the right fetch
 * target, declares all four state markers, and reads the wire's EXACT
 * snake_case field names (not a renamed/camelCase copy) — a real regression
 * here (e.g. `verdict.counts.contentChanged`) fails these assertions.
 */
import { describe, expect, test } from "bun:test";
import { stalenessVerdict } from "../../src/repo-graph/staleness-verdict";
import { ActiveReposPanel, type ActiveRepoView } from "../../src/web/primitives/ActiveReposPanel";
import { tokens } from "../../src/web/tokens/tokens";

function render(node: unknown): string {
  return String(node);
}

const NOW = new Date("2026-07-26T12:00:00Z");

function indexedProject(overrides: Partial<ActiveRepoView> = {}): ActiveRepoView {
  return {
    project_id: "p1",
    project_root: "/x/repo",
    display_name: "repo",
    repo: {
      files: 5,
      components: 0,
      indexed_at: new Date().toISOString(),
      areas: [],
      component_titles: [],
      summary_text: null,
    },
    ...overrides,
  } as ActiveRepoView;
}

describe("staleness badge — SSR wiring", () => {
  test("indexed repo row carries a staleness-badge island with a fetch target", () => {
    const html = render(
      ActiveReposPanel({
        activeProjects: [indexedProject()],
        currentProjectId: "p1",
        homeDir: "/x",
        now: NOW,
      }),
    );
    expect(html).toContain("staleness-badge");
    expect(html).toContain('x-data="stalenessBadge"');
    // Tightened from a loose substring match to the actual attribute — pins
    // the wire-up name (`data-staleness-url`), not just that the URL string
    // appears somewhere in the markup (final-review FIX 3).
    expect(html).toContain('data-staleness-url="/api/repo-graph/staleness?repo=');
  });

  test("badge markup declares all four states (loading/not_indexed/verdict/check_failed)", () => {
    const html = render(
      ActiveReposPanel({
        activeProjects: [indexedProject()],
        currentProjectId: "p1",
        homeDir: "/x",
        now: NOW,
      }),
    );
    for (const st of ["st-loading", "st-not-indexed", "st-verdict", "st-check-failed"]) {
      expect(html).toContain(st);
    }
  });

  test("never-indexed repo (repo: null) renders no staleness-badge island", () => {
    const html = render(
      ActiveReposPanel({
        activeProjects: [indexedProject({ repo: null })],
        currentProjectId: "p1",
        homeDir: "/x",
        now: NOW,
      }),
    );
    expect(html).not.toContain("staleness-badge");
  });
});

describe("staleness badge — wire-contract (field-name-mismatch guard)", () => {
  test("panel consumes the EXACT serialized verdict field names (snake_case)", () => {
    const v = stalenessVerdict(
      {
        indexed: 5,
        unchanged: 4,
        content_changed: 1,
        deleted_still_indexed: 0,
        unindexed_files: 0,
        read_errors: 0,
        content_stale_pct: 0.2,
        rows_wrong_pct: 0.2,
      },
      0.2,
    );
    // Exact wire shape — round-trip through JSON like the real HTTP response.
    const serialized = JSON.parse(JSON.stringify({ success: true, data: v })) as {
      success: boolean;
      data: { level: string; headline: string; counts: Record<string, number> };
    };
    expect(serialized.data).toHaveProperty("level");
    expect(serialized.data).toHaveProperty("headline");
    expect(serialized.data.counts).toHaveProperty("content_changed");
    expect(serialized.data.counts).toHaveProperty("wrong_ratio");

    // The panel's rendered markup must itself reference these EXACT
    // snake_case accessors (not a camelCase rename) — this is what actually
    // fails if someone edits the island/panel to read `contentChanged` /
    // `wrongRatio` / `deletedStillIndexed`.
    const html = render(
      ActiveReposPanel({
        activeProjects: [indexedProject()],
        currentProjectId: "p1",
        homeDir: "/x",
        now: NOW,
      }),
    );
    expect(html).toContain("verdict.counts.content_changed");
    expect(html).toContain("verdict.counts.deleted_still_indexed");
    expect(html).toContain("verdict.counts.unindexed_files");
    expect(html).toContain("verdict.counts.wrong_ratio");
    expect(html).toContain("verdict.headline");
    expect(html).toContain("verdict.level");
    // The mismatch guard: none of the camelCase spellings ever appear.
    expect(html).not.toContain("contentChanged");
    expect(html).not.toContain("deletedStillIndexed");
    expect(html).not.toContain("unindexedFiles");
    expect(html).not.toContain("wrongRatio");
  });
});

describe("staleness badge — fresh negative test", () => {
  test("fresh verdict → no warning text / no counts in the verdict span (dot only)", () => {
    const v = stalenessVerdict(
      {
        indexed: 5,
        unchanged: 5,
        content_changed: 0,
        deleted_still_indexed: 0,
        unindexed_files: 0,
        read_errors: 0,
        content_stale_pct: 0,
        rows_wrong_pct: 0,
      },
      0.2,
    );
    expect(v.level).toBe("fresh");

    const html = render(
      ActiveReposPanel({
        activeProjects: [indexedProject()],
        currentProjectId: "p1",
        homeDir: "/x",
        now: NOW,
      }),
    );
    // The fresh branch (x-if="verdict.level === 'fresh'") renders ONLY the
    // dot marker — no headline/counts binding lives inside it. Assert the
    // static markup never spells out drift language as literal text (the
    // headline/count strings are runtime-computed, never baked into SSR
    // output either way, but this pins the structural invariant: the
    // fresh-only template block is a bare dot span with no text binding).
    expect(html).not.toContain("out of date");
    expect(html).not.toContain("drifted since indexing");
    // hono/jsx HTML-escapes attribute values (`&&` → `&amp;&amp;`, `'` → `&#39;`).
    const freshBlockMatch = html.match(
      /<template x-if="verdict &amp;&amp; verdict\.level === &#39;fresh&#39;">([\s\S]*?)<\/template>/,
    );
    expect(freshBlockMatch).not.toBeNull();
    const freshBlock = freshBlockMatch?.[1] ?? "";
    expect(freshBlock).not.toContain("headline");
    expect(freshBlock).not.toContain("counts");
  });
});

describe("staleness badge — check_failed state", () => {
  test("check_failed marker renders visible red-coded fallback text (not blank)", () => {
    const html = render(
      ActiveReposPanel({
        activeProjects: [indexedProject()],
        currentProjectId: "p1",
        homeDir: "/x",
        now: NOW,
      }),
    );
    const checkFailedMatch = html.match(/<span class="st-check-failed"[^>]*>([\s\S]*?)<\/span>/);
    expect(checkFailedMatch).not.toBeNull();
    const block = checkFailedMatch?.[0] ?? "";
    expect(block).toContain("staleness check failed");
    // Non-green: uses tokens.color.terra (red), which SSR renders as the
    // var() indirection — spec §5.1 requires check_failed to be visually
    // non-green like stale/unknown.
    expect(block).toContain(tokens.color.terra);
    expect(block).not.toContain(tokens.color.moss);
  });
});

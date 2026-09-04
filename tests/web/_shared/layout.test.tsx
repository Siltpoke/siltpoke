/**
 * layout — <head> contract tests.
 *
 * Both schemes are real as of the dark-mode track: tokens.css ships four blocks
 * (`:root`, the `prefers-color-scheme: dark` media query, and the two forced
 * `[data-theme]` overrides), each declaring its own `color-scheme` so native
 * scrollbars and form controls follow a FORCED theme rather than only the
 * system one. The meta tag is the pre-CSS default and must advertise BOTH.
 *
 * Before that, the dashboard was welded light-mode and this file pinned
 * `content="light"` as an opt-out against auto-inverting extensions (Dark
 * Reader class). That assertion asserted exactly what the dark-mode work
 * changes, so it is replaced rather than deleted — with a negative half, since
 * silently reverting to a single-scheme meta is the regression that would
 * reintroduce the inversion problem in the other direction.
 */
import { describe, test, expect } from "bun:test";
import { Layout } from "../../../src/web/_shared/layout";

function render(node: unknown): string {
  // Hono JSX nodes expose toString() → HTML string.
  return String(node);
}

describe("Layout <head>", () => {
  test("advertises BOTH schemes so a forced theme drives native controls", () => {
    const html = render(Layout({ children: "x" }));
    expect(html).toContain('name="color-scheme"');
    expect(html).toContain('content="light dark"');
  });

  test("does not fall back to a single-scheme declaration", () => {
    const html = render(Layout({ children: "x" }));
    expect(html).not.toContain('content="light"/>');
    expect(html).not.toContain('content="dark"/>');
  });

  test("applies the persisted theme before <body>, ahead of the sidebar script", () => {
    // First paint correctness: the theme attribute must be on <html> before the
    // body parses, or a light flash precedes hydration. Ordering matters too —
    // theme governs paint, so it runs first.
    const html = render(Layout({ children: "x" }));
    const themeScript = html.indexOf("siltpokeTheme");
    const sidebarScript = html.indexOf("siltpokeSidebarCollapsed");
    const bodyStart = html.indexOf("<body");
    expect(themeScript).toBeGreaterThan(-1);
    expect(themeScript).toBeLessThan(sidebarScript);
    expect(themeScript).toBeLessThan(bodyStart);
  });

  test("a non-dark/light stored value REMOVES the attribute rather than leaving a stale one", () => {
    // `system` must clear `data-theme` so the media query governs. Leaving a
    // stale attribute is what breaks the multi-tab storage listener when
    // another tab resets to `system`.
    const html = render(Layout({ children: "x" }));
    expect(html).toContain("removeAttribute('data-theme')");
  });
});

/**
 * layout — <head> contract tests.
 *
 * The dashboard is welded light-mode (tokens.css has no dark override). Without
 * an explicit color-scheme opt-out, system-dark-following browser extensions
 * (Dark Reader class) auto-invert the page. Pin the opt-out so it can't regress.
 */
import { describe, test, expect } from "bun:test";
import { Layout } from "../../../src/web/_shared/layout";

function render(node: unknown): string {
  // Hono JSX nodes expose toString() → HTML string.
  return String(node);
}

describe("Layout <head>", () => {
  test("declares color-scheme: light to opt out of dark-mode-inverting extensions", () => {
    const html = render(Layout({ children: "x" }));
    expect(html).toContain('name="color-scheme"');
    expect(html).toContain('content="light"');
  });
});

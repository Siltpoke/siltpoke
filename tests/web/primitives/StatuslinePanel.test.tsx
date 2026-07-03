/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { StatuslinePanel } from "../../../src/web/primitives/StatuslinePanel";
import { tokens } from "../../../src/web/tokens/tokens";

describe("StatuslinePanel", () => {
  test("renders a <pre> element (preserves whitespace + newlines)", () => {
    const html = String(<StatuslinePanel text="hello" />);
    expect(html).toContain("<pre");
    expect(html).toContain("</pre>");
  });

  test("applies font-mono token via inline style", () => {
    const html = String(<StatuslinePanel text="hello" />);
    expect(html).toContain("JetBrains Mono");
  });

  test("applies ink dark background + cream text color", () => {
    const html = String(<StatuslinePanel text="hello" />);
    expect(html).toContain(tokens.color.ink);
    expect(html).toContain(tokens.color.cream);
  });

  test("does NOT set overflow scroll (height-by-content panel)", () => {
    const html = String(<StatuslinePanel text="hello" />);
    expect(html).not.toMatch(/overflow:\s*(auto|scroll)/);
  });

  test("preserves text content verbatim including newlines", () => {
    const text = `line1
line2
line3`;
    const html = String(<StatuslinePanel text={text} />);
    expect(html).toContain("line1");
    expect(html).toContain("line2");
    expect(html).toContain("line3");
  });

  test("renders statusline-panel class for global style hooks", () => {
    const html = String(<StatuslinePanel text="hello" />);
    expect(html).toContain('class="statusline-panel"');
  });

  test("renders empty text without crash", () => {
    const html = String(<StatuslinePanel text="" />);
    expect(html).toContain("<pre");
    expect(html).toContain("</pre>");
  });

  test("uses 1px border in ink2 outline tone", () => {
    const html = String(<StatuslinePanel text="x" />);
    expect(html).toContain("1px solid");
    expect(html).toContain(tokens.color.ink2);
  });
});

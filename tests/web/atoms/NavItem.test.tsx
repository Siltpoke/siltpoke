/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { NavItem } from "../../../src/web/atoms/NavItem";
import { tokens } from "../../../src/web/tokens/tokens";

describe("NavItem", () => {
  test("renders label text", () => {
    const html = String(<NavItem label="Inbox" />);
    expect(html).toContain("Inbox");
  });

  test("inactive uses transparent background and ink2 color", () => {
    const html = String(<NavItem label="Inbox" />);
    expect(html).toContain("transparent");
    expect(html).toContain(tokens.color.ink2);
  });

  test("active uses paperD background and ink color", () => {
    const html = String(<NavItem label="Inbox" active={true} />);
    expect(html).toContain(tokens.color.paperD);
    expect(html).toContain(tokens.color.ink);
  });

  test("renders icon when provided", () => {
    const html = String(<NavItem icon="✉" label="Inbox" />);
    expect(html).toContain("✉");
  });

  test("renders count when provided", () => {
    const html = String(<NavItem label="Events" count={42} />);
    expect(html).toContain("42");
    // count badge is the only span with font-size:10px
    expect(html).toMatch(/font-size:\s*10px/);
  });

  test("renders count badge when count is 0", () => {
    const html = String(<NavItem label="Events" count={0} />);
    // `count != null` guard MUST treat 0 as renderable
    expect(html).toContain(">0<");
    expect(html).toMatch(/font-size:\s*10px/);
  });

  test("does not render count badge when count is null/undefined", () => {
    const html = String(<NavItem label="Events" />);
    // count badge is the only span carrying font-size:10px — its absence proves no badge
    expect(html).not.toMatch(/font-size:\s*10px/);
  });

  // disabled rendering
  test("disabled renders as <span> not <a>", () => {
    const html = String(<NavItem label="Settings" disabled={true} />);
    // Must have aria-disabled attribute
    expect(html).toContain('aria-disabled="true"');
    // Must NOT have an <a> tag (no href navigation)
    expect(html).not.toContain("<a");
    expect(html).not.toContain("</a>");
  });

  test("disabled renders with nav-item--disabled class", () => {
    const html = String(<NavItem label="Settings" disabled={true} />);
    expect(html).toContain("nav-item--disabled");
  });

  test("disabled has opacity and cursor:not-allowed in inline style", () => {
    const html = String(<NavItem label="Settings" disabled={true} />);
    expect(html).toContain("opacity");
    expect(html).toContain("not-allowed");
  });

  test("disabled still renders the label text", () => {
    const html = String(<NavItem label="Settings" disabled={true} />);
    expect(html).toContain("Settings");
  });

  test("active highlight does not apply when disabled", () => {
    // Even if activeSection === 'settings', disabled entry must NOT show paperD bg
    const html = String(<NavItem label="Settings" disabled={true} active={true} />);
    expect(html).not.toContain(tokens.color.paperD);
    expect(html).toContain('aria-disabled="true"');
  });

  test("non-disabled renders as <a> wrapper (no aria-disabled)", () => {
    const html = String(<NavItem label="Home" />);
    expect(html).not.toContain("aria-disabled");
    expect(html).not.toContain("nav-item--disabled");
    expect(html).toContain("<a");
    expect(html).toContain("</a>");
  });

  test("enabled NavItem renders <a href> with correct href attribute", () => {
    const html = String(<NavItem label="Home" href="/" />);
    expect(html).toContain('<a');
    expect(html).toContain('href="/"');
  });

  test("enabled NavItem with href=/memory renders correct href", () => {
    const html = String(<NavItem label="Memory" href="/memory" />);
    expect(html).toContain('href="/memory"');
  });

  // Fix 2: disabled <span> a11y attributes
  test("disabled <span> has role='link' for screen-reader correctness", () => {
    const html = String(<NavItem label="Settings" disabled={true} />);
    expect(html).toContain('role="link"');
  });

  test("disabled <span> has tabIndex=-1 to remove it from tab order", () => {
    const html = String(<NavItem label="Settings" disabled={true} />);
    // Hono/JSX serialises tabIndex as "tabIndex" (camelCase) in the attribute
    expect(html).toContain('tabIndex="-1"');
  });

  test("disabled NavItem renders no <a> and no href attribute", () => {
    const html = String(<NavItem label="Settings" disabled={true} href="/settings" />);
    expect(html).not.toContain("<a");
    expect(html).not.toContain("</a>");
    expect(html).not.toContain('href=');
  });

  // Fx-07: aria-current="page" on active nav entries
  test("active NavItem has aria-current='page' on the <a> element", () => {
    const html = String(<NavItem label="Home" href="/" active={true} />);
    expect(html).toContain('aria-current="page"');
  });

  test("inactive NavItem does NOT have aria-current attribute", () => {
    const html = String(<NavItem label="Home" href="/" />);
    expect(html).not.toContain("aria-current");
  });

  // count k-formatting via formatCount helper
  test("count 1500 renders as '1.5k' (k-format, enabled branch)", () => {
    const html = String(<NavItem label="Memory" count={1500} href="/memory" />);
    expect(html).toContain("1.5k");
    expect(html).not.toContain(">1500<");
  });

  test("count 5400 renders as '5.4k' (k-format, enabled branch)", () => {
    const html = String(<NavItem label="Memory" count={5400} href="/memory" />);
    expect(html).toContain("5.4k");
  });

  test("count 999 renders as '999' (below k-threshold, enabled branch)", () => {
    const html = String(<NavItem label="Memory" count={999} href="/memory" />);
    expect(html).toContain(">999<");
    expect(html).not.toMatch(/>\d+\.?\d*k</);
  });

  test("count 1500 renders as '1.5k' on disabled NavItem branch", () => {
    const html = String(<NavItem label="Stats" count={1500} disabled={true} />);
    expect(html).toContain("1.5k");
  });

  // meta prop tests
  test("meta prop renders nav-item__meta span with text", () => {
    const html = String(<NavItem label="Home" href="/" meta="today" />);
    expect(html).toContain("nav-item__meta");
    expect(html).toContain("today");
  });

  test("meta prop renders on disabled NavItem branch", () => {
    const html = String(<NavItem label="Stats" disabled={true} meta="7d" />);
    expect(html).toContain("nav-item__meta");
    expect(html).toContain("7d");
  });

  test("meta prop renders '1.3k facts' string without truncation", () => {
    const html = String(<NavItem label="Memory" href="/memory" meta="1.3k facts" />);
    expect(html).toContain("1.3k facts");
  });

  test("no meta prop → no nav-item__meta span", () => {
    const html = String(<NavItem label="Commands" href="/commands" />);
    expect(html).not.toContain("nav-item__meta");
  });
});

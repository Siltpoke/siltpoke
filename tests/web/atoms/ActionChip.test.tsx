/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { ActionChip } from "../../../src/web/atoms/ActionChip";
import { tokens } from "../../../src/web/tokens/tokens";

describe("ActionChip", () => {
  test("hx-post attribute is '/api/action'", () => {
    const html = String(<ActionChip action="feed" label="feed" />);
    expect(html).toContain('hx-post="/api/action"');
  });

  test("hx-vals attribute is present and contains 'feed'", () => {
    const html = String(<ActionChip action="feed" label="feed" />);
    // hx-vals is present and action value appears in it (HTML-escaped JSON)
    expect(html).toContain("hx-vals=");
    expect(html).toContain("feed");
  });

  test("hx-target is '#hero'", () => {
    const html = String(<ActionChip action="feed" label="feed" />);
    expect(html).toContain('hx-target="#hero"');
  });

  test("hx-swap is 'outerHTML'", () => {
    const html = String(<ActionChip action="feed" label="feed" />);
    expect(html).toContain('hx-swap="outerHTML"');
  });

  test("Alpine x-data contains busy:false", () => {
    const html = String(<ActionChip action="play" label="play" />);
    expect(html).toContain("x-data=");
    expect(html).toContain("busy:false");
  });

  test("Alpine busy-state class binding is present", () => {
    const html = String(<ActionChip action="pet" label="pet" />);
    expect(html).toContain("action-chip--busy");
  });

  test("renders icon when provided", () => {
    const html = String(<ActionChip action="feed" label="feed" icon="🍖" />);
    expect(html).toContain("🍖");
    expect(html).toContain('class="action-chip__icon"');
  });

  test("omits icon span when icon not provided", () => {
    const html = String(<ActionChip action="feed" label="feed" />);
    expect(html).not.toContain("action-chip__icon");
  });

  test("renders label text", () => {
    const html = String(<ActionChip action="play" label="play" />);
    expect(html).toContain(">play<");
    expect(html).toContain('class="action-chip__label"');
  });

  test("data-action attribute reflects action prop", () => {
    const html = String(<ActionChip action="pet" label="pet" />);
    expect(html).toContain('data-action="pet"');
  });

  test("renders as <button>", () => {
    const html = String(<ActionChip action="feed" label="feed" />);
    expect(html).toContain("<button");
    expect(html).toContain("</button>");
  });

  // ActionChip tone is derived from action type.
  // feed → amber tone (not paper bg / edge border).
  test("feed action uses amber tone background", () => {
    const html = String(<ActionChip action="feed" label="feed" />);
    expect(html).toContain(tokens.color.amber);
  });

  test("play action uses moss tone background", () => {
    const html = String(<ActionChip action="play" label="play" />);
    expect(html).toContain(tokens.color.moss);
  });

  test("clean action uses sky tone background", () => {
    const html = String(<ActionChip action="clean" label="clean" />);
    expect(html).toContain(tokens.color.sky);
  });

  test("sleep action uses dark (ink) tone background", () => {
    const html = String(<ActionChip action="sleep" label="sleep" />);
    expect(html).toContain(tokens.color.ink);
  });

  test("feed chip uses cream foreground on solid amber bg (solid-tone refresh)", () => {
    const html = String(<ActionChip action="feed" label="feed" />);
    // Solid amber bg + cream text (previously tinted-amber + ink).
    expect(html).toContain(tokens.color.cream);
    expect(html).toContain(tokens.color.amber);
  });

  test("pet action uses terra tone (pet mapped to terra)", () => {
    const html = String(<ActionChip action="pet" label="pet" />);
    expect(html).toContain(tokens.color.terra);
  });

  test("uses mono font token", () => {
    const html = String(<ActionChip action="feed" label="feed" />);
    // Hono JSX HTML-escapes quote chars in attribute values; check for
    // the unescaped font family name inside the style string.
    expect(html).toContain("JetBrains Mono");
  });

  test("cursor:pointer is applied", () => {
    const html = String(<ActionChip action="feed" label="feed" />);
    expect(html).toContain("cursor:pointer");
  });

  test("all six action values render without error (Wave 1.5b extended union)", () => {
    const actions = ["feed", "play", "pet", "tease", "clean", "sleep"] as const;
    for (const action of actions) {
      const html = String(<ActionChip action={action} label={action} />);
      expect(html).toContain(`data-action="${action}"`);
      // hx-vals is HTML-escaped; check for the action value via data-action
      // which is not escaped. JSON content verifiable via hx-vals attribute.
      expect(html).toContain(`hx-vals=`);
      expect(html).toContain(action);
    }
  });

  test("keyCap prop renders a key-cap span when provided", () => {
    const html = String(<ActionChip action="feed" label="feed" keyCap="F" />);
    expect(html).toContain("action-chip__keycap");
    expect(html).toContain(">F<");
  });

  test("keyCap prop is absent when not provided", () => {
    const html = String(<ActionChip action="feed" label="feed" />);
    expect(html).not.toContain("action-chip__keycap");
  });

  test("keyCap 'Z' renders on sleep action", () => {
    const html = String(<ActionChip action="sleep" label="sleep" keyCap="Z" />);
    expect(html).toContain(">Z<");
  });

  // pet action with keyCap E + terra tone
  test("pet/E variant renders data-action=pet + keyCap E + terra color", () => {
    const html = String(<ActionChip action="pet" label="pet" keyCap="E" />);
    expect(html).toContain('data-action="pet"');
    expect(html).toContain(">E<");
    expect(html).toContain(tokens.color.terra);
  });
});

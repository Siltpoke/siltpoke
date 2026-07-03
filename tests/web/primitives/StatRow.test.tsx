/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { StatRow } from "../../../src/web/primitives/StatRow";
import { tokens } from "../../../src/web/tokens/tokens";

describe("StatRow", () => {
  test("renders label", () => {
    const html = String(<StatRow label="focus" value={7} />);
    expect(html).toContain("focus");
  });

  test("renders value/max badge", () => {
    const html = String(<StatRow label="focus" value={7} max={10} />);
    expect(html).toContain("7/10");
  });

  test("default max is 10", () => {
    const html = String(<StatRow label="focus" value={5} />);
    expect(html).toContain("5/10");
  });

  test("renders icon when provided", () => {
    const html = String(<StatRow icon="🔥" label="energy" value={8} />);
    expect(html).toContain("🔥");
  });

  test("icon is omitted when not provided", () => {
    const html = String(<StatRow label="energy" value={8} />);
    // No icon span with width:14
    expect(html).not.toContain("width:14");
  });

  test("composes Meter atom (segments present)", () => {
    const html = String(<StatRow label="focus" value={3} max={5} />);
    // Meter renders <i> segments — check for multiple <i  elements
    const segments = html.match(/<i /g) ?? [];
    expect(segments.length).toBe(5);
  });

  test("default color is terra", () => {
    const html = String(<StatRow label="focus" value={7} />);
    expect(html).toContain(tokens.color.terra);
  });

  test("custom color is passed to Meter", () => {
    const html = String(
      <StatRow label="health" value={9} max={10} color={tokens.color.moss} />,
    );
    expect(html).toContain(tokens.color.moss);
  });

  test("label uses mono font and ink2 color", () => {
    const html = String(<StatRow label="focus" value={5} />);
    // font-family is HTML-entity-escaped in SSR output
    expect(html).toContain("JetBrains Mono");
    expect(html).toContain(tokens.color.ink2);
  });

  test("value/max badge uses ink3 color", () => {
    const html = String(<StatRow label="focus" value={5} />);
    expect(html).toContain(tokens.color.ink3);
  });

  test("value/max badge has marginLeft auto", () => {
    const html = String(<StatRow label="focus" value={5} />);
    expect(html).toContain("margin-left:auto");
  });
});

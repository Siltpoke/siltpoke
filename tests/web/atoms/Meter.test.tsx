/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { Meter } from "../../../src/web/atoms/Meter";
import { tokens } from "../../../src/web/tokens/tokens";

describe("Meter", () => {
  test("renders correct number of segments", () => {
    const html = String(<Meter value={3} max={10} />);
    // Each segment is an <i> element
    const segments = html.match(/<i /g) ?? [];
    expect(segments.length).toBe(10);
  });

  test("filled segments use color token, empty use track token", () => {
    const html = String(<Meter value={3} max={5} />);
    // terra appears at least 3 times (filled), paperD at least 2 times (empty)
    expect(html).toContain(tokens.color.terra);
    expect(html).toContain(tokens.color.paperD);
  });

  test("custom color renders", () => {
    const html = String(<Meter value={5} max={10} color={tokens.color.moss} />);
    expect(html).toContain(tokens.color.moss);
  });

  test("segments have border-radius:1", () => {
    const html = String(<Meter value={1} max={3} />);
    expect(html).toContain("border-radius:1");
  });
});

/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { Dot } from "../../../src/web/atoms/Dot";
import { tokens } from "../../../src/web/tokens/tokens";

describe("Dot", () => {
  test("renders as <i> element", () => {
    const html = String(<Dot />);
    expect(html).toContain("<i");
  });

  test("default color is terra", () => {
    const html = String(<Dot />);
    expect(html).toContain(tokens.color.terra);
  });

  test("custom color renders", () => {
    const html = String(<Dot color={tokens.color.moss} />);
    expect(html).toContain(tokens.color.moss);
  });

  test("custom size renders width and height", () => {
    const html = String(<Dot size={12} />);
    expect(html).toContain("width:12");
    expect(html).toContain("height:12");
  });

  test("has border-radius 50%", () => {
    const html = String(<Dot />);
    expect(html).toContain("border-radius:50%");
  });
});

/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { Pill } from "../../../src/web/atoms/Pill";
import { tokens } from "../../../src/web/tokens/tokens";

describe("Pill", () => {
  test("renders as span with mono font", () => {
    const html = String(<Pill>tag</Pill>);
    expect(html).toContain("<span");
    expect(html).toContain("tag");
    expect(html).toContain("JetBrains Mono");
  });

  test("default border is edge color", () => {
    const html = String(<Pill>tag</Pill>);
    expect(html).toContain(tokens.color.edge);
  });

  test("terra background variant", () => {
    const html = String(
      <Pill bg={tokens.color.terra} border={tokens.color.terra} color="#fff">
        terra
      </Pill>,
    );
    expect(html).toContain(tokens.color.terra);
    expect(html).toContain("terra");
  });

  test("has border-radius for pill shape", () => {
    const html = String(<Pill>tag</Pill>);
    expect(html).toContain("border-radius:999");
  });
});

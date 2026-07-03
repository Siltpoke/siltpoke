/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { Card } from "../../../src/web/atoms/Card";
import { tokens } from "../../../src/web/tokens/tokens";

describe("Card", () => {
  test("renders paper background with edge border", () => {
    const html = String(<Card>content</Card>);
    expect(html).toContain(tokens.color.paper); // #f4eedf
    expect(html).toContain(tokens.color.edge); // #d8cbab
    expect(html).toContain("content");
  });

  test("applies custom pad value", () => {
    const html = String(<Card pad={32}>body</Card>);
    expect(html).toContain("padding:32");
  });

  test("default pad is 16", () => {
    const html = String(<Card>body</Card>);
    expect(html).toContain("padding:16");
  });
});

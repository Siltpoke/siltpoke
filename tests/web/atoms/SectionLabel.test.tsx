/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { SectionLabel } from "../../../src/web/atoms/SectionLabel";
import { tokens } from "../../../src/web/tokens/tokens";

describe("SectionLabel", () => {
  test("renders children text", () => {
    const html = String(<SectionLabel>PET</SectionLabel>);
    expect(html).toContain("PET");
  });

  test("uses tokens.color.ink3 for muted color", () => {
    const html = String(<SectionLabel>PET</SectionLabel>);
    expect(html).toContain(tokens.color.ink3);
  });

  test("has text-transform uppercase", () => {
    const html = String(<SectionLabel>PET</SectionLabel>);
    expect(html).toContain("uppercase");
  });

  test("has font-weight 500", () => {
    const html = String(<SectionLabel>PET</SectionLabel>);
    expect(html).toContain("500");
  });

  test("has font-size 10px", () => {
    const html = String(<SectionLabel>PET</SectionLabel>);
    expect(html).toMatch(/font-size:\s*10px/);
  });

  test("has letter-spacing 0.08em", () => {
    const html = String(<SectionLabel>PET</SectionLabel>);
    expect(html).toContain("0.08em");
  });

  test("does NOT set x-show when xShow prop is omitted", () => {
    const html = String(<SectionLabel>PET</SectionLabel>);
    expect(html).not.toContain("x-show");
  });

  test("sets x-show attribute when xShow prop is provided", () => {
    const html = String(<SectionLabel xShow="!collapsed">PET</SectionLabel>);
    expect(html).toContain('x-show="!collapsed"');
  });

  test("renders WORK label correctly", () => {
    const html = String(<SectionLabel xShow="!collapsed">WORK</SectionLabel>);
    expect(html).toContain("WORK");
    expect(html).toContain('x-show="!collapsed"');
  });
});

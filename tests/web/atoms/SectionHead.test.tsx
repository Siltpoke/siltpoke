/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { SectionHead } from "../../../src/web/atoms/SectionHead";
import { tokens } from "../../../src/web/tokens/tokens";

describe("SectionHead", () => {
  test("renders title with display font", () => {
    const html = String(<SectionHead title="Inbox" />);
    expect(html).toContain("Inbox");
    expect(html).toContain("Pixelify Sans");
    expect(html).toContain(tokens.color.ink);
  });

  test("renders kicker when provided", () => {
    const html = String(<SectionHead title="Title" kicker="Activity" />);
    expect(html).toContain("Activity");
    expect(html).toContain(tokens.color.ink3);
    expect(html).toContain("uppercase");
  });

  test("does not render kicker element when omitted", () => {
    const html = String(<SectionHead title="Title" />);
    // ink3 should only appear if kicker or sub — with neither it shouldn't
    expect(html).not.toContain("uppercase");
  });

  test("renders sub when provided", () => {
    const html = String(<SectionHead title="Title" sub="subtitle text" />);
    expect(html).toContain("subtitle text");
    expect(html).toContain(tokens.color.ink2);
  });
});

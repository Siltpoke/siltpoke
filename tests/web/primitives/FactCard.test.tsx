/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { FactCard } from "../../../src/web/primitives/FactCard";
import { tokens } from "../../../src/web/tokens/tokens";

describe("FactCard", () => {
  test("renders id and age in header", () => {
    const html = String(
      <FactCard id="fact-001" text="Some fact text." age="2h ago" confidence={0.9} />,
    );
    expect(html).toContain("fact-001");
    expect(html).toContain("2h ago");
  });

  test("renders text content", () => {
    const html = String(
      <FactCard id="fact-001" text="Some fact text." age="2h ago" confidence={0.9} />,
    );
    expect(html).toContain("Some fact text.");
  });

  test("high confidence uses moss color", () => {
    const html = String(
      <FactCard id="f" text="t" age="now" confidence={0.9} />,
    );
    expect(html).toContain(tokens.color.moss);
  });

  test("confidence === 0.85 boundary uses moss (>= threshold)", () => {
    // Pin the inclusive boundary: source uses `>= 0.85 ? moss : ...`.
    // A future refactor flipping to `>` would silently demote this case
    // to amber; this test catches that.
    const html = String(
      <FactCard id="f" text="t" age="now" confidence={0.85} />,
    );
    expect(html).toContain(tokens.color.moss);
    expect(html).not.toContain(tokens.color.amber);
  });

  test("mid confidence uses amber color", () => {
    const html = String(
      <FactCard id="f" text="t" age="now" confidence={0.7} />,
    );
    expect(html).toContain(tokens.color.amber);
    expect(html).not.toContain(tokens.color.moss);
  });

  test("low confidence uses terra color", () => {
    const html = String(
      <FactCard id="f" text="t" age="now" confidence={0.4} />,
    );
    // terra appears as both the confidence bar color and the default borderAccent
    expect(html).toContain(tokens.color.terra);
  });

  test("goal pill renders when goal=true", () => {
    const html = String(
      <FactCard id="f" text="t" age="now" confidence={0.8} goal />,
    );
    expect(html).toContain("goal");
  });

  test("constraint pill renders when constraint=true", () => {
    const html = String(
      <FactCard id="f" text="t" age="now" confidence={0.8} constraint />,
    );
    expect(html).toContain("constraint");
    expect(html).toContain(tokens.color.sky);
  });

  test("no pills rendered without goal or constraint", () => {
    const html = String(
      <FactCard id="f" text="t" age="now" confidence={0.8} />,
    );
    expect(html).not.toContain(">goal<");
    expect(html).not.toContain(">constraint<");
  });

  test("supersedes block renders with arrow and id", () => {
    const html = String(
      <FactCard id="f" text="t" age="now" confidence={0.9} supersedes="fact-000" />,
    );
    expect(html).toContain("↶ supersedes");
    expect(html).toContain("fact-000");
  });

  test("reason block renders when provided", () => {
    const html = String(
      <FactCard id="f" text="t" age="now" confidence={0.9} reason="Outdated after review." />,
    );
    expect(html).toContain("Outdated after review.");
  });

  test("custom borderAccent is applied", () => {
    const html = String(
      <FactCard id="f" text="t" age="now" confidence={0.9} borderAccent={tokens.color.moss} />,
    );
    expect(html).toContain(`border-left:3px solid ${tokens.color.moss}`);
  });

  test("confidence bar shows percentage width", () => {
    const html = String(
      <FactCard id="f" text="t" age="now" confidence={0.75} />,
    );
    expect(html).toContain("75%");
  });
});

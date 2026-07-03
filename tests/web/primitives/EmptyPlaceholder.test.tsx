/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { EmptyPlaceholder } from "../../../src/web/primitives/EmptyPlaceholder";
import { tokens } from "../../../src/web/tokens/tokens";

describe("EmptyPlaceholder", () => {
  test("renders headline text", () => {
    const html = String(
      <EmptyPlaceholder headline="nothing wrong rn" sub="all clear." />,
    );
    expect(html).toContain("nothing wrong rn");
  });

  test("renders sub text", () => {
    const html = String(
      <EmptyPlaceholder headline="no facts yet" sub="chat a bit to start." />,
    );
    expect(html).toContain("chat a bit to start.");
  });

  test("headline uses display font", () => {
    const html = String(
      <EmptyPlaceholder headline="headline" sub="sub" />,
    );
    // font-family is HTML-entity-escaped in SSR output
    expect(html).toContain("Pixelify Sans");
  });

  test("sub uses ink2 color and 11px size", () => {
    const html = String(
      <EmptyPlaceholder headline="h" sub="some sub text" />,
    );
    expect(html).toContain(tokens.color.ink2);
    expect(html).toContain("font-size:11");
  });

  test("art slot renders JSX when provided", () => {
    const html = String(
      <EmptyPlaceholder
        art={<pre id="creature-art">art</pre>}
        headline="h"
        sub="s"
      />,
    );
    expect(html).toContain('id="creature-art"');
    expect(html).toContain("art");
  });

  test("no art slot is omitted when not provided", () => {
    const html = String(<EmptyPlaceholder headline="h" sub="s" />);
    // The component should still render with headline + sub, no phantom element
    expect(html).toContain("h");
    expect(html).not.toContain("creature-art");
  });

  test("action slot renders when provided", () => {
    const html = String(
      <EmptyPlaceholder
        headline="h"
        sub="s"
        action={<button id="cta">run anyway</button>}
      />,
    );
    expect(html).toContain('id="cta"');
    expect(html).toContain("run anyway");
  });

  test("layout is flex column centered", () => {
    const html = String(<EmptyPlaceholder headline="h" sub="s" />);
    expect(html).toContain("flex-direction:column");
    expect(html).toContain("align-items:center");
  });
});

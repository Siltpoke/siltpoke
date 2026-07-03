/**
 * FloatingChat markup — error-card + stopped-marker branches.
 *
 * SSR-renders the panel and asserts the message template carries the three
 * presentation branches (normal bubble / failed card / cancelled marker) and
 * that error copy renders as plain text (x-text), never through renderMd.
 * Data-model behavior lives in floating-chat-error-cards.test.ts.
 */
/** @jsxImportSource hono/jsx */
import { describe, expect, test } from "bun:test";
import { FloatingChat } from "../../../src/web/_shared/FloatingChat";

describe("FloatingChat SSR — error card / stopped marker branches", () => {
  function render(): string {
    return String(<FloatingChat />);
  }

  test("message template branches on status 'failed' (escaped attr quotes)", () => {
    const html = render();
    expect(html).toContain("m.status === &#39;failed&#39;");
  });

  test("failed card carries the status glyph", () => {
    const html = render();
    expect(html).toContain("⚠");
  });

  test("message template branches on status 'cancelled'", () => {
    const html = render();
    expect(html).toContain("m.status === &#39;cancelled&#39;");
  });

  test("renderMd (x-html) is gated OFF for status entries — error copy is plain text", () => {
    const html = render();
    // The assistant markdown branch must exclude status entries…
    expect(html).toContain("m.role === &#39;assistant&#39; &amp;&amp; !m.status");
    // …and there is exactly one x-html sink in the message template (renderMd).
    const sinks = html.match(/x-html/g) ?? [];
    expect(sinks).toHaveLength(1);
  });

  test("the single transport error line is still present", () => {
    const html = render();
    expect(html).toContain('x-show="error"');
  });

  test("message scroll body is a live region (role=log, mirrors Chat.tsx)", () => {
    const html = render();
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-label="Chat messages"');
  });
});

/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { Chat } from "../../../src/web/screens/Chat";

describe("Chat screen SSR", () => {
  function render(): string {
    return String(<Chat />);
  }

  // --- Top-level structure ---

  test("chat-pane wrapper has x-data='chatStream'", () => {
    const html = render();
    // NOTE: registered as "chatStream" (camelCase) — Alpine evaluates x-data as JS
    // expressions, and hyphenated names (chat-stream) are parsed as subtraction.
    expect(html).toContain('x-data="chatStream"');
    expect(html).toContain('class="chat-pane"');
  });

  test("chat-history div is present with x-ref='history'", () => {
    const html = render();
    expect(html).toContain('class="chat-history"');
    expect(html).toContain('x-ref="history"');
  });

  test("template x-for loops over messages", () => {
    const html = render();
    expect(html).toContain("x-for");
    expect(html).toContain("messages");
  });

  test("streaming div present with x-show and x-text buffer", () => {
    const html = render();
    expect(html).toContain('class="chat-streaming"');
    expect(html).toContain("streaming");
    expect(html).toContain("buffer");
  });

  test("error div present with x-show and x-text error", () => {
    const html = render();
    expect(html).toContain('class="chat-error"');
    expect(html).toContain("error");
  });

  // --- Composer ---

  test("chat-composer form is present", () => {
    const html = render();
    expect(html).toContain('class="chat-composer"');
  });

  test("form has submit prevent handler wired to send()", () => {
    const html = render();
    expect(html).toContain("send");
    expect(html).toContain("submit");
  });

  test("textarea has x-model='input' and rows=2", () => {
    const html = render();
    expect(html).toContain('x-model="input"');
    expect(html).toContain('rows="2"');
  });

  test("Send button is present and disabled when streaming", () => {
    const html = render();
    expect(html).toContain("Send");
    expect(html).toContain("streaming");
  });

  // --- Dashboard wrapper ---

  test("Dashboard wrapper is present (AppChrome landmark)", () => {
    const html = render();
    // AppChrome 'siltpoked' top bar dropped; sidebar footer
    // now carries the daemon identity.
    expect(html).toContain("daemon");
  });

  // --- CANONICAL_NAV wiring ---

  test("no nav entry renders disabled (placeholders removed 2026-07-02)", () => {
    const html = render();
    expect(html).not.toContain('aria-disabled="true"');
  });

  test("canonical nav labels are present (Chat tab removed — floating chat replaces it)", () => {
    const html = render();
    expect(html).toContain("Home");
    expect(html).toContain("Memory");
    expect(html).toContain("Repo Graph");
  });

  test("Chat nav entry is gone (no /chat tab link in sidebar)", () => {
    const html = render();
    expect(html).not.toContain('href="/chat"');
  });

  test("Memory nav entry has correct href", () => {
    const html = render();
    expect(html).toContain('href="/memory"');
  });

  // --- Accessibility (Fix 3) ---

  test("chat-history has role=log and aria-label", () => {
    const html = render();
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-label="Chat history"');
  });

  test("chat-streaming div has aria-live=polite", () => {
    const html = render();
    expect(html).toContain('class="chat-streaming"');
    expect(html).toContain('aria-live="polite"');
  });

  test("chat-error div has aria-live=assertive", () => {
    const html = render();
    expect(html).toContain('class="chat-error"');
    expect(html).toContain('aria-live="assertive"');
  });

  // --- Placeholder (Fix 5) ---

  test("textarea placeholder is instruction-oriented, not opaque", () => {
    const html = render();
    expect(html).toContain('placeholder="Type a message"');
  });

  // --- x-for :key binding (Fix 6) ---

  test("x-for template has a key binding for Alpine reconciliation", () => {
    const html = render();
    // x-bind:key is the long-form Alpine key binding
    expect(html).toContain("x-bind:key");
  });

  // Fx-08: textarea must have an accessible name (aria-label or associated label)
  test("Fx-08: textarea has aria-label for accessible name", () => {
    const html = render();
    expect(html).toContain('aria-label="Message to send"');
  });

  // --- failed / cancelled entry branches ---

  test("message template branches on status 'failed' with a distinct card style", () => {
    const html = render();
    // hono/jsx HTML-escapes quotes inside attribute values. The visual
    // distinction lives in the x-bind:style branch (full-width stretch card),
    // not a class — no stylesheet targets a card class.
    expect(html).toContain("msg.status === &#39;failed&#39;");
    expect(html).toContain("alignSelf: &#39;stretch&#39;");
  });

  test("failed card carries a status glyph, gated on the failed branch", () => {
    const html = render();
    expect(html).toContain("⚠");
  });

  test("message template branches on status 'cancelled' with a quiet marker style", () => {
    const html = render();
    // Quiet centered marker via the x-bind:style branch (no marker class).
    expect(html).toContain("msg.status === &#39;cancelled&#39;");
    expect(html).toContain("alignSelf: &#39;center&#39;");
  });

  test("message text renders via x-text (plain text — no HTML injection path)", () => {
    const html = render();
    expect(html).toContain('x-text="msg.text"');
    expect(html).not.toContain('x-html="msg.text"');
  });

  // --- visible Stop control while streaming ---

  test("Stop button present: visible only while streaming, wired to stop()", () => {
    const html = render();
    expect(html).toContain('x-on:click="stop()"');
    // gated on the streaming flag (visible only during a turn)
    expect(html).toMatch(/x-show="streaming"[^>]*/);
    expect(html).toContain("Stop");
  });

  test("Stop button is a plain button (never submits the composer form)", () => {
    const html = render();
    const stopIdx = html.indexOf('x-on:click="stop()"');
    expect(stopIdx).toBeGreaterThan(-1);
    const around = html.slice(Math.max(0, stopIdx - 300), stopIdx + 300);
    expect(around).toContain('type="button"');
  });

  test("Send button stays disabled while streaming (Stop is the only live control)", () => {
    const html = render();
    expect(html).toContain('x-bind:disabled="streaming || !input.trim()"');
  });
});

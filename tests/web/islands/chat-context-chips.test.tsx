// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * The chip bar above the chat composer, and the agent chip in it. Markup only:
 * what the chip says is in `client/islands/chat-agent-chip.test.ts`, and that
 * it appears in a real browser is `e2e/chat-agent-chip.spec.ts`.
 */
import { describe, expect, test } from "bun:test";
import { ChatContextChips } from "../../../src/web/_shared/ChatContextChips";
import { FloatingChat } from "../../../src/web/_shared/FloatingChat";

const bar = String(<ChatContextChips />);
const chip = bar.match(/<a [^>]*data-chat-agent[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";

describe("ChatContextChips", () => {
  test("the three chips that were there are still there, in order", () => {
    const node = bar.indexOf('x-text="contextChips().node"');
    const page = bar.indexOf('x-text="contextChips().page"');
    const facts = bar.indexOf("contextChips().facts + &#39; facts&#39;");
    expect(node).toBeGreaterThan(-1);
    expect(page).toBeGreaterThan(node);
    expect(facts).toBeGreaterThan(page);
  });

  test("one agent chip, after them, its own island", () => {
    expect(bar.match(/data-chat-agent/g)?.length).toBe(1);
    expect(bar.indexOf("data-chat-agent")).toBeGreaterThan(bar.indexOf("contextChips().facts"));
    expect(chip).toContain('x-data="chatAgent"');
  });

  test("it re-reads when the panel opens and when a reply ends", () => {
    const effect = chip.match(/x-effect="([^"]*)"/)?.[1] ?? "";
    expect(effect).toContain("open");
    expect(effect).toContain("streaming");
    expect(effect).toContain("refresh()");
  });

  test("hidden until there is something to show; the text and tooltip come from the island", () => {
    expect(chip).toContain('x-show="label"');
    expect(chip).toContain('x-text="label"');
    expect(chip).toContain('x-bind:title="title"');
  });

  test("it is a link to the Settings page, where chat's agent is chosen", () => {
    expect(chip).toContain('href="/settings"');
    // The panel root switches hx-boost off; without this the click is a full
    // page load that drops the open panel and its draft.
    expect(chip).toContain('hx-boost="true"');
  });

  test("the reason is the link's accessible name; the emoji is not read out", () => {
    expect(chip).toContain('x-bind:aria-label="title"');
    expect(chip).toContain('<span aria-hidden="true">🤖</span>');
  });

  test("the panel renders the bar exactly once", () => {
    const panel = String(<FloatingChat />);
    expect(panel.match(/data-chat-agent/g)?.length).toBe(1);
    expect(panel.match(/x-text="contextChips\(\)\.page"/g)?.length).toBe(1);
  });
});

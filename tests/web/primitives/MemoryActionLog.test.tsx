/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { MemoryActionLog } from "../../../src/web/primitives/MemoryActionLog";
import { MemoryAlpineRow } from "../../../src/web/primitives/MemoryAlpineRow";

/**
 * MemoryActionLog SSR primitive — asserts template structure + Alpine directives.
 * Does NOT assert runtime state (Alpine runs in browser); tests inspect the
 * rendered HTML skeleton that the island mounts into.
 *
 * Redesigned (2026-06-26):
 *   Collapsed footer = ONLY 详情展开▾/收起▴ toggle; gate on logRows.length > 0.
 *   Expanded rail is newest→oldest; 创建 omitted.
 *   Supersede sub-rows inside expanded log (logRow.isSupersede branch).
 */
describe("MemoryActionLog", () => {
  // Render once; all assertions below share the same output.
  test("renders without error", () => {
    const h = String(<MemoryActionLog />);
    expect(h.length).toBeGreaterThan(0);
  });

  describe("collapsed footer — toggle lives in MemoryAlpineRow (why row)", () => {
    // The toggle moved OFF MemoryActionLog onto the 为什么 row in MemoryAlpineRow.
    // Assert against MemoryAlpineRow renders; also verify MemoryActionLog no longer owns it.

    test("toggle renders in MemoryAlpineRow, NOT in MemoryActionLog", () => {
      const row = String(<MemoryAlpineRow />);
      const log = String(<MemoryActionLog />);
      // Toggle present in the row (why row is its new home).
      expect(row).toContain("memory-action-log-toggle");
      // Toggle absent from MemoryActionLog — it only renders the rail now.
      expect(log).not.toContain("memory-action-log-toggle");
      expect(log).not.toContain("memory-action-log-summary");
    });

    test("collapsed state: 详情展开▾ toggle button present in MemoryAlpineRow", () => {
      const h = String(<MemoryAlpineRow />);
      // Toggle button must be present with the exact collapsed text.
      expect(h).toContain("Details ▾");
      // The OLD inline summary class is GONE.
      expect(h).not.toContain("memory-action-log-created");
      expect(h).not.toContain("memory-action-log-reaffirm");
    });

    test("toggle gate: x-show on logRows.length > 0 (not events.length)", () => {
      const h = String(<MemoryAlpineRow />);
      // Hono JSX HTML-encodes '>' as '&gt;' in attribute values.
      expect(h).toContain('x-show="event.logRows.length &gt; 0"');
      // Old gate must NOT appear.
      expect(h).not.toContain("event.events.length");
    });

    test("toggle label: x-text drives 收起▴/详情展开▾ (not static text)", () => {
      const h = String(<MemoryAlpineRow />);
      // Hono JSX HTML-encodes single quotes as &#39; in attribute values.
      expect(h).toContain("&#39;Collapse ▴&#39;");
      expect(h).toContain("&#39;Details ▾&#39;");
      // Static text node must not appear — x-text drives the label at runtime.
      expect(h).not.toContain(">Details ▾<");
    });

    test("toggle has x-on:click to flip event.expanded", () => {
      const h = String(<MemoryAlpineRow />);
      expect(h).toContain("event.expanded = !event.expanded");
    });

    test("toggle is right-aligned on the 为什么 row (marginLeft auto)", () => {
      const h = String(<MemoryAlpineRow />);
      // The why row must contain the toggle class and the marginLeft:auto style.
      expect(h).toContain("memory-action-log-toggle");
      expect(h).toContain("margin-left:auto");
    });

    test("contains 展开 affordance button text (substring check in MemoryAlpineRow)", () => {
      const h = String(<MemoryAlpineRow />);
      expect(h).toContain("Details");
    });
  });

  describe("expanded timeline rail", () => {
    test("expanded region gated by x-show='event.expanded'", () => {
      const h = String(<MemoryActionLog />);
      expect(h).toContain("event.expanded");
    });

    test("expanded region has x-for over logRows", () => {
      const h = String(<MemoryActionLog />);
      expect(h).toContain("x-for");
      expect(h).toContain("logRow in event.logRows");
    });

    test("expanded region verb/glyph: 🌱创建 (in ACTION_LABEL_EXPR, not as event row)", () => {
      const h = String(<MemoryActionLog />);
      // 🌱创建 still appears in the inline ACTION_LABEL_EXPR map
      expect(h).toContain("🌱");
      expect(h).toContain("Created");
    });

    test("expanded region verb/glyph: ✓ 生效 approved", () => {
      const h = String(<MemoryActionLog />);
      expect(h).toContain("✓ Activated");
    });

    test("expanded region verb/glyph: ○ 退休 retired", () => {
      const h = String(<MemoryActionLog />);
      expect(h).toContain("○ Retired");
    });

    test("expanded region verb/glyph: ↺ 撤回 reactivated", () => {
      const h = String(<MemoryActionLog />);
      expect(h).toContain("↺ Reactivated");
    });

    test("expanded region verb/glyph: ★ 重申 reaffirmed (inline ACTION_LABEL_EXPR)", () => {
      const h = String(<MemoryActionLog />);
      // Hono JSX HTML-encodes single quotes as &#39; in attribute values.
      // Assert the map entry is in the x-text expression.
      expect(h).toContain("reaffirmed:&#39;★ Reaffirmed&#39;");
    });

    test("row date shown as '— YYYY-MM-DD HH:mm' (x-text format with separator)", () => {
      const h = String(<MemoryActionLog />);
      // The separator expression must be in the x-text.
      expect(h).toContain("&#39; — &#39;");
    });

    test("supersede sub-row: logRow.isSupersede branch present", () => {
      const h = String(<MemoryActionLog />);
      expect(h).toContain("logRow.isSupersede");
    });

    test("supersede sub-row: jumpToFact(logRow.supersedeId) on click", () => {
      const h = String(<MemoryActionLog />);
      expect(h).toContain("jumpToFact(logRow.supersedeId)");
    });

    test("supersede sub-row: ⇄ 替代了 / ↩ 被替代 in SUPERSEDE_LABEL_EXPR", () => {
      const h = String(<MemoryActionLog />);
      expect(h).toContain("⇄ Supersedes");
      expect(h).toContain("↩ Superseded");
    });

    test("x-for key includes supersedeType for morph-safety", () => {
      const h = String(<MemoryActionLog />);
      expect(h).toContain("logRow.supersedeType");
    });
  });

  describe("accessibility", () => {
    test("toggle button has aria-expanded (dynamic via x-bind) — in MemoryAlpineRow", () => {
      // Toggle moved to MemoryAlpineRow; aria attributes travel with it.
      const h = String(<MemoryAlpineRow />);
      expect(h).toContain("aria-expanded");
    });

    test("toggle button has aria-controls linking to expanded region — in MemoryAlpineRow", () => {
      const h = String(<MemoryAlpineRow />);
      expect(h).toContain("aria-controls");
    });

    test("supersede link is a keyboard-accessible button", () => {
      const h = String(<MemoryActionLog />);
      expect(h).toContain("memory-action-log-supersede-link");
    });
  });

  describe("Alpine morph-safety", () => {
    test("toggle in MemoryAlpineRow uses x-on:click, not addEventListener", () => {
      // Toggle moved to MemoryAlpineRow why row; verify it is still morph-safe.
      const h = String(<MemoryAlpineRow />);
      expect(h).toContain("x-on:click");
      expect(h).not.toContain("addEventListener");
    });

    test("supersede link in MemoryActionLog uses x-on:click (morph-safe)", () => {
      // The supersede link is the only x-on:click left in MemoryActionLog.
      const h = String(<MemoryActionLog />);
      expect(h).toContain("x-on:click");
    });

    test("no addEventListener in MemoryActionLog rendered HTML (morph-safe check)", () => {
      const h = String(<MemoryActionLog />);
      expect(h).not.toContain("addEventListener");
    });
  });
});
